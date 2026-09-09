import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { cpfValido, somenteDigitos } from "../../lib/cpf.js";
import { mesesAFrente } from "../../lib/datas.js";
import { tratadorDeErro } from "../../lib/erros.js";

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
 *      matrícula, e a secretaria decide.
 *   2. Lá, o aluno e o responsável são gravados ANTES da cobrança. Se o
 *      pagamento falha, a resposta é erro mas as linhas ficam no banco. Aqui
 *      tudo acontece numa transação.
 *   3. Lá, a matrícula principal nasce PAYMENT_PENDDING e as dos irmãos
 *      nascem CREATED — o mesmo pedido em dois estados. Aqui todas nascem
 *      CRIADA, aguardando a secretaria.
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

const matriculaDoSiteSchema = z.object({
  aluno: alunoSchema,
  // Irmãos matriculados no mesmo pedido — o "plano família" do site.
  irmaos: z.array(alunoSchema).max(5, "Fale com a secretaria para mais de seis alunos.").default([]),

  // O aluno adulto é o próprio responsável. No sistema atual isso é o
  // `isMenor`, e decide de qual conjunto de campos o CPF é lido.
  responsavelEhOAluno: z.boolean().default(false),
  responsavel: z.object({
    nome: z.string().max(160).optional(),
    cpf: z
      .string({ required_error: "Informe o CPF do responsável." })
      .transform(somenteDigitos)
      .refine(cpfValido, "CPF inválido."),
    email: z.string().email("E-mail inválido.").optional().or(z.literal("")),
    telefone: z.string().min(10, "Informe o telefone com DDD.").max(30),
  }),
});

export async function publicoRoutes(app: FastifyInstance) {
  app.setErrorHandler(tratadorDeErro());

  // Rota aberta na internet: um limite bem mais apertado que o do resto do
  // sistema. Não atrapalha um envio de boa-fé e corta o automatizado.
  await app.register(rateLimit, { max: 10, timeWindow: "10 minutes" });

  /**
   * O catálogo que o site mostra: unidades, turmas com horário e vaga, e os
   * planos de cada turma.
   *
   * Não devolve nada de pessoa. A rota equivalente do sistema atual,
   * /api/courses/{id}/students, devolve nome e foto de aluno para qualquer um
   * — é o vazamento que o patch de segurança fecha.
   */
  app.get("/publico/catalogo", async () => {
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
                plano: { select: { id: true, nome: true, valor: true, parcelas: true, ativo: true } },
              },
            },
            _count: {
              select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } } },
            },
          },
        },
      },
    });

    return unidades
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
                })),
            };
          })
          // Turma cheia ou sem plano não entra: oferecer no site o que não dá
          // para contratar gera uma conversa de decepção com a secretaria.
          .filter((t) => t.planos.length > 0 && (t.vagas === null || t.vagas > 0)),
      }))
      .filter((u) => u.turmas.length > 0);
  });

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
    // sobrescrevemos: vira recado para a secretaria conferir com a família.
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
                "Matrícula feita pelo site.",
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
