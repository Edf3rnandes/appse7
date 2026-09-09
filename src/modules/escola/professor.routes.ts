import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TipoOcorrencia } from "@prisma/client";
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
import { hoje, primeiroDiaDoMes, segundaDaSemana, somarDias, ultimoDiaDoMes } from "../../lib/datas.js";
import { tratadorDeErro } from "../../lib/erros.js";
import {
  CronogramaIndisponivelError,
  listarPublicadasNoIntervalo,
  obterPublicadasComArte,
} from "../../db/compartilhado/cronograma.repository.js";

const turmaParams = z.object({ id: z.coerce.number().int().positive() });

const frequenciaSchema = z.object({
  turmaId: z.number({ required_error: "Turma é obrigatória." }).int().positive(),
  presencas: z
    .array(z.object({ alunoId: z.number().int().positive(), presente: z.boolean() }))
    .min(1, "Marque a lista antes de enviar."),
});

const ocorrenciaSchema = z.object({
  tipo: z.nativeEnum(TipoOcorrencia),
  turmaId: z.number().int().positive().optional(),
  alunoNome: z.string().max(200).optional(),
  descricao: z
    .string({ required_error: "Descreva o que aconteceu." })
    .min(5, "Descreva com um pouco mais de detalhe.")
    .max(2000),
});

const mesQuery = z.object({
  mes: z.coerce.number().int().min(1).max(12).optional(),
  ano: z.coerce.number().int().min(2020).max(2100).optional(),
});

export async function professorRoutes(app: FastifyInstance) {
  app.setErrorHandler(
    tratadorDeErro((erro) => {
      // Mensagem de gente: a original cita LEGACY_MYSQL_* e nomes de tabela,
      // que dizem tudo para quem opera o servidor e nada para o professor.
      if (erro instanceof LegadoIndisponivelError) {
        return {
          status: 503,
          mensagem: "Os dados de alunos e turmas estão indisponíveis no momento.",
        };
      }
      if (erro instanceof LegadoApiIndisponivelError || erro instanceof CronogramaIndisponivelError) {
        return { status: 503, mensagem: erro.message };
      }
      if (erro instanceof FrequenciaRecusadaError) {
        return { status: 409, mensagem: erro.message };
      }
      return undefined;
    }),
  );

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

  // O professor avisa; a secretaria resolve. O nome dele e o da turma são
  // gravados junto do id: sem a ponte com o MySQL ligada, o aviso ainda
  // precisa ser legível de ponta a ponta.
  app.post("/professor/ocorrencias", { preHandler: [app.exigirProfessor] }, async (request, reply) => {
    const corpo = ocorrenciaSchema.parse(request.body);
    const professorId = request.user.professorId!;

    let turmaNome: string | null = null;
    if (corpo.turmaId !== undefined) {
      try {
        if (!(await turmaPertenceAoProfessor(corpo.turmaId, professorId))) {
          return reply.code(404).send({ message: "Turma não encontrada." });
        }
        const turmas = await listarTurmasDoProfessor(professorId);
        turmaNome = turmas.find((t) => t.id === corpo.turmaId)?.nome ?? null;
      } catch (erro) {
        // Com a ponte desligada não dá para conferir a turma — mas recusar o
        // aviso por isso seria trocar um problema pequeno (contexto
        // incompleto) por um grande (o professor sem como avisar). Guardamos
        // o aviso; o id da turma fica sem nome e a secretaria entende pelo
        // texto, que é o que ela lê de qualquer forma.
        if (!(erro instanceof LegadoIndisponivelError)) throw erro;
        request.log.warn("Aviso gravado sem conferir a turma: ponte com o legado desligada.");
      }
    }

    const ocorrencia = await prisma.ocorrencia.create({
      data: {
        tipo: corpo.tipo,
        professorLegacyId: professorId,
        professorNome: request.user.nome,
        turmaLegacyId: corpo.turmaId ?? null,
        turmaNome,
        alunoNome: corpo.alunoNome ?? null,
        descricao: corpo.descricao,
      },
    });

    return reply.code(201).send(ocorrencia);
  });

  // O professor acompanha o que avisou e o que a secretaria respondeu — sem
  // isso ele avisa no escuro e volta para o WhatsApp para saber se deu certo.
  app.get("/professor/ocorrencias", { preHandler: [app.exigirProfessor] }, async (request) =>
    prisma.ocorrencia.findMany({
      where: { professorLegacyId: request.user.professorId! },
      orderBy: [{ status: "asc" }, { criadoEm: "desc" }],
      take: 50,
    }),
  );

  // Cronograma da semana atual e da próxima — o professor planeja a aula de
  // hoje e já vê o que vem. Aqui a arte VAI junto: são duas semanas, e é a
  // imagem que ele repassa para o grupo.
  //
  // O link do Canva fica de fora de propósito: é o documento editável da
  // equipe, uso interno da secretaria.
  app.get("/professor/semana", { preHandler: [app.exigirProfessor] }, async () => {
    const estaSemana = segundaDaSemana(hoje());
    const proximaSemana = somarDias(estaSemana, 7);

    const semanas = await obterPublicadasComArte([estaSemana, proximaSemana]);

    // O link do Canva e as postagens planejadas ficam de fora: são material
    // interno da equipe, e a tabela é compartilhada — o recorte é feito aqui.
    const paraProfessor = (s: (typeof semanas)[number]) => ({
      id: s.id,
      semana: s.semana,
      tema: s.tema,
      fundamentos: s.fundamentos,
      exerciciosSugeridos: s.exerciciosSugeridos,
      observacoes: s.observacoes,
      textoDivulgacao: s.textoDivulgacao,
      imagemBase64: s.imagemBase64,
      imagemNome: s.imagemNome,
    });

    const achar = (data: Date) => {
      const achada = semanas.find(
        (s) => s.semana.toISOString().slice(0, 10) === data.toISOString().slice(0, 10),
      );
      return achada ? paraProfessor(achada) : null;
    };

    return { atual: achar(estaSemana), proxima: achar(proximaSemana) };
  });

  // Agenda do mês: eventos e as semanas programadas, para o professor ver o
  // mês inteiro de uma vez.
  app.get("/professor/agenda", { preHandler: [app.exigirProfessor] }, async (request) => {
    const { mes, ano } = mesQuery.parse(request.query);
    const referencia = hoje();
    const anoAlvo = ano ?? referencia.getUTCFullYear();
    const mesAlvo = mes ?? referencia.getUTCMonth() + 1;

    const inicio = primeiroDiaDoMes(anoAlvo, mesAlvo);
    const fim = ultimoDiaDoMes(anoAlvo, mesAlvo);

    const [eventos, semanas] = await Promise.all([
      prisma.evento.findMany({
        where: { publicado: true, data: { gte: inicio, lte: fim } },
        orderBy: { data: "asc" },
      }),
      // Sem a arte: a visão do mês lista várias semanas, e mandar o data URL
      // de cada uma deixaria a resposta na casa dos megabytes num celular em
      // rede móvel. `temArte` diz que existe, e a semana inteira vem em
      // /professor/semana.
      listarPublicadasNoIntervalo(somarDias(inicio, -6), fim),
    ]);

    return {
      mes: mesAlvo,
      ano: anoAlvo,
      eventos,
      semanas: semanas.map((s) => ({
        id: s.id,
        semana: s.semana,
        tema: s.tema,
        fundamentos: s.fundamentos,
        exerciciosSugeridos: s.exerciciosSugeridos,
        observacoes: s.observacoes,
        textoDivulgacao: s.textoDivulgacao,
        temArte: s.imagemNome !== null,
      })),
    };
  });
}
