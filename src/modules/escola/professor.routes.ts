import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusMatricula, TipoOcorrencia } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { hoje, primeiroDiaDoMes, segundaDaSemana, somarDias, ultimoDiaDoMes } from "../../lib/datas.js";
import { tratadorDeErro } from "../../lib/erros.js";
import {
  CronogramaIndisponivelError,
  listarPublicadasNoIntervalo,
  obterPublicadasComArte,
} from "../../db/compartilhado/cronograma.repository.js";

const turmaParams = z.object({ id: z.string().uuid() });

const frequenciaSchema = z.object({
  turmaId: z.string({ required_error: "Turma é obrigatória." }).uuid(),
  presencas: z
    .array(z.object({ alunoId: z.string().uuid(), presente: z.boolean() }))
    .min(1, "Marque a lista antes de enviar."),
});

const ocorrenciaSchema = z.object({
  tipo: z.nativeEnum(TipoOcorrencia),
  turmaId: z.string().uuid().optional(),
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
    tratadorDeErro((erro) =>
      erro instanceof CronogramaIndisponivelError
        ? { status: 503, mensagem: erro.message }
        : undefined,
    ),
  );

  /** As turmas do professor logado. Usada como filtro em tudo daqui para baixo. */
  async function turmaDoProfessor(turmaId: string, professorId: string) {
    return prisma.turma.findFirst({
      where: { id: turmaId, ativa: true, professores: { some: { professorId } } },
      include: { unidade: { select: { nome: true } } },
    });
  }

  app.get("/professor/turmas", { preHandler: [app.exigirProfessor] }, async (request) => {
    const turmas = await prisma.turma.findMany({
      where: { ativa: true, professores: { some: { professorId: request.user.professorId! } } },
      orderBy: [{ unidade: { nome: "asc" } }, { nome: "asc" }],
      include: {
        unidade: { select: { id: true, nome: true } },
        horarios: { orderBy: { inicio: "asc" } },
        _count: {
          select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } } },
        },
      },
    });

    return turmas.map((t) => ({
      id: t.id,
      nome: t.nome,
      categoria: t.categoria,
      unidadeId: t.unidade.id,
      unidadeNome: t.unidade.nome,
      capacidade: t.capacidade,
      matriculados: t._count.matriculas,
      horarios: t.horarios.map((h) => ({ dia: h.dia, inicio: h.inicio, fim: h.fim })),
    }));
  });

  // Lista de chamada: alfabética e numerada, do jeito que o professor confere
  // em campo. A numeração é posicional (1..N da lista de hoje) e vai junto da
  // resposta para o número ser o mesmo no app, no papel e na conversa.
  app.get(
    "/professor/turmas/:id/alunos",
    { preHandler: [app.exigirProfessor] },
    async (request, reply) => {
      const { id } = turmaParams.parse(request.params);

      if (!(await turmaDoProfessor(id, request.user.professorId!))) {
        return reply.code(404).send({ message: "Turma não encontrada." });
      }

      const [matriculas, jaLancadas] = await Promise.all([
        prisma.matricula.findMany({
          where: { turmaId: id, status: StatusMatricula.CONFIRMADA, arquivadoEm: null },
          include: {
            // A miniatura, nunca a foto grande: a lista de chamada de uma
            // turma de 25 é aberta na quadra, em rede móvel.
            aluno: { select: { id: true, nome: true, fotoMiniatura: true } },
            responsavel: { select: { nome: true } },
          },
        }),
        prisma.presenca.findMany({
          where: { turmaId: id, data: hoje() },
          select: { alunoId: true, presente: true },
        }),
      ]);

      // Ordem alfabética com acento no lugar certo: "Ávila" vem antes de
      // "Bruno", não depois de "Zuleide". Ordenar por bytes no banco faria o
      // contrário, e a lista de chamada é conferida na ordem do papel.
      const ordenados = matriculas.sort((a, b) =>
        a.aluno.nome.localeCompare(b.aluno.nome, "pt-BR"),
      );
      // Não basta saber QUE já foi lançada: a lista precisa abrir com as
      // marcações de hoje. Sem isso ela apareceria toda vazia e um toque em
      // "Enviar" gravaria falta para a turma inteira, por cima de uma chamada
      // correta.
      const lancados = new Map(jaLancadas.map((p) => [p.alunoId, p.presente]));

      return {
        // Avisado aqui, e não só no envio: refazer a chamada de hoje é
        // permitido (o professor corrige um engano), mas ele precisa saber
        // que está corrigindo, não lançando pela primeira vez.
        frequenciaJaLancadaHoje: lancados.size > 0,
        alunos: ordenados.map((m, i) => ({
          numero: i + 1,
          id: m.aluno.id,
          nome: m.aluno.nome,
          foto: m.aluno.fotoMiniatura,
          responsavel: m.responsavel.nome,
          jaLancado: lancados.has(m.alunoId),
          presente: lancados.get(m.alunoId) ?? false,
        })),
      };
    },
  );

  app.post("/professor/frequencia", { preHandler: [app.exigirProfessor] }, async (request, reply) => {
    const corpo = frequenciaSchema.parse(request.body);
    const professorId = request.user.professorId!;

    if (!(await turmaDoProfessor(corpo.turmaId, professorId))) {
      return reply.code(404).send({ message: "Turma não encontrada." });
    }

    // Só alunos que estão de fato na turma hoje: evita que uma lista velha
    // aberta no celular grave presença de quem já saiu.
    const matriculados = new Set(
      (
        await prisma.matricula.findMany({
          where: { turmaId: corpo.turmaId, status: StatusMatricula.CONFIRMADA, arquivadoEm: null },
          select: { alunoId: true },
        })
      ).map((m) => m.alunoId),
    );
    const presencas = corpo.presencas.filter((p) => matriculados.has(p.alunoId));

    if (presencas.length === 0) {
      return reply.code(409).send({
        message: "A lista mudou desde que você abriu. Recarregue a turma e tente de novo.",
      });
    }

    const data = hoje();

    // Refazer a chamada de hoje corrige, não duplica: a chave única
    // (turma, aluno, dia) transforma o reenvio em atualização. O sistema
    // antigo recusava a segunda chamada do dia, e um erro de marcação ficava
    // gravado até alguém mexer no banco.
    await prisma.$transaction(
      presencas.map((p) =>
        prisma.presenca.upsert({
          where: { turmaId_alunoId_data: { turmaId: corpo.turmaId, alunoId: p.alunoId, data } },
          create: {
            turmaId: corpo.turmaId,
            alunoId: p.alunoId,
            professorId,
            data,
            presente: p.presente,
          },
          update: { presente: p.presente, professorId },
        }),
      ),
    );

    return reply.code(201).send({
      message: "Frequência registrada!",
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
      const turma = await turmaDoProfessor(corpo.turmaId, professorId);
      if (!turma) return reply.code(404).send({ message: "Turma não encontrada." });
      turmaNome = turma.nome;
    }

    const ocorrencia = await prisma.ocorrencia.create({
      data: {
        tipo: corpo.tipo,
        professorId,
        professorNome: request.user.nome,
        turmaId: corpo.turmaId ?? null,
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
      where: { professorId: request.user.professorId! },
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
