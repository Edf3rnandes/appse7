import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusMatricula, StatusOcorrencia, TipoEvento } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { hoje, primeiroDiaDoMes, segundaDaSemana } from "../../lib/datas.js";
import { tratadorDeErro } from "../../lib/erros.js";
import {
  CronogramaIndisponivelError,
  apagarSemana,
  listarSemanas,
  obterPublicadasComArte,
  obterSemanaPorId,
  salvarSemana,
} from "../../db/compartilhado/cronograma.repository.js";
import {
  conectarInstagram,
  desconectarInstagram,
  sincronizarInstagram,
  statusIntegracaoInstagram,
} from "../publico/instagram.js";

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

// A arte da semana chega como data URL. O navegador já reduz e recomprime
// antes de enviar; o limite aqui é a última barreira, para uma foto de celular
// crua não virar uma linha de 8 MB no Postgres.
const LIMITE_IMAGEM = 2_000_000;

const imagemDataUrl = z
  .string()
  .refine((v) => /^data:image\/(jpeg|png|webp);base64,/.test(v), "Formato de imagem não aceito.")
  .refine((v) => v.length <= LIMITE_IMAGEM, "A imagem ficou grande demais. Use uma menor.");

const STATUS = ["planejado", "pronto", "publicado"] as const;

const cronogramaSchema = z.object({
  semana: dataIso,
  tema: z.string().max(200).optional(),
  fundamentos: z.string().max(2000).optional(),
  exerciciosSugeridos: z.string().max(4000).optional(),
  observacoes: z.string().max(2000).optional(),
  postagensPlanejadas: z.string().max(2000).optional(),
  textoDivulgacao: z.string().max(4000).optional(),
  // null apaga a arte; ausente mantém a que já está lá.
  imagemBase64: imagemDataUrl.nullable().optional(),
  imagemNome: z.string().max(200).nullable().optional(),
  status: z.enum(STATUS).default("planejado"),
});

const eventoSchema = z.object({
  // required_error além do min(): campo ausente devolveria o "Required" cru do
  // Zod, e é essa mensagem que o administrativo lê na tela.
  titulo: z
    .string({ required_error: "Título é obrigatório." })
    .min(1, "Título é obrigatório.")
    .max(200),
  descricao: z.string().max(2000).optional(),
  tipo: z.nativeEnum(TipoEvento).default(TipoEvento.OUTRO),
  data: dataIso,
  dataFim: dataIso.optional(),
  horario: z.string().max(60).optional(),
  local: z.string().max(200).optional(),
  unidadeIdLegacy: z.number().int().positive().optional(),
  unidadeNome: z.string().max(120).optional(),
  publicado: z.boolean().default(false),
});

const idParams = z.object({ id: z.string().uuid() });

// Mesma imagem-como-data-URL do cronograma (ver imagemDataUrl acima) — mesmo
// motivo: poucas fotos, não justifica um bucket de storage à parte.
const galeriaSchema = z.object({
  imagemBase64: imagemDataUrl,
  imagemNome: z.string().max(200).optional(),
  legenda: z.string().max(300).optional(),
  linkInstagram: z
    .union([z.string().url("Link inválido.").max(500), z.literal("")])
    .optional(),
  ordem: z.number().int().default(0),
  ativa: z.boolean().default(true),
});

const SLOTS_PAGINA = ["CARROSSEL", "SOBRE_NOS", "HORARIOS", "VALORES"] as const;

const paginaImagemSchema = z.object({
  slot: z.enum(SLOTS_PAGINA),
  imagemBase64: imagemDataUrl,
  legenda: z.string().max(300).optional(),
  ordem: z.number().int().default(0),
  ativa: z.boolean().default(true),
});

// Token de acesso de vida longa da Graph API — expira em ~60 dias, mas se
// renova sozinho (ver src/modules/publico/instagram.ts) sem exigir que
// alguém volte aqui, contanto que o job diário rode antes do vencimento.
const instagramConfigSchema = z.object({
  contaId: z.string().trim().min(1, "Informe o ID da conta do Instagram."),
  accessToken: z.string().trim().min(1, "Informe o token de acesso."),
});

// Chaves permitidas, uma a uma. Uma tabela chave/valor sem lista fechada vira
// depósito de qualquer coisa que o cliente resolva mandar.
const CHAVE_CANVA = "cronograma.linkCanva";
const CHAVE_TAXA = "matricula.taxa";
const CHAVE_TERMOS = "matricula.linkTermos";

// A chave que decide se o Hub pode EMITIR cobrança no Asaas. Desligada por
// padrão, e de propósito: enquanto o Laravel continuar no ar, dois emissores
// na mesma conta geram duas cobranças para o mesmo pai. Ela vira "sim" no dia
// da virada, e só o ADMIN pode virá-la — ver a rota mais abaixo.
const CHAVE_EMISSAO = "asaas.emissaoAtiva";

// Dia de vencimento das mensalidades. As condições de todos os planos dizem
// "DATA DE VENCIMENTO: Dia 10", mas isso é decisão comercial e muda sem
// aviso, então mora aqui e não no código.
const CHAVE_VENCIMENTO = "cobranca.diaVencimento";

// O Place ID do Google Meu Negócio da escola — não é segredo (aparece na
// própria URL do Google Maps do local), por isso mora aqui, junto do resto
// da configuração de conteúdo, e não junto do token do Instagram.
const CHAVE_GOOGLE_PLACE_ID = "google.placeId";

const configSchema = z.object({
  // String vazia apaga o link — é como o administrativo "remove" o documento.
  linkCanva: z.union([z.string().url("Link do Canva inválido.").max(500), z.literal("")]).optional(),
  // Taxa de matrícula: um valor da escola, cobrado uma vez, separado da
  // mensalidade do plano. No sistema atual ele mora no arquivo de
  // configuração (plan_enrollment_base_amount), então mudar de R$ 25 para
  // R$ 30 exige um deploy. Aqui o administrativo muda pela tela.
  taxaMatricula: z.number().min(0).max(10000).optional(),
  linkTermos: z.union([z.string().url("Link dos termos inválido.").max(500), z.literal("")]).optional(),
  diaVencimento: z.number().int().min(1).max(28).optional(),
  googlePlaceId: z.string().trim().max(200).optional(),
});

/**
 * Quem alimenta o que o professor lê: cronograma das semanas e eventos do mês.
 * Só administrativo e admin escrevem — o professor tem só as rotas de leitura em
 * /professor/*.
 */
export async function conteudoRoutes(app: FastifyInstance) {
  const somenteEquipe = { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] };

  app.setErrorHandler(
    tratadorDeErro((erro) =>
      // O cronograma vive numa tabela do se7-inadimplencia. Se o Hub estiver
      // apontando para outro banco, a tela precisa dizer isso.
      erro instanceof CronogramaIndisponivelError
        ? { status: 503, mensagem: erro.message }
        : undefined,
    ),
  );

  // ------------------------------------------------------- painel
  //
  // A primeira tela de quem abre o sistema. Antes dela o administrativo caía num
  // formulário em branco de cronograma: tudo que o sistema sabe existia, mas
  // só para quem soubesse em qual aba clicar.
  //
  // Duas metades, de propósito:
  //
  //   - O que pede ação de alguém (ocorrências, semana não publicada) vem
  //     primeiro.
  //   - Os números da escola vêm das tabelas do próprio Hub. Antes eram lidos
  //     do MySQL do Laravel; desde que o domínio foi reconstruído aqui, a
  //     escola é deste banco e a tela não depende mais de credencial nenhuma.
  app.get("/conteudo/painel", somenteEquipe, async () => {
    const agora = hoje();
    const segunda = segundaDaSemana(agora);
    const mes = agora.getUTCMonth() + 1;
    const inicioDoMes = primeiroDiaDoMes(agora.getUTCFullYear(), mes);
    // Mês 13 vira janeiro do ano seguinte sozinho — o Date faz a virada, e
    // escrever o caso de dezembro à mão só criaria uma chance a mais de errar.
    const inicioDoProximoMes = primeiroDiaDoMes(agora.getUTCFullYear(), mes + 1);

    const [ocorrenciasAbertas, ocorrenciasRecentes, eventos, semanaAtual, escola] =
      await Promise.all([
        prisma.ocorrencia.count({ where: { status: StatusOcorrencia.ABERTA } }),
        prisma.ocorrencia.findMany({
          where: { status: StatusOcorrencia.ABERTA },
          orderBy: { criadoEm: "asc" },
          take: 5,
        }),
        prisma.evento.findMany({
          where: { data: { gte: agora }, publicado: true },
          orderBy: { data: "asc" },
          take: 5,
        }),
        // Só a semana corrente, e só se publicada: é exatamente o que o
        // professor está vendo no app dele neste momento.
        obterPublicadasComArte([segunda])
          .then((linhas) => (linhas[0] ? { semana: linhas[0].semana, tema: linhas[0].tema } : null))
          .catch(() => null),
        numerosDaEscola(inicioDoMes, inicioDoProximoMes),
      ]);

    return {
      hub: {
        ocorrenciasAbertas,
        ocorrenciasRecentes,
        eventos,
        semanaAtual,
        semanaDeReferencia: segunda,
      },
      escola,
    };
  });

  // ------------------------------------------------------- configuração
  //
  // O link do Canva é UM documento que rege todas as semanas, não um por
  // semana — por isso mora aqui, e não em cada linha do cronograma.
  app.get("/conteudo/config", somenteEquipe, async () => lerConfig());

  app.put("/conteudo/config", somenteEquipe, async (request) => {
    const corpo = configSchema.parse(request.body);

    const gravar = async (chave: string, valor: string | undefined) => {
      if (valor === undefined) return;
      // String vazia apaga a chave — é como a tela "remove" um valor.
      if (valor === "") {
        await prisma.configuracao.deleteMany({ where: { chave } });
        return;
      }
      await prisma.configuracao.upsert({
        where: { chave },
        create: { chave, valor },
        update: { valor },
      });
    };

    await gravar(CHAVE_CANVA, corpo.linkCanva);
    await gravar(CHAVE_TERMOS, corpo.linkTermos);
    await gravar(
      CHAVE_VENCIMENTO,
      corpo.diaVencimento === undefined ? undefined : String(corpo.diaVencimento),
    );
    await gravar(
      CHAVE_TAXA,
      corpo.taxaMatricula === undefined ? undefined : String(corpo.taxaMatricula),
    );
    await gravar(CHAVE_GOOGLE_PLACE_ID, corpo.googlePlaceId);

    return lerConfig();
  });

  /**
   * Liga e desliga a emissão de cobrança no Asaas.
   *
   * Rota própria e só para ADMIN, separada do resto das configurações. Não é
   * zelo excessivo: virar esta chave faz o sistema começar a criar cobrança
   * de verdade na conta da escola, e enquanto o Laravel estiver no ar isso
   * significa dois sistemas cobrando o mesmo pai. É uma decisão de quem
   * responde pela escola, não de quem está no balcão.
   */
  app.put(
    "/conteudo/config/emissao",
    { preHandler: [app.exigirPapel("ADMIN")] },
    async (request) => {
      const { ativa } = z.object({ ativa: z.boolean() }).parse(request.body);

      await prisma.configuracao.upsert({
        where: { chave: CHAVE_EMISSAO },
        create: { chave: CHAVE_EMISSAO, valor: String(ativa) },
        update: { valor: String(ativa) },
      });

      request.log.warn(
        { ativa, por: request.user.email },
        "emissão de cobrança no Asaas alterada",
      );

      return lerConfig();
    },
  );

  // ------------------------------------------------------- cronograma
  app.get("/conteudo/cronograma", somenteEquipe, async (request) => {
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(60).default(20) })
      .parse(request.query);

    return listarSemanas(limite);
  });

  // A semana completa, com a arte — é o que a tela de edição carrega.
  app.get("/conteudo/cronograma/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const semana = await obterSemanaPorId(id);
    if (!semana) return reply.code(404).send({ message: "Semana não encontrada." });
    return semana;
  });

  // Upsert pela semana: a segunda-feira é a chave natural, então salvar duas
  // vezes a mesma semana corrige em vez de duplicar.
  app.put(
    "/conteudo/cronograma",
    // O padrão do Fastify é 1 MB e não caberia a arte da semana. O limite maior
    // vale só para esta rota, não para o app inteiro.
    { ...somenteEquipe, bodyLimit: 6_000_000 },
    async (request, reply) => {
      const corpo = cronogramaSchema.parse(request.body);

      // Normaliza para a segunda-feira: se vier uma quarta, a semana é a mesma,
      // e sem isso viraria uma segunda linha para o mesmo período.
      const semana = segundaDaSemana(corpo.semana);

      const dados = {
        tema: corpo.tema ?? null,
        fundamentos: corpo.fundamentos ?? null,
        exerciciosSugeridos: corpo.exerciciosSugeridos ?? null,
        observacoes: corpo.observacoes ?? null,
        postagensPlanejadas: corpo.postagensPlanejadas ?? null,
        textoDivulgacao: corpo.textoDivulgacao ?? null,
        // Preservado como está: a coluna pertence à tabela do se7-inadimplencia
        // e pode ter valor por semana gravado por lá. O Hub não escreve mais
        // nela — o link agora é único, em hub.configuracoes.
        linkCanva: undefined,
        status: corpo.status,
        // `undefined` preserva a arte que já está gravada; `null` apaga.
        ...(corpo.imagemBase64 === undefined
          ? {}
          : { imagemBase64: corpo.imagemBase64, imagemNome: corpo.imagemNome ?? null }),
      };


      return reply.code(200).send(await salvarSemana(semana, dados));
    },
  );

  app.delete("/conteudo/cronograma/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await apagarSemana(id);
    return reply.code(204).send();
  });

  // ------------------------------------------------------- ocorrências
  app.get("/conteudo/ocorrencias", somenteEquipe, async (request) => {
    const { status } = z
      .object({ status: z.nativeEnum(StatusOcorrencia).optional() })
      .parse(request.query);

    return prisma.ocorrencia.findMany({
      where: status ? { status } : undefined,
      // Abertas primeiro, e as mais antigas no topo dentro delas: o que está
      // esperando há mais tempo é o que precisa de resposta.
      orderBy: [{ status: "asc" }, { criadoEm: "asc" }],
      take: 200,
    });
  });

  app.patch("/conteudo/ocorrencias/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { status, resposta } = z
      .object({
        status: z.nativeEnum(StatusOcorrencia),
        resposta: z.string().max(2000).optional(),
      })
      .parse(request.body);

    const existe = await prisma.ocorrencia.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Ocorrência não encontrada." });

    return prisma.ocorrencia.update({
      where: { id },
      data: {
        status,
        resposta: resposta ?? null,
        // Reabrir limpa o carimbo: senão a tela mostraria "resolvida em" numa
        // ocorrência que voltou a estar aberta.
        resolvidoPorId: status === StatusOcorrencia.RESOLVIDA ? request.user.sub : null,
        resolvidoEm: status === StatusOcorrencia.RESOLVIDA ? new Date() : null,
      },
    });
  });

  // ------------------------------------------------------- eventos
  app.get("/conteudo/eventos", somenteEquipe, async (request) => {
    const { desde } = z.object({ desde: dataIso.optional() }).parse(request.query);

    return prisma.evento.findMany({
      where: desde ? { data: { gte: desde } } : undefined,
      orderBy: { data: "asc" },
      take: 200,
    });
  });

  app.post("/conteudo/eventos", somenteEquipe, async (request, reply) => {
    const corpo = eventoSchema.parse(request.body);

    if (corpo.dataFim && corpo.dataFim < corpo.data) {
      return reply.code(400).send({ message: "A data final não pode ser antes da inicial." });
    }

    const evento = await prisma.evento.create({ data: montarEvento(corpo) });
    return reply.code(201).send(evento);
  });

  app.put("/conteudo/eventos/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const corpo = eventoSchema.parse(request.body);

    if (corpo.dataFim && corpo.dataFim < corpo.data) {
      return reply.code(400).send({ message: "A data final não pode ser antes da inicial." });
    }

    const existe = await prisma.evento.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Evento não encontrado." });

    return prisma.evento.update({ where: { id }, data: montarEvento(corpo) });
  });

  app.delete("/conteudo/eventos/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.evento.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ------------------------------------------------------ galeria da entrada
  //
  // A "seção Instagram" da página pública, sem depender da API do Instagram —
  // ver o cabeçalho de GaleriaFoto no schema. Lista TODAS (inclusive as
  // desativadas), porque quem edita precisa ver o que tirou do ar para poder
  // devolver.
  app.get("/conteudo/galeria", somenteEquipe, async () =>
    prisma.galeriaFoto.findMany({ orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }] }));

  app.post(
    "/conteudo/galeria",
    { ...somenteEquipe, bodyLimit: 6_000_000 },
    async (request, reply) => {
      const corpo = galeriaSchema.parse(request.body);
      const foto = await prisma.galeriaFoto.create({ data: montarGaleriaFoto(corpo) });
      return reply.code(201).send(foto);
    },
  );

  app.put(
    "/conteudo/galeria/:id",
    { ...somenteEquipe, bodyLimit: 6_000_000 },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const corpo = galeriaSchema.partial({ imagemBase64: true }).parse(request.body);

      const existe = await prisma.galeriaFoto.findUnique({ where: { id } });
      if (!existe) return reply.code(404).send({ message: "Foto não encontrada." });

      return prisma.galeriaFoto.update({
        where: { id },
        // imagemBase64 ausente mantém a foto atual — trocar legenda ou ordem
        // não deveria obrigar a reenviar a imagem inteira.
        data: montarGaleriaFoto(corpo, existe.imagemBase64),
      });
    },
  );

  app.delete("/conteudo/galeria/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.galeriaFoto.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // -------------------------------------------------- imagens da entrada
  //
  // Carrossel do topo, foto de "Sobre nós", e os cartazes de horários e
  // valores — ver o cabeçalho de PaginaImagem no schema. `?slot=` filtra;
  // sem ele, devolve tudo (a tela de administração pinta as quatro seções
  // de uma vez só).
  app.get("/conteudo/imagens", somenteEquipe, async (request) => {
    const { slot } = z.object({ slot: z.enum(SLOTS_PAGINA).optional() }).parse(request.query);
    return prisma.paginaImagem.findMany({
      where: slot ? { slot } : undefined,
      orderBy: [{ slot: "asc" }, { ordem: "asc" }, { criadoEm: "asc" }],
    });
  });

  app.post(
    "/conteudo/imagens",
    { ...somenteEquipe, bodyLimit: 6_000_000 },
    async (request, reply) => {
      const corpo = paginaImagemSchema.parse(request.body);
      const imagem = await prisma.paginaImagem.create({ data: montarPaginaImagem(corpo) });
      return reply.code(201).send(imagem);
    },
  );

  app.put(
    "/conteudo/imagens/:id",
    { ...somenteEquipe, bodyLimit: 6_000_000 },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const corpo = paginaImagemSchema.partial({ imagemBase64: true }).parse(request.body);

      const existe = await prisma.paginaImagem.findUnique({ where: { id } });
      if (!existe) return reply.code(404).send({ message: "Imagem não encontrada." });

      return prisma.paginaImagem.update({
        where: { id },
        data: montarPaginaImagem({ ...corpo, slot: corpo.slot ?? existe.slot }, existe.imagemBase64),
      });
    },
  );

  app.delete("/conteudo/imagens/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.paginaImagem.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // --------------------------------------------------- integração Instagram
  //
  // Ver o cabeçalho de src/modules/publico/instagram.ts: o token nunca volta
  // pra tela, nem no GET — só o que basta pra mostrar o estado da conexão.
  app.get("/conteudo/config/instagram", somenteEquipe, async () => statusIntegracaoInstagram());

  app.put("/conteudo/config/instagram", somenteEquipe, async (request, reply) => {
    const { contaId, accessToken } = instagramConfigSchema.parse(request.body);
    const resultado = await conectarInstagram(contaId, accessToken);
    if (!resultado.sincronizado) {
      // Não deixa meio conectado: se o primeiro teste já falha, o conta
      // ID/token errados não deveriam ficar gravados como se fosse uma
      // conexão que funcionou um dia e só parou depois (esse caso, sim,
      // fica registrado — é o job diário, não esta rota).
      await desconectarInstagram();
      return reply.code(400).send({
        message: "Não consegui buscar os posts com esses dados. Confira o ID da conta e o token.",
      });
    }
    return statusIntegracaoInstagram();
  });

  app.delete("/conteudo/config/instagram", somenteEquipe, async () => {
    await desconectarInstagram();
    return statusIntegracaoInstagram();
  });

  // Força uma sincronização fora do horário do job diário — útil pra
  // conferir na hora que a conexão continua funcionando, sem esperar o dia
  // seguinte.
  app.post("/conteudo/config/instagram/sincronizar", somenteEquipe, async () => {
    await sincronizarInstagram();
    return statusIntegracaoInstagram();
  });
}

function montarEvento(corpo: z.infer<typeof eventoSchema>) {
  return {
    titulo: corpo.titulo,
    descricao: corpo.descricao ?? null,
    tipo: corpo.tipo,
    data: corpo.data,
    dataFim: corpo.dataFim ?? null,
    horario: corpo.horario ?? null,
    local: corpo.local ?? null,
    unidadeIdLegacy: corpo.unidadeIdLegacy ?? null,
    unidadeNome: corpo.unidadeNome ?? null,
    publicado: corpo.publicado,
  };
}

/** `imagemAtual` só é usada quando o pedido não trouxe uma imagem nova. */
function montarGaleriaFoto(corpo: Partial<z.infer<typeof galeriaSchema>>, imagemAtual?: string) {
  const imagem = corpo.imagemBase64 ?? imagemAtual;
  if (!imagem) throw new Error("Faltou a imagem.");
  return {
    imagemBase64: imagem,
    imagemNome: corpo.imagemNome ?? null,
    legenda: corpo.legenda ?? null,
    linkInstagram: corpo.linkInstagram || null,
    ordem: corpo.ordem ?? 0,
    ativa: corpo.ativa ?? true,
  };
}

function montarPaginaImagem(
  corpo: Partial<z.infer<typeof paginaImagemSchema>> & { slot: z.infer<typeof paginaImagemSchema>["slot"] },
  imagemAtual?: string,
) {
  const imagem = corpo.imagemBase64 ?? imagemAtual;
  if (!imagem) throw new Error("Faltou a imagem.");
  return {
    slot: corpo.slot,
    imagemBase64: imagem,
    legenda: corpo.legenda ?? null,
    ordem: corpo.ordem ?? 0,
    ativa: corpo.ativa ?? true,
  };
}

/**
 * Os números da escola, das tabelas do Hub.
 *
 * São os mesmos cinco do topo do painel antigo do Laravel — de propósito: se a
 * escola for contada de um jeito aqui e de outro lá, ninguém confia em
 * nenhuma das duas telas durante a virada.
 */
async function numerosDaEscola(inicioDoMes: Date, inicioDoProximoMes: Date) {
  const [matriculasNoMes, alunos, turmas, planos, professores, matriculas] = await Promise.all([
    prisma.matricula.count({
      where: { arquivadoEm: null, criadoEm: { gte: inicioDoMes, lt: inicioDoProximoMes } },
    }),
    prisma.aluno.count({ where: { arquivadoEm: null } }),
    prisma.turma.count({ where: { ativa: true } }),
    prisma.plano.count({ where: { ativo: true } }),
    prisma.professor.count({ where: { ativo: true } }),
    prisma.matricula.findMany({
      where: { arquivadoEm: null },
      orderBy: { criadoEm: "desc" },
      take: 20,
      include: {
        aluno: { select: { nome: true } },
        turma: { select: { nome: true } },
        unidade: { select: { nome: true } },
        plano: { select: { nome: true } },
      },
    }),
  ]);

  return {
    disponivel: true as const,
    numeros: { matriculasNoMes, alunos, turmas, planos, professores },
    matriculas: matriculas.map((m) => ({
      id: m.id,
      aluno: m.aluno.nome,
      turma: m.turma.nome,
      unidade: m.unidade.nome,
      plano: m.plano.nome,
      status: m.status,
      criadaEm: m.criadoEm,
    })),
  };
}

/**
 * As configurações da escola, com os valores padrão.
 *
 * A taxa de matrícula nasce em 25, que é o valor que o site cobra hoje. Ter
 * um padrão evita que a tela pública fique sem número no dia em que a
 * configuração ainda não foi salva.
 */
export async function lerConfig() {
  const registros = await prisma.configuracao
    .findMany({
      where: {
        chave: {
          in: [CHAVE_CANVA, CHAVE_TAXA, CHAVE_TERMOS, CHAVE_EMISSAO, CHAVE_VENCIMENTO, CHAVE_GOOGLE_PLACE_ID],
        },
      },
    })
    .catch(() => []);

  const valor = (chave: string) => registros.find((r) => r.chave === chave)?.valor;

  return {
    linkCanva: valor(CHAVE_CANVA) ?? "",
    linkTermos: valor(CHAVE_TERMOS) ?? "",
    taxaMatricula: Number(valor(CHAVE_TAXA) ?? 25),
    diaVencimento: Number(valor(CHAVE_VENCIMENTO) ?? 10),
    // Só a string exata "true" liga. Qualquer outra coisa — ausente, vazio,
    // lixo — deixa desligado: o padrão seguro é não cobrar.
    emissaoAtiva: valor(CHAVE_EMISSAO) === "true",
    googlePlaceId: valor(CHAVE_GOOGLE_PLACE_ID) ?? "",
  };
}
