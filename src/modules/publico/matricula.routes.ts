import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { cpfValido, somenteDigitos } from "../../lib/cpf.js";
import { mesesAFrente } from "../../lib/datas.js";
import { tratadorDeErro } from "../../lib/erros.js";
import { lerConfig } from "../conteudo/conteudo.routes.js";
import {
  buscarCep,
  CepIndisponivelError,
  CepInvalidoError,
} from "../../services/cep/cep.client.js";
import { whatsappComercial } from "../../config/env.js";
import { buscarAvaliacoesGoogle } from "./avaliacoes.js";

/**
 * Matrícula pelo site — o que a família preenche.
 *
 * Não é "pré-matrícula": a matrícula é esta, e os boletos do plano são
 * lançados depois. O que falta até ela valer é a confirmação do
 * administrativo, que acontece no painel.
 *
 * Equivale ao POST /api/enrollment do sistema atual, que o site
 * se7voleidepraia.com.br chama. As diferenças não são de gosto; cada uma
 * corrige um problema daquele endpoint, que está aberto na internet:
 *
 *   1. Lá, o responsável é procurado pelo CPF e, se existir, tem nome, e-mail
 *      e telefone SOBRESCRITOS pelo que veio na requisição — sem autenticação
 *      nenhuma. Quem souber o CPF de alguém troca o e-mail dessa pessoa, e o
 *      e-mail é para onde vai a cobrança. Aqui um cadastro existente nunca é
 *      alterado por esta rota: os dados divergentes vão para a observação da
 *      matrícula, e o administrativo decide.
 *   2. Lá, o aluno e o responsável são gravados ANTES da cobrança. Se o
 *      pagamento falha, a resposta é erro mas as linhas ficam no banco. Aqui
 *      tudo acontece numa transação.
 *   3. Lá, a matrícula principal nasce PAYMENT_PENDDING e as dos irmãos
 *      nascem CREATED — o mesmo pedido em dois estados. Aqui todas nascem
 *      CRIADA, aguardando o administrativo.
 *   4. Lá, a primeira linha do controller grava o corpo inteiro no log
 *      (Log::critical('PAYLOAD_MATRICULA ...')), com CPF, e-mail e telefone
 *      em texto claro. Aqui nada de dado pessoal entra em log.
 *
 * O pagamento não acontece aqui: o boleto do plano é lançado depois. A
 * matrícula nasce CRIADA e aparece no painel para o administrativo confirmar,
 * no mesmo lugar onde as outras já são acompanhadas.
 */

const alunoSchema = z.object({
  nome: z.string({ required_error: "Informe o nome do aluno." }).min(3, "Nome muito curto.").max(160),
  nascimento: z
    .string({ required_error: "Informe a data de nascimento." })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD."),
  turmaId: z.string().uuid("Escolha a turma."),
  planoId: z.string().uuid("Escolha o plano."),
});

/**
 * Endereço do responsável financeiro.
 *
 * O sistema atual tem estas colunas em `customers` desde sempre, mas nenhuma
 * tela as preenche — e uma delas, `address_number`, foi criada NOT NULL sem
 * default numa tabela que já tinha linhas. Aqui o endereço é pedido de fato, e
 * o complemento é o único campo que pode faltar: nem todo endereço tem um.
 */
const enderecoSchema = z.object({
  cep: z
    .string({ required_error: "Informe o CEP." })
    .transform(somenteDigitos)
    .refine((v) => v.length === 8, "CEP precisa ter 8 dígitos."),
  logradouro: z.string({ required_error: "Informe a rua." }).min(3, "Informe a rua.").max(200),
  numero: z.string({ required_error: "Informe o número." }).min(1, "Informe o número.").max(20),
  complemento: z.string().max(120).optional().or(z.literal("")),
  bairro: z.string({ required_error: "Informe o bairro." }).min(2, "Informe o bairro.").max(120),
  cidade: z.string({ required_error: "Informe a cidade." }).min(2, "Informe a cidade.").max(120),
  estado: z
    .string({ required_error: "Informe o estado." })
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => /^[A-Z]{2}$/.test(v), "Estado em duas letras, como PB."),
});

const matriculaDoSiteSchema = z.object({
  aluno: alunoSchema,
  // Irmãos matriculados no mesmo pedido — o "plano família" do site.
  irmaos: z.array(alunoSchema).max(5, "Fale com o administrativo para mais de seis alunos.").default([]),

  // O aluno adulto é o próprio responsável. No sistema atual isso é o
  // `isMenor`, e decide de qual conjunto de campos o CPF é lido.
  responsavelEhOAluno: z.boolean().default(false),
  // O aceite não é enfeite de tela: é o registro de que a família viu as
  // condições do plano — vencimento, multa de cancelamento — antes de
  // contratar. Por isso é exigido aqui, no servidor, e não só no botão.
  aceitouTermos: z.literal(true, {
    errorMap: () => ({ message: "É preciso aceitar os termos para concluir a matrícula." }),
  }),
  responsavel: z.object({
    nome: z.string().max(160).optional(),
    cpf: z
      .string({ required_error: "Informe o CPF do responsável." })
      .transform(somenteDigitos)
      .refine(cpfValido, "CPF inválido."),
    email: z.string().email("E-mail inválido.").optional().or(z.literal("")),
    telefone: z.string().min(10, "Informe o telefone com DDD.").max(30),
    endereco: enderecoSchema,
  }),
});

export async function publicoRoutes(app: FastifyInstance) {
  app.setErrorHandler(
    tratadorDeErro((erro) => {
      if (erro instanceof CepInvalidoError) return { status: 400, mensagem: erro.message };
      if (erro instanceof CepIndisponivelError) return { status: 503, mensagem: erro.message };
      return undefined;
    }),
  );

  // Rota aberta na internet: um limite bem mais apertado que o do resto do
  // sistema. Não atrapalha um envio de boa-fé e corta o automatizado.
  await app.register(rateLimit, { max: 10, timeWindow: "10 minutes" });

  /**
   * Endereço a partir do CEP.
   *
   * Limite próprio, e mais folgado que o das outras rotas daqui: preencher o
   * endereço custa uma consulta por CEP, e quem erra o número tenta de novo.
   * Sem esta linha, três tentativas de CEP gastariam um terço da cota que
   * existe para conter envio automatizado de matrícula.
   *
   * Falhar aqui nunca impede a matrícula: a tela deixa os campos editáveis.
   */
  app.get(
    "/publico/cep/:cep",
    { config: { rateLimit: { max: 40, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const { cep } = z.object({ cep: z.string() }).parse(request.params);
      const endereco = await buscarCep(cep);

      if (!endereco) {
        return reply.code(404).send({ message: "CEP não encontrado. Confira o número." });
      }
      return endereco;
    },
  );

  /**
   * O catálogo que o site mostra: unidades, turmas com horário e vaga, e os
   * planos de cada turma.
   *
   * Não devolve nada de pessoa. A rota equivalente do sistema atual,
   * /api/courses/{id}/students, devolve nome e foto de aluno para qualquer um
   * — é o vazamento que o patch de segurança fecha.
   */
  // Limite próprio, generoso: sem ele, esta rota herdava os 10/10min pensados
  // pra frear envio automatizado de matrícula. Ela não recebe nada de
  // ninguém — é leitura pura, agora chamada duas vezes por visita na página
  // de entrada (esta rota e /publico/galeria) — e o limite apertado bloquearia
  // visitantes de boa-fé numa escola movimentada, no mesmo Wi-Fi.
  const leituraPublica = { config: { rateLimit: { max: 120, timeWindow: "10 minutes" } } };

  app.get("/publico/catalogo", leituraPublica, async () => {
    const config = await lerConfig();

    const unidades = await prisma.unidade.findMany({
      where: { ativa: true },
      orderBy: { nome: "asc" },
      include: {
        turmas: {
          where: { ativa: true, aceitaNovasMatriculas: true },
          orderBy: { nome: "asc" },
          include: {
            horarios: { orderBy: { inicio: "asc" } },
            planos: {
              include: {
                plano: {
                  select: {
                    id: true, nome: true, valor: true, parcelas: true, ativo: true,
                    // A descrição é o contrato em miniatura: vencimento, formas
                    // de pagamento, desconto, duração e multa. É o que a
                    // família lê antes de escolher, e no sistema atual ela já
                    // aparece assim no site.
                    descricao: true,
                    descontoPercentual: true,
                  },
                },
              },
            },
            _count: {
              select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } } },
            },
          },
        },
      },
    });

    const ofertas = unidades
      .map((u) => ({
        id: u.id,
        nome: u.nome,
        endereco: u.endereco,
        turmas: u.turmas
          .map((t) => {
            const vagas = t.capacidade === null ? null : t.capacidade - t._count.matriculas;
            return {
              id: t.id,
              nome: t.nome,
              categoria: t.categoria,
              horarios: t.horarios.map((h) => ({ dia: h.dia, inicio: h.inicio, fim: h.fim })),
              vagas,
              planos: t.planos
                .filter((p) => p.plano.ativo)
                .map((p) => ({
                  id: p.plano.id,
                  nome: p.plano.nome,
                  valor: p.plano.valor,
                  parcelas: p.plano.parcelas,
                  descricao: p.plano.descricao,
                  desconto: p.plano.descontoPercentual,
                })),
            };
          })
          // Turma cheia ou sem plano não entra: oferecer no site o que não dá
          // para contratar gera uma conversa de decepção com o administrativo.
          .filter((t) => t.planos.length > 0 && (t.vagas === null || t.vagas > 0)),
      }))
      .filter((u) => u.turmas.length > 0);

    return {
      unidades: ofertas,
      // As categorias que existem de verdade na oferta — é o segundo filtro
      // da tela, ao lado da unidade.
      categorias: [
        ...new Set(ofertas.flatMap((u) => u.turmas.map((t) => t.categoria)).filter(Boolean)),
      ].sort(),
      taxaMatricula: config.taxaMatricula,
      linkTermos: config.linkTermos,
      // Vazio quando WHATSAPP_COMERCIAL não está configurada — a página de
      // entrada esconde o botão em vez de mostrar um link quebrado.
      whatsapp: whatsappComercial,
    };
  });

  /**
   * As fotos da página de entrada, na ordem em que devem aparecer.
   *
   * Só as ativas — desativar uma foto aqui é o "excluir" da tela pública sem
   * perder o registro, mesma regra do resto do sistema (ver Colaboradores,
   * Unidades, Planos).
   */
  app.get("/publico/galeria", leituraPublica, async () =>
    prisma.galeriaFoto.findMany({
      where: { ativa: true },
      orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }],
      select: { id: true, imagemBase64: true, legenda: true, linkInstagram: true },
    }));

  /**
   * Os últimos posts do Instagram de verdade, do cache que o job diário
   * mantém (ver src/modules/publico/instagram.ts) — esta rota nunca fala com
   * o Instagram direto. Lista vazia quando a integração não está configurada
   * ou ainda não trouxe nada; a página de entrada cai para /publico/galeria
   * nesse caso.
   */
  app.get("/publico/instagram", leituraPublica, async () =>
    prisma.instagramPost.findMany({
      orderBy: { publicadoEm: "desc" },
      select: { id: true, imagemUrl: true, legenda: true, permalink: true },
    }));

  /**
   * As avaliações do Google Maps da escola, se a integração estiver
   * configurada (GOOGLE_PLACES_API_KEY + Place ID nas configurações). Sem
   * ela, `configurado: false` — a página de entrada mostra os depoimentos
   * fixos em vez de esconder a seção inteira.
   */
  app.get("/publico/avaliacoes", leituraPublica, async () => buscarAvaliacoesGoogle());

  /**
   * As imagens de conteúdo fixo da página de entrada — carrossel, "Sobre
   * nós", horários e valores (ver PaginaImagem no schema). Cada seção some
   * sozinha na página quando não há imagem ativa pra ela: nenhuma delas é
   * obrigatória.
   */
  app.get("/publico/imagens", leituraPublica, async () => {
    const imagens = await prisma.paginaImagem.findMany({
      where: { ativa: true },
      orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }],
      select: { slot: true, imagemBase64: true, legenda: true },
    });

    const porSlot = (slot: string) => imagens.filter((i) => i.slot === slot);
    const primeira = (slot: string) => porSlot(slot)[0] ?? null;

    return {
      carrossel: porSlot("CARROSSEL").map((i) => ({ imagemBase64: i.imagemBase64, legenda: i.legenda })),
      sobreNos: primeira("SOBRE_NOS"),
      horarios: primeira("HORARIOS"),
      valores: primeira("VALORES"),
    };
  });

  /**
   * Todas as unidades ativas, com foto — independente de terem turma com
   * vaga aberta agora. É o que a seção "Unidades" da página de entrada
   * mostra: uma vitrine da escola, não o funil de matrícula (esse é o
   * `unidades` dentro de /publico/catalogo, que só lista quem tem turma e
   * plano disponíveis). Uma unidade sem oferta no momento continua sendo uma
   * unidade real, com endereço e mapa — não deveria sumir da página só
   * porque as turmas da vez estão cheias.
   */
  app.get("/publico/unidades", leituraPublica, async () =>
    prisma.unidade.findMany({
      where: { ativa: true },
      orderBy: { nome: "asc" },
      select: { id: true, nome: true, endereco: true, fotoBase64: true },
    }));

  app.post("/publico/matricula", async (request, reply) => {
    const corpo = matriculaDoSiteSchema.parse(request.body);

    const nomeDoResponsavel = corpo.responsavelEhOAluno
      ? corpo.aluno.nome
      : (corpo.responsavel.nome ?? "").trim();

    if (!nomeDoResponsavel) {
      return reply.code(400).send({ message: "Informe o nome do responsável." });
    }

    const pedidos = [corpo.aluno, ...corpo.irmaos];

    const turmas = await prisma.turma.findMany({
      where: { id: { in: pedidos.map((p) => p.turmaId) }, ativa: true, aceitaNovasMatriculas: true },
      include: {
        planos: { select: { planoId: true } },
        _count: {
          select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } } },
        },
      },
    });

    // Cada pedido é conferido contra a turma de verdade: o corpo vem do
    // navegador da família e não é fonte de nada.
    for (const pedido of pedidos) {
      const turma = turmas.find((t) => t.id === pedido.turmaId);
      if (!turma) {
        return reply.code(400).send({ message: "Turma indisponível. Recarregue a página." });
      }
      if (!turma.planos.some((p) => p.planoId === pedido.planoId)) {
        return reply.code(400).send({ message: `O plano escolhido não vale para a turma ${turma.nome}.` });
      }
      if (turma.capacidade !== null && turma._count.matriculas >= turma.capacidade) {
        return reply.code(409).send({
          message: `A turma ${turma.nome} encheu enquanto você preenchia. Escolha outra.`,
        });
      }
    }

    const planos = await prisma.plano.findMany({
      where: { id: { in: pedidos.map((p) => p.planoId) }, ativo: true },
    });

    const existente = await prisma.responsavel.findUnique({ where: { cpf: corpo.responsavel.cpf } });

    // Divergência entre o que foi digitado e o que já está no cadastro. NÃO
    // sobrescrevemos: vira recado para o administrativo conferir com a família.
    const divergencias: string[] = [];
    if (existente) {
      const comparar = (rotulo: string, novo: string | null | undefined, atual: string | null) => {
        const a = (novo ?? "").trim();
        const b = (atual ?? "").trim();
        if (a && b && a.toLowerCase() !== b.toLowerCase()) {
          divergencias.push(`${rotulo} informado no site: "${a}" (cadastro: "${b}").`);
        }
      };
      comparar("Nome", nomeDoResponsavel, existente.nome);
      comparar("E-mail", corpo.responsavel.email, existente.email);
      comparar("Telefone", corpo.responsavel.telefone, existente.telefone);

      // O endereço segue a mesma regra do resto: quem já está no cadastro não
      // é alterado por esta rota. Vale inclusive quando o cadastro veio do
      // Laravel sem endereço nenhum — preencher um campo vazio parece
      // inofensivo, mas é o mesmo caminho de quem só sabe o CPF de alguém, e é
      // no endereço que o boleto impresso chega. O administrativo aplica.
      const enderecoAtual = [
        existente.cep, existente.logradouro, existente.numero,
        existente.bairro, existente.cidade, existente.estado,
      ].some((v) => (v ?? "").trim() !== "");

      const e = corpo.responsavel.endereco;
      const informado = [
        e.logradouro, e.numero, e.complemento, e.bairro, e.cidade, e.estado,
      ].filter(Boolean).join(", ");

      divergencias.push(
        enderecoAtual
          ? `Endereço informado no site: ${informado} (CEP ${e.cep}). O cadastro já tem endereço e NÃO foi alterado.`
          : `Endereço informado no site: ${informado} (CEP ${e.cep}). O cadastro está sem endereço; confira e aplique.`,
      );
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const responsavel =
        existente ??
        (await tx.responsavel.create({
          data: {
            nome: nomeDoResponsavel,
            cpf: corpo.responsavel.cpf,
            email: corpo.responsavel.email || null,
            telefone: corpo.responsavel.telefone,
            cep: corpo.responsavel.endereco.cep,
            logradouro: corpo.responsavel.endereco.logradouro,
            numero: corpo.responsavel.endereco.numero,
            complemento: corpo.responsavel.endereco.complemento || null,
            bairro: corpo.responsavel.endereco.bairro,
            cidade: corpo.responsavel.endereco.cidade,
            estado: corpo.responsavel.endereco.estado,
          },
        }));

      const criadas = [];
      for (const [indice, pedido] of pedidos.entries()) {
        const turma = turmas.find((t) => t.id === pedido.turmaId)!;
        const plano = planos.find((p) => p.id === pedido.planoId);
        if (!plano) throw new Error("Plano indisponível. Recarregue a página.");

        const aluno = await tx.aluno.create({
          data: {
            nome: pedido.nome.trim(),
            nascimento: new Date(`${pedido.nascimento}T00:00:00.000Z`),
            responsavelId: responsavel.id,
          },
        });

        criadas.push(
          await tx.matricula.create({
            data: {
              alunoId: aluno.id,
              responsavelId: responsavel.id,
              turmaId: turma.id,
              unidadeId: turma.unidadeId,
              planoId: plano.id,
              status: StatusMatricula.CRIADA,
              // A primeira do pedido é a principal; os irmãos acompanham.
              principal: indice === 0,
              expiraEm: mesesAFrente(plano.parcelas),
              observacao: [
                `Matrícula feita pelo site, com aceite dos termos em ${new Date().toLocaleDateString("pt-BR")}.`,
                ...(existente ? ["Responsável já cadastrado; os dados do site NÃO foram aplicados."] : []),
                ...divergencias,
              ].join(" "),
            },
            include: {
              aluno: { select: { nome: true } },
              turma: { select: { nome: true, link: true } },
              unidade: { select: { nome: true } },
              plano: { select: { nome: true, valor: true, parcelas: true } },
            },
          }),
        );
      }

      return criadas;
    });

    // Nada de dado pessoal no log: só o suficiente para saber que entrou.
    request.log.info(
      { matriculas: resultado.length, unidade: resultado[0].unidade.nome },
      "matrícula recebida pelo site",
    );

    return reply.code(201).send({
      mensagem: "Matrícula registrada!",
      // O grupo de WhatsApp da turma, quando ela tem um. É o campo `link` da
      // turma, o mesmo que o sistema atual devolve como whatsapp_link.
      grupos: resultado
        .filter((m) => m.turma.link)
        .map((m) => ({ turma: m.turma.nome, link: m.turma.link })),
      matriculas: resultado.map((m) => ({
        aluno: m.aluno.nome,
        turma: m.turma.nome,
        unidade: m.unidade.nome,
        plano: m.plano.nome,
        valor: m.plano.valor,
        parcelas: m.plano.parcelas,
      })),
    });
  });
}
