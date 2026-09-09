import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DiaDaSemana, Prisma, StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { tratadorDeErro } from "../../lib/erros.js";
import { cpfValido, somenteDigitos } from "../../lib/cpf.js";

/**
 * Cadastro da escola: unidades, turmas, planos, professores, responsáveis,
 * alunos e matrículas.
 *
 * É a reconstrução das telas de administração do se7volei (units, courses,
 * plans, teachers, students, enrollment) sobre as tabelas do Hub. A diferença
 * que importa: aqui nada é apagado de verdade. "Excluir" carimba `arquivadoEm`
 * — no sistema antigo, cancelar uma matrícula apagava o cadastro do aluno e do
 * responsável em definitivo, e foi assim que se perdeu a base que o
 * recovery_customers.json tentou remontar.
 */

const idParams = z.object({ id: z.string().uuid() });

const paginacao = z.object({
  busca: z.string().max(120).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  pagina: z.coerce.number().int().min(1).default(1),
  incluirArquivados: z.coerce.boolean().default(false),
});

const horarioSchema = z.object({
  dia: z.nativeEnum(DiaDaSemana),
  // Horário de parede da escola. Não é instante, então não tem fuso.
  inicio: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."),
  fim: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM."),
});

const unidadeSchema = z.object({
  nome: z.string({ required_error: "Nome é obrigatório." }).min(1, "Nome é obrigatório.").max(120),
  descricao: z.string().max(500).optional(),
  endereco: z.string().max(300).optional(),
  ativa: z.boolean().default(true),
});

const turmaSchema = z.object({
  nome: z.string({ required_error: "Nome é obrigatório." }).min(1, "Nome é obrigatório.").max(120),
  unidadeId: z.string().uuid("Escolha a unidade."),
  categoria: z.string().max(80).optional(),
  descricao: z.string().max(1000).optional(),
  link: z.string().url("Link inválido.").max(500).optional(),
  capacidade: z.number().int().min(1).max(500).optional(),
  ativa: z.boolean().default(true),
  aceitaNovasMatriculas: z.boolean().default(true),
  horarios: z.array(horarioSchema).max(7).default([]),
  professorIds: z.array(z.string().uuid()).max(20).default([]),
  planoIds: z.array(z.string().uuid()).max(30).default([]),
});

const planoSchema = z.object({
  nome: z.string({ required_error: "Nome é obrigatório." }).min(1, "Nome é obrigatório.").max(120),
  descricao: z.string().max(1000).optional(),
  valor: z.number().min(0, "Valor não pode ser negativo."),
  parcelas: z.number().int().min(1).max(24).default(1),
  ativo: z.boolean().default(true),
  multiplasMatriculas: z.boolean().default(false),
  descontoPercentual: z.number().int().min(0).max(100).default(0),
  descontoAteDias: z.number().int().min(0).max(365).default(0),
});

const professorSchema = z.object({
  nome: z.string({ required_error: "Nome é obrigatório." }).min(1, "Nome é obrigatório.").max(120),
  // O sistema antigo não guardava e-mail de professor, e é por isso que ele
  // não conseguia entrar sozinho. Com e-mail, o convite vira opcional.
  email: z.string().email("E-mail inválido.").optional(),
  telefone: z.string().max(30).optional(),
  ativo: z.boolean().default(true),
});

const responsavelSchema = z.object({
  nome: z.string({ required_error: "Nome é obrigatório." }).min(1, "Nome é obrigatório.").max(160),
  cpf: z
    .string({ required_error: "CPF é obrigatório." })
    .transform(somenteDigitos)
    .refine(cpfValido, "CPF inválido."),
  email: z.string().email("E-mail inválido.").optional().or(z.literal("")),
  telefone: z.string().max(30).optional(),
  cep: z.string().max(12).optional(),
  logradouro: z.string().max(200).optional(),
  numero: z.string().max(20).optional(),
  complemento: z.string().max(120).optional(),
  bairro: z.string().max(120).optional(),
  cidade: z.string().max(120).optional(),
  estado: z.string().max(2).optional(),
});

const alunoSchema = z.object({
  nome: z.string({ required_error: "Nome é obrigatório." }).min(1, "Nome é obrigatório.").max(160),
  responsavelId: z.string().uuid().optional(),
  nascimento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
    .transform((v) => new Date(`${v}T00:00:00.000Z`))
    .optional(),
  fotoUrl: z.string().max(500).optional(),
  observacao: z.string().max(1000).optional(),
});

const matriculaSchema = z.object({
  alunoId: z.string().uuid("Escolha o aluno."),
  turmaId: z.string().uuid("Escolha a turma."),
  planoId: z.string().uuid("Escolha o plano."),
  // O responsável e a unidade não vêm do formulário: saem do aluno e da turma.
  // Deixar o cliente mandar os quatro é como o original permitia matricular um
  // aluno na unidade errada — dados que se contradizem na mesma linha.
  observacao: z.string().max(1000).optional(),
  expiraEm: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
    .transform((v) => new Date(`${v}T00:00:00.000Z`))
    .optional(),
  status: z.nativeEnum(StatusMatricula).default(StatusMatricula.CRIADA),
});

/** Texto de busca vira filtro "contém, sem diferenciar maiúsculas". */
function contem(busca: string | undefined, campos: string[]) {
  if (!busca) return undefined;
  return {
    OR: campos.map((campo) => ({
      [campo]: { contains: busca, mode: Prisma.QueryMode.insensitive },
    })),
  };
}

export async function cadastroRoutes(app: FastifyInstance) {
  const equipe = { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] };

  app.setErrorHandler(
    tratadorDeErro((erro) => {
      if (erro instanceof Prisma.PrismaClientKnownRequestError) {
        // Violação de unicidade. Sem isto a secretaria lê "Erro interno" ao
        // cadastrar um CPF que já existe, que é o erro mais comum de todos.
        if (erro.code === "P2002") {
          const alvo = (erro.meta?.target as string[] | undefined)?.join(", ") ?? "";
          return {
            status: 409,
            mensagem: alvo.includes("cpf")
              ? "Já existe um responsável com esse CPF."
              : "Esse registro já existe.",
          };
        }
        if (erro.code === "P2003") {
          return { status: 400, mensagem: "Registro relacionado não encontrado." };
        }
        if (erro.code === "P2025") {
          return { status: 404, mensagem: "Registro não encontrado." };
        }
      }
      return undefined;
    }),
  );

  // ------------------------------------------------------------- unidades
  app.get("/escola/unidades", equipe, async (request) => {
    const { busca, incluirArquivados } = paginacao.parse(request.query);
    return prisma.unidade.findMany({
      where: {
        ...(incluirArquivados ? {} : { ativa: true }),
        ...contem(busca, ["nome"]),
      },
      orderBy: { nome: "asc" },
      include: { _count: { select: { turmas: true } } },
    });
  });

  app.post("/escola/unidades", equipe, async (request, reply) => {
    const corpo = unidadeSchema.parse(request.body);
    return reply.code(201).send(await prisma.unidade.create({ data: corpo }));
  });

  app.put("/escola/unidades/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    return prisma.unidade.update({ where: { id }, data: unidadeSchema.parse(request.body) });
  });

  // Unidade não tem `arquivadoEm`: desativar já a tira de toda tela de
  // matrícula, e apagar de verdade quebraria o histórico das turmas.
  app.delete("/escola/unidades/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const turmas = await prisma.turma.count({ where: { unidadeId: id, ativa: true } });
    if (turmas > 0) {
      return reply.code(409).send({
        message: `Essa unidade ainda tem ${turmas} turma(s) ativa(s). Desative as turmas antes.`,
      });
    }
    await prisma.unidade.update({ where: { id }, data: { ativa: false } });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- turmas
  app.get("/escola/turmas", equipe, async (request) => {
    const { busca, incluirArquivados } = paginacao.parse(request.query);
    const { unidadeId } = z.object({ unidadeId: z.string().uuid().optional() }).parse(request.query);

    return prisma.turma.findMany({
      where: {
        ...(incluirArquivados ? {} : { ativa: true }),
        ...(unidadeId ? { unidadeId } : {}),
        ...contem(busca, ["nome", "categoria"]),
      },
      orderBy: [{ unidade: { nome: "asc" } }, { nome: "asc" }],
      include: {
        unidade: { select: { id: true, nome: true } },
        horarios: { orderBy: { inicio: "asc" } },
        professores: { include: { professor: { select: { id: true, nome: true } } } },
        planos: { include: { plano: { select: { id: true, nome: true, valor: true } } } },
        _count: { select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA } } } },
      },
    });
  });

  app.post("/escola/turmas", equipe, async (request, reply) => {
    const { horarios, professorIds, planoIds, ...turma } = turmaSchema.parse(request.body);
    const criada = await prisma.turma.create({
      data: {
        ...turma,
        horarios: { create: horarios },
        professores: { create: professorIds.map((professorId) => ({ professorId })) },
        planos: { create: planoIds.map((planoId) => ({ planoId })) },
      },
      include: { horarios: true },
    });
    return reply.code(201).send(criada);
  });

  app.put("/escola/turmas/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    const { horarios, professorIds, planoIds, ...turma } = turmaSchema.parse(request.body);

    // Vínculos e horários são substituídos por inteiro. Um diff item a item
    // custaria mais código e não muda o resultado: são listas curtas.
    return prisma.$transaction(async (tx) => {
      await tx.horarioTurma.deleteMany({ where: { turmaId: id } });
      await tx.professorTurma.deleteMany({ where: { turmaId: id } });
      await tx.planoTurma.deleteMany({ where: { turmaId: id } });

      return tx.turma.update({
        where: { id },
        data: {
          ...turma,
          horarios: { create: horarios },
          professores: { create: professorIds.map((professorId) => ({ professorId })) },
          planos: { create: planoIds.map((planoId) => ({ planoId })) },
        },
        include: { horarios: true },
      });
    });
  });

  app.delete("/escola/turmas/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const matriculas = await prisma.matricula.count({
      where: { turmaId: id, status: StatusMatricula.CONFIRMADA, arquivadoEm: null },
    });
    if (matriculas > 0) {
      return reply.code(409).send({
        message: `Essa turma tem ${matriculas} matrícula(s) confirmada(s). Transfira ou cancele antes.`,
      });
    }
    await prisma.turma.update({ where: { id }, data: { ativa: false } });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- planos
  app.get("/escola/planos", equipe, async (request) => {
    const { busca, incluirArquivados } = paginacao.parse(request.query);
    return prisma.plano.findMany({
      where: { ...(incluirArquivados ? {} : { ativo: true }), ...contem(busca, ["nome"]) },
      orderBy: { nome: "asc" },
    });
  });

  app.post("/escola/planos", equipe, async (request, reply) => {
    return reply.code(201).send(await prisma.plano.create({ data: planoSchema.parse(request.body) }));
  });

  app.put("/escola/planos/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    return prisma.plano.update({ where: { id }, data: planoSchema.parse(request.body) });
  });

  app.delete("/escola/planos/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.plano.update({ where: { id }, data: { ativo: false } });
    return reply.code(204).send();
  });

  // ----------------------------------------------------------- professores
  app.get("/escola/professores", equipe, async (request) => {
    const { busca, incluirArquivados } = paginacao.parse(request.query);
    return prisma.professor.findMany({
      where: { ...(incluirArquivados ? {} : { ativo: true }), ...contem(busca, ["nome", "email"]) },
      orderBy: { nome: "asc" },
      include: { _count: { select: { turmas: true } } },
    });
  });

  app.post("/escola/professores", equipe, async (request, reply) => {
    const corpo = professorSchema.parse(request.body);
    return reply.code(201).send(await prisma.professor.create({ data: corpo }));
  });

  app.put("/escola/professores/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    return prisma.professor.update({ where: { id }, data: professorSchema.parse(request.body) });
  });

  app.delete("/escola/professores/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.professor.update({ where: { id }, data: { ativo: false } });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------- responsáveis
  app.get("/escola/responsaveis", equipe, async (request) => {
    const { busca, limite, pagina, incluirArquivados } = paginacao.parse(request.query);
    const where = {
      ...(incluirArquivados ? {} : { arquivadoEm: null }),
      ...contem(busca, ["nome", "email", "cpf"]),
    };

    const [total, itens] = await Promise.all([
      prisma.responsavel.count({ where }),
      prisma.responsavel.findMany({
        where,
        orderBy: { nome: "asc" },
        skip: (pagina - 1) * limite,
        take: limite,
        include: { _count: { select: { alunos: true } } },
      }),
    ]);

    return { total, pagina, limite, itens };
  });

  app.post("/escola/responsaveis", equipe, async (request, reply) => {
    const { email, ...resto } = responsavelSchema.parse(request.body);
    const criado = await prisma.responsavel.create({
      data: { ...resto, email: email || null },
    });
    return reply.code(201).send(criado);
  });

  app.put("/escola/responsaveis/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    const { email, ...resto } = responsavelSchema.parse(request.body);
    return prisma.responsavel.update({ where: { id }, data: { ...resto, email: email || null } });
  });

  app.delete("/escola/responsaveis/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.responsavel.update({ where: { id }, data: { arquivadoEm: new Date() } });
    return reply.code(204).send();
  });

  // ----------------------------------------------------------------- alunos
  app.get("/escola/alunos", equipe, async (request) => {
    const { busca, limite, pagina, incluirArquivados } = paginacao.parse(request.query);
    // Os alunos de uma família só. Sem isto a tela de matrícula teria de
    // baixar a escola inteira e filtrar no navegador.
    const { responsavelId } = z
      .object({ responsavelId: z.string().uuid().optional() })
      .parse(request.query);

    const where = {
      ...(incluirArquivados ? {} : { arquivadoEm: null }),
      ...(responsavelId ? { responsavelId } : {}),
      ...contem(busca, ["nome"]),
    };

    const [total, itens] = await Promise.all([
      prisma.aluno.count({ where }),
      prisma.aluno.findMany({
        where,
        orderBy: { nome: "asc" },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          responsavel: { select: { id: true, nome: true, telefone: true } },
          matriculas: {
            where: { arquivadoEm: null, status: { not: StatusMatricula.CANCELADA } },
            orderBy: { criadoEm: "desc" },
            take: 1,
            include: {
              turma: { select: { id: true, nome: true } },
              unidade: { select: { id: true, nome: true } },
              plano: { select: { id: true, nome: true } },
            },
          },
        },
      }),
    ]);

    return { total, pagina, limite, itens };
  });

  app.post("/escola/alunos", equipe, async (request, reply) => {
    return reply.code(201).send(await prisma.aluno.create({ data: alunoSchema.parse(request.body) }));
  });

  app.put("/escola/alunos/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    return prisma.aluno.update({ where: { id }, data: alunoSchema.parse(request.body) });
  });

  app.delete("/escola/alunos/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.aluno.update({ where: { id }, data: { arquivadoEm: new Date() } });
    return reply.code(204).send();
  });

  // ------------------------------------------------------------- matrículas
  app.get("/escola/matriculas", equipe, async (request) => {
    const { busca, limite, pagina, incluirArquivados } = paginacao.parse(request.query);
    const { status, turmaId } = z
      .object({
        status: z.nativeEnum(StatusMatricula).optional(),
        turmaId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const where = {
      ...(incluirArquivados ? {} : { arquivadoEm: null }),
      ...(status ? { status } : {}),
      ...(turmaId ? { turmaId } : {}),
      ...(busca
        ? { aluno: { nome: { contains: busca, mode: Prisma.QueryMode.insensitive } } }
        : {}),
    };

    const [total, itens] = await Promise.all([
      prisma.matricula.count({ where }),
      prisma.matricula.findMany({
        where,
        orderBy: { criadoEm: "desc" },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          aluno: { select: { id: true, nome: true } },
          responsavel: { select: { id: true, nome: true, telefone: true } },
          turma: { select: { id: true, nome: true } },
          unidade: { select: { id: true, nome: true } },
          plano: { select: { id: true, nome: true, valor: true } },
        },
      }),
    ]);

    return { total, pagina, limite, itens };
  });

  app.post("/escola/matriculas", equipe, async (request, reply) => {
    const corpo = matriculaSchema.parse(request.body);

    const [aluno, turma] = await Promise.all([
      prisma.aluno.findUnique({ where: { id: corpo.alunoId } }),
      prisma.turma.findUnique({
        where: { id: corpo.turmaId },
        include: { _count: { select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } } } } },
      }),
    ]);

    if (!aluno) return reply.code(404).send({ message: "Aluno não encontrado." });
    if (!turma) return reply.code(404).send({ message: "Turma não encontrada." });
    if (!aluno.responsavelId) {
      return reply.code(400).send({
        message: "Esse aluno ainda não tem responsável. Ligue um responsável antes de matricular.",
      });
    }

    // A turma tem capacidade declarada e ela é para valer. O sistema antigo
    // guardava amount_students como texto e nunca conferia, então turma
    // lotada só aparecia quando o professor reclamava.
    if (turma.capacidade != null && turma._count.matriculas >= turma.capacidade) {
      return reply.code(409).send({
        message:
          turma.capacidade === 1
            ? `A turma ${turma.nome} tem uma vaga só, e ela já está preenchida.`
            : `A turma ${turma.nome} está com as ${turma.capacidade} vagas preenchidas.`,
      });
    }

    const jaMatriculado = await prisma.matricula.findFirst({
      where: {
        alunoId: corpo.alunoId,
        turmaId: corpo.turmaId,
        arquivadoEm: null,
        status: { in: [StatusMatricula.CRIADA, StatusMatricula.PAGAMENTO_PENDENTE, StatusMatricula.CONFIRMADA] },
      },
    });
    if (jaMatriculado) {
      return reply.code(409).send({ message: "Esse aluno já está matriculado nessa turma." });
    }

    const criada = await prisma.matricula.create({
      data: {
        ...corpo,
        responsavelId: aluno.responsavelId,
        unidadeId: turma.unidadeId,
      },
      include: {
        aluno: { select: { nome: true } },
        turma: { select: { nome: true } },
      },
    });

    return reply.code(201).send(criada);
  });

  app.patch("/escola/matriculas/:id", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    const { status, observacao } = z
      .object({
        status: z.nativeEnum(StatusMatricula),
        observacao: z.string().max(1000).optional(),
      })
      .parse(request.body);

    return prisma.matricula.update({
      where: { id },
      data: {
        status,
        ...(observacao === undefined ? {} : { observacao }),
        // Reativar limpa o carimbo, senão a tela mostra "cancelada em" numa
        // matrícula que voltou a valer.
        canceladaEm: status === StatusMatricula.CANCELADA ? new Date() : null,
      },
    });
  });

  app.delete("/escola/matriculas/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.matricula.update({ where: { id }, data: { arquivadoEm: new Date() } });
    return reply.code(204).send();
  });
}
