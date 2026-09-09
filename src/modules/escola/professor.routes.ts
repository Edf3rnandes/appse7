import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { LegadoIndisponivelError } from "../../db/legacy/pool.js";
import {
  frequenciaJaLancadaHoje,
  listarAlunosDaTurma,
  listarTurmasDoProfessor,
  turmaPertenceAoProfessor,
} from "../../db/legacy/escola.repository.js";
import {
  FrequenciaRecusadaError,
  LegadoApiIndisponivelError,
  lancarFrequencia,
} from "../../services/legado/frequencia.service.js";
import { segundaDaSemana, primeiroDiaDoMes, ultimoDiaDoMes, somarDias } from "../../lib/datas.js";

const turmaParams = z.object({ id: z.coerce.number().int().positive() });

const frequenciaSchema = z.object({
  turmaId: z.number({ required_error: "Turma é obrigatória." }).int().positive(),
  presencas: z
    .array(z.object({ alunoId: z.number().int().positive(), presente: z.boolean() }))
    .min(1, "Marque a lista antes de enviar."),
});

const mesQuery = z.object({
  mes: z.coerce.number().int().min(1).max(12).optional(),
  ano: z.coerce.number().int().min(2020).max(2100).optional(),
});

export async function professorRoutes(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    if (err instanceof LegadoIndisponivelError || err instanceof LegadoApiIndisponivelError) {
      return reply.code(503).send({ message: err.message });
    }
    if (err instanceof FrequenciaRecusadaError) {
      return reply.code(409).send({ message: err.message });
    }
    request.log.error(err);
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.code(statusCode).send({
      message: statusCode < 500 ? err.message : "Erro interno.",
    });
  });

  app.get("/professor/turmas", { preHandler: [app.exigirProfessor] }, async (request) =>
    listarTurmasDoProfessor(request.user.professorId!),
  );

  // Lista de chamada: alfabética e numerada, do jeito que o professor confere
  // em campo. A numeração é posicional (1..N da lista de hoje) e vai junto da
  // resposta para o número ser o mesmo no app, no papel e na conversa.
  app.get(
    "/professor/turmas/:id/alunos",
    { preHandler: [app.exigirProfessor] },
    async (request, reply) => {
      const { id } = turmaParams.parse(request.params);

      if (!(await turmaPertenceAoProfessor(id, request.user.professorId!))) {
        return reply.code(404).send({ message: "Turma não encontrada." });
      }

      const [alunos, jaLancada] = await Promise.all([
        listarAlunosDaTurma(id),
        frequenciaJaLancadaHoje(id),
      ]);

      return {
        // Avisado aqui, e não só no envio: o Laravel recusa a segunda chamada
        // do dia, e descobrir isso depois de preencher a lista inteira seria
        // perder o trabalho.
        frequenciaJaLancadaHoje: jaLancada,
        alunos: alunos.map((a, i) => ({
          numero: i + 1,
          id: a.id,
          nome: a.nome,
          responsavel: a.responsavel,
        })),
      };
    },
  );

  app.post("/professor/frequencia", { preHandler: [app.exigirProfessor] }, async (request, reply) => {
    const corpo = frequenciaSchema.parse(request.body);
    const professorId = request.user.professorId!;

    if (!(await turmaPertenceAoProfessor(corpo.turmaId, professorId))) {
      return reply.code(404).send({ message: "Turma não encontrada." });
    }

    // Só alunos que estão de fato na turma hoje: evita que uma lista velha
    // aberta no celular grave presença de quem já saiu.
    const matriculados = new Set((await listarAlunosDaTurma(corpo.turmaId)).map((a) => a.id));
    const presencas = corpo.presencas.filter((p) => matriculados.has(p.alunoId));

    if (presencas.length === 0) {
      return reply.code(409).send({
        message: "A lista mudou desde que você abriu. Recarregue a turma e tente de novo.",
      });
    }

    await lancarFrequencia(professorId, corpo.turmaId, presencas);

    return reply.code(201).send({
      message: "Frequência enviada com sucesso!",
      presentes: presencas.filter((p) => p.presente).length,
      total: presencas.length,
    });
  });

  // Cronograma da semana atual e da próxima — o professor planeja a aula de
  // hoje e já vê o que vem. Aqui a arte VAI junto: são duas semanas, e é a
  // imagem que ele repassa para o grupo.
  //
  // O link do Canva fica de fora de propósito: é o documento editável da
  // equipe, uso interno da secretaria.
  app.get("/professor/semana", { preHandler: [app.exigirProfessor] }, async () => {
    const estaSemana = segundaDaSemana(new Date());
    const proximaSemana = somarDias(estaSemana, 7);

    const semanas = await prisma.cronogramaSemana.findMany({
      where: { status: "publicado", semana: { in: [estaSemana, proximaSemana] } },
      orderBy: { semana: "asc" },
      select: {
        id: true, semana: true, tema: true, fundamentos: true, exerciciosSugeridos: true,
        observacoes: true, textoDivulgacao: true, imagemBase64: true, imagemNome: true,
      },
    });

    const achar = (data: Date) =>
      semanas.find((s) => s.semana.toISOString().slice(0, 10) === data.toISOString().slice(0, 10)) ?? null;

    return { atual: achar(estaSemana), proxima: achar(proximaSemana) };
  });

  // Agenda do mês: eventos e as semanas programadas, para o professor ver o
  // mês inteiro de uma vez.
  app.get("/professor/agenda", { preHandler: [app.exigirProfessor] }, async (request) => {
    const { mes, ano } = mesQuery.parse(request.query);
    const hoje = new Date();
    const referencia = new Date(ano ?? hoje.getFullYear(), (mes ?? hoje.getMonth() + 1) - 1, 1);

    const inicio = primeiroDiaDoMes(referencia);
    const fim = ultimoDiaDoMes(referencia);

    const [eventos, semanas] = await Promise.all([
      prisma.evento.findMany({
        where: { publicado: true, data: { gte: inicio, lte: fim } },
        orderBy: { data: "asc" },
      }),
      // Sem a arte: a visão do mês lista várias semanas, e mandar o data URL
      // de cada uma deixaria a resposta na casa dos megabytes num celular em
      // rede móvel. `temArte` diz que existe, e a semana inteira vem em
      // /professor/semana.
      prisma.cronogramaSemana.findMany({
        where: { status: "publicado", semana: { gte: somarDias(inicio, -6), lte: fim } },
        orderBy: { semana: "asc" },
        select: {
          id: true, semana: true, tema: true, fundamentos: true,
          exerciciosSugeridos: true, observacoes: true, textoDivulgacao: true,
          imagemNome: true,
        },
      }),
    ]);

    return {
      mes: referencia.getMonth() + 1,
      ano: referencia.getFullYear(),
      eventos,
      semanas: semanas.map(({ imagemNome, ...s }) => ({ ...s, temArte: imagemNome !== null })),
    };
  });
}
