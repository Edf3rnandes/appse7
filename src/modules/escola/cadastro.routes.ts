import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DiaDaSemana, Prisma, StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { tratadorDeErro } from "../../lib/erros.js";
import { cpfValido, somenteDigitos } from "../../lib/cpf.js";
import { hoje, mesesAFrente } from "../../lib/datas.js";

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

// Mesmo limite e mesma checagem da arte do cronograma. O navegador já reduz
// antes de enviar; isto aqui é a barreira final.
const LIMITE_IMAGEM = 1_500_000;

const imagemDataUrl = z
  .string()
  .refine((v) => /^data:image\/(jpeg|png|webp);base64,/.test(v), "Formato de imagem não aceito.")
  .refine((v) => v.length <= LIMITE_IMAGEM, "A imagem ficou grande demais. Use uma menor.");

// Data de calendário vinda da query. Meia-noite UTC, pelo mesmo motivo do
// resto do sistema: `new Date("2026-09-08")` já é UTC, mas passar a string
// crua deixaria o fuso do servidor decidir o dia.
const dataOpcional = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .optional();

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
  // Ausente: mantém a foto atual (só faz sentido em edição). null: apaga.
  // string: troca. Mesmo padrão de imagem do resto do sistema — ver LIMITE_IMAGEM acima.
  fotoBase64: imagemDataUrl.nullable().optional(),
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
  // não conseguia entrar sozinho. Com e-mail, o convite sai da própria linha
  // do colaborador, sem redigitar nada.
  //
  // Vazio é aceito e vira ausência, em vez de erro: era o que impedia corrigir
  // um e-mail errado: com `.optional()` puro, apagar o campo mandava "" e a
  // validação recusava, então o e-mail errado não tinha como sair de lá.
  email: z
    .union([z.string().email("E-mail inválido."), z.literal("")])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  telefone: z.string().max(30).optional(),
  // Mesmo padrão do e-mail acima: "" apaga em vez de dar erro, senão não tem
  // como corrigir um documento digitado errado.
  cpf: z
    .union([z.string().transform(somenteDigitos).refine(cpfValido, "CPF inválido."), z.literal("")])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  rg: z.string().max(20).optional(),
  dataNascimento: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")])
    .optional()
    .transform((v) => (v ? new Date(`${v}T00:00:00.000Z`) : null)),
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
  // Ausente = o servidor decide: a primeira matrícula de um responsável é a
  // principal, as seguintes são vinculadas. É o caso comum, e deixar o padrão
  // certo evita que a família inteira vire "principal" por descuido.
  principal: z.boolean().optional(),
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
  const equipe = { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] };

  app.setErrorHandler(
    tratadorDeErro((erro) => {
      if (erro instanceof Prisma.PrismaClientKnownRequestError) {
        // Violação de unicidade. Sem isto o administrativo lê "Erro interno" ao
        // cadastrar um CPF que já existe, que é o erro mais comum de todos.
        if (erro.code === "P2002") {
          const alvo = (erro.meta?.target as string[] | undefined)?.join(", ") ?? "";
          return {
            status: 409,
            mensagem: alvo.includes("cpf")
              ? "Já existe um cadastro com esse CPF."
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
    const corpo = professorSchema.parse(request.body);
    return prisma.professor.update({
      where: { id },
      data: {
        ...corpo,
        // Reativar sem limpar a data deixaria um professor ativo carregando
        // um "desligado em" de uma saída anterior — a Folha de pagamento lê
        // esse campo pra decidir se a pessoa contava num mês passado, e um
        // resto desses faria um professor ativo parecer desligado.
        dataDesligamento: corpo.ativo ? null : undefined,
      },
    });
  });

  app.delete("/escola/professores/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { dataDesligamento } = z
      .object({ dataDesligamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(request.body ?? {});
    await prisma.professor.update({
      where: { id },
      data: {
        ativo: false,
        dataDesligamento: dataDesligamento ? new Date(`${dataDesligamento}T00:00:00.000Z`) : hoje(),
      },
    });
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
        // `select` e não `include`: com include, todos os campos escalares
        // viriam junto, e `foto` (uns 25 KB por aluno) arrastaria mais de um
        // megabyte numa página de cinquenta. Só a miniatura viaja.
        select: {
          id: true,
          nome: true,
          nascimento: true,
          observacao: true,
          arquivadoEm: true,
          responsavelId: true,
          fotoMiniatura: true,
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

  // ------------------------------------------------------------ relatórios
  //
  // Os quatro de Relatórios que não dependem do Asaas. O quinto — cobranças
  // vencidas — precisa da conta de cobrança e fica para quando ela entrar.

  /**
   * Matrículas vencendo ou vencidas.
   *
   * É a lista de quem precisa renovar, e a razão de existir do campo
   * `expiraEm`. Por padrão traz o que já venceu mais o que vence nos próximos
   * 30 dias: renovar depois do vencimento é perder aula, e o administrativo
   * precisa ligar antes.
   */
  app.get("/escola/relatorios/expiradas", equipe, async (request) => {
    const { dias, unidadeId } = z
      .object({
        dias: z.coerce.number().int().min(0).max(365).default(30),
        unidadeId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const limite = hoje();
    limite.setUTCDate(limite.getUTCDate() + dias);

    const itens = await prisma.matricula.findMany({
      where: {
        arquivadoEm: null,
        status: { in: [StatusMatricula.CONFIRMADA, StatusMatricula.PAGAMENTO_PENDENTE] },
        expiraEm: { not: null, lte: limite },
        ...(unidadeId ? { unidadeId } : {}),
      },
      orderBy: { expiraEm: "asc" },
      include: {
        aluno: { select: { id: true, nome: true } },
        responsavel: { select: { nome: true, telefone: true } },
        turma: { select: { nome: true } },
        unidade: { select: { nome: true } },
        plano: { select: { nome: true, valor: true, parcelas: true } },
      },
    });

    const agora = hoje();
    return {
      itens: itens.map((m) => ({
        ...m,
        // Dias até vencer; negativo quer dizer vencida há tantos dias.
        diasRestantes: Math.round(
          (new Date(m.expiraEm!).getTime() - agora.getTime()) / (24 * 60 * 60 * 1000),
        ),
      })),
      vencidas: itens.filter((m) => new Date(m.expiraEm!) < agora).length,
      total: itens.length,
    };
  });

  /**
   * Renova a matrícula: empurra o vencimento pelas parcelas do plano.
   *
   * A partir da data que vencer por último — hoje ou o vencimento atual —,
   * para quem renova adiantado não perder os dias que ainda tinha.
   */
  app.post("/escola/matriculas/:id/renovar", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);

    const matricula = await prisma.matricula.findUnique({
      where: { id },
      include: { plano: { select: { parcelas: true } } },
    });
    if (!matricula) return reply.code(404).send({ message: "Matrícula não encontrada." });

    const agora = hoje();
    const atual = matricula.expiraEm ? new Date(matricula.expiraEm) : agora;
    const base = atual > agora ? atual : agora;
    base.setUTCMonth(base.getUTCMonth() + matricula.plano.parcelas);

    return prisma.matricula.update({
      where: { id },
      data: { expiraEm: base, status: StatusMatricula.CONFIRMADA },
    });
  });

  /** Alunos por unidade e turma — a lista que se imprime para levar à quadra. */
  app.get("/escola/relatorios/alunos", equipe, async (request) => {
    const { unidadeId, turmaId } = z
      .object({
        unidadeId: z.string().uuid().optional(),
        turmaId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const itens = await prisma.matricula.findMany({
      where: {
        arquivadoEm: null,
        status: StatusMatricula.CONFIRMADA,
        ...(unidadeId ? { unidadeId } : {}),
        ...(turmaId ? { turmaId } : {}),
      },
      orderBy: [{ unidade: { nome: "asc" } }, { turma: { nome: "asc" } }, { aluno: { nome: "asc" } }],
      include: {
        aluno: { select: { id: true, nome: true, nascimento: true } },
        responsavel: { select: { nome: true, telefone: true } },
        turma: { select: { id: true, nome: true } },
        unidade: { select: { id: true, nome: true } },
      },
    });

    return { total: itens.length, itens };
  });

  /**
   * Cancelamentos no período, com o que entrou no mesmo recorte.
   *
   * O número sozinho não diz nada: 12 cancelamentos são poucos num mês de 60
   * matrículas e muitos num de 15. Por isso vêm os dois.
   */
  app.get("/escola/relatorios/canceladas", equipe, async (request) => {
    const { de, ate, unidadeId } = z
      .object({ de: dataOpcional, ate: dataOpcional, unidadeId: z.string().uuid().optional() })
      .parse(request.query);

    const fim = ate ?? new Date();
    const inicio = de ?? new Date(fim.getFullYear(), fim.getMonth(), 1);
    const janela = { gte: inicio, lte: fim };
    const unidade = unidadeId ? { unidadeId } : {};

    const [canceladas, confirmadas] = await Promise.all([
      prisma.matricula.findMany({
        where: { ...unidade, status: StatusMatricula.CANCELADA, canceladaEm: janela },
        orderBy: { canceladaEm: "desc" },
        include: {
          aluno: { select: { nome: true } },
          responsavel: { select: { nome: true, telefone: true } },
          turma: { select: { nome: true } },
          unidade: { select: { nome: true } },
        },
      }),
      prisma.matricula.count({
        where: { ...unidade, status: StatusMatricula.CONFIRMADA, criadoEm: janela },
      }),
    ]);

    return {
      periodo: { de: inicio, ate: fim },
      canceladas: canceladas.length,
      confirmadas,
      itens: canceladas,
    };
  });

  // ------------------------------------------------------------ frequência
  //
  // As duas telas que o sistema antigo tem em Administrativo. A diferença é
  // que lá a tabela só listava presenças: a falta não era um registro, era a
  // ausência de um. Não dava para dizer se um aluno faltou ou se a chamada
  // daquele dia nunca foi feita — e essa é justamente a pergunta que a
  // administrativo faz. Aqui a falta é uma linha, então o percentual significa
  // alguma coisa.

  const periodo = z.object({
    de: dataOpcional,
    ate: dataOpcional,
  });

  /** Padrão: os últimos 30 dias, que é o recorte de uma conversa com o pai. */
  function intervalo(de?: Date, ate?: Date) {
    const fim = ate ?? new Date();
    const inicio = de ?? new Date(fim.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { gte: inicio, lte: fim };
  }

  function resumir(registros: { presente: boolean }[]) {
    const presencas = registros.filter((r) => r.presente).length;
    return {
      aulas: registros.length,
      presencas,
      faltas: registros.length - presencas,
      percentual: registros.length ? Math.round((presencas / registros.length) * 100) : null,
    };
  }

  app.get("/escola/frequencia/turma", equipe, async (request, reply) => {
    const { turmaId, de, ate } = periodo
      .extend({ turmaId: z.string().uuid("Escolha a turma.") })
      .parse(request.query);

    const turma = await prisma.turma.findUnique({
      where: { id: turmaId },
      include: { unidade: { select: { nome: true } } },
    });
    if (!turma) return reply.code(404).send({ message: "Turma não encontrada." });

    const registros = await prisma.presenca.findMany({
      where: { turmaId, data: intervalo(de, ate) },
      orderBy: [{ data: "desc" }, { aluno: { nome: "asc" } }],
      include: {
        aluno: { select: { id: true, nome: true } },
        professor: { select: { nome: true } },
      },
    });

    // Agrupado por dia: o administrativo olha "o treino de terça" como uma coisa
    // só, não como vinte linhas soltas.
    const porDia = new Map<string, typeof registros>();
    for (const r of registros) {
      const dia = r.data.toISOString().slice(0, 10);
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia)!.push(r);
    }

    return {
      turma: { id: turma.id, nome: turma.nome, unidade: turma.unidade.nome },
      resumo: resumir(registros),
      aulas: [...porDia].map(([data, linhas]) => ({
        data,
        professor: linhas[0].professor.nome,
        presentes: linhas.filter((l) => l.presente).length,
        total: linhas.length,
        alunos: linhas.map((l) => ({ id: l.aluno.id, nome: l.aluno.nome, presente: l.presente })),
      })),
    };
  });

  app.get("/escola/frequencia/aluno", equipe, async (request, reply) => {
    const { alunoId, de, ate } = periodo
      .extend({ alunoId: z.string().uuid("Escolha o aluno.") })
      .parse(request.query);

    const aluno = await prisma.aluno.findUnique({
      where: { id: alunoId },
      select: {
        id: true,
        nome: true,
        fotoMiniatura: true,
        responsavel: { select: { nome: true, telefone: true } },
      },
    });
    if (!aluno) return reply.code(404).send({ message: "Aluno não encontrado." });

    const registros = await prisma.presenca.findMany({
      where: { alunoId, data: intervalo(de, ate) },
      orderBy: { data: "desc" },
      include: {
        turma: { select: { nome: true } },
        professor: { select: { nome: true } },
      },
    });

    return {
      aluno: {
        id: aluno.id,
        nome: aluno.nome,
        responsavel: aluno.responsavel?.nome ?? null,
        telefone: aluno.responsavel?.telefone ?? null,
      },
      resumo: resumir(registros),
      registros: registros.map((r) => ({
        data: r.data,
        presente: r.presente,
        turma: r.turma.nome,
        professor: r.professor.nome,
      })),
    };
  });

  /**
   * Foto do aluno.
   *
   * Chega já reduzida e recomprimida pelo navegador, em dois tamanhos: a
   * miniatura para as listas e a maior para abrir. O limite aqui é a última
   * barreira — uma foto crua de celular passa de 5 MB e viraria uma linha
   * gigante no banco.
   *
   * Para que serve: o professor que pega uma turma nova tem vinte e cinco
   * crianças e nenhum rosto. A lista de chamada com foto resolve isso na
   * primeira aula, não na terceira semana.
   */
  app.put("/escola/alunos/:id/foto", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    const { foto, miniatura } = z
      .object({ foto: imagemDataUrl, miniatura: imagemDataUrl })
      .parse(request.body);

    await prisma.aluno.update({
      where: { id },
      data: { foto, fotoMiniatura: miniatura },
    });

    // Devolve só a miniatura: quem acabou de enviar já tem a imagem na tela,
    // e mandá-la de volta seria pagar o dobro pelo mesmo dado.
    return { fotoMiniatura: miniatura };
  });

  app.delete("/escola/alunos/:id/foto", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.aluno.update({ where: { id }, data: { foto: null, fotoMiniatura: null } });
    return reply.code(204).send();
  });

  /** A foto grande, sob demanda — nunca em lista. */
  app.get("/escola/alunos/:id/foto", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const aluno = await prisma.aluno.findUnique({
      where: { id },
      select: { foto: true, nome: true },
    });

    if (!aluno) return reply.code(404).send({ message: "Aluno não encontrado." });
    if (!aluno.foto) return reply.code(404).send({ message: "Esse aluno não tem foto." });

    return { nome: aluno.nome, foto: aluno.foto };
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
          responsavel: { select: { id: true, nome: true, telefone: true, cpf: true } },
          turma: { select: { id: true, nome: true } },
          unidade: { select: { id: true, nome: true } },
          plano: { select: { id: true, nome: true, valor: true } },
        },
      }),
    ]);

    return { total, pagina, limite, itens };
  });

  /**
   * As outras matrículas do mesmo responsável.
   *
   * É o "Matrículas Vinculadas" da tela antiga: quando uma família tem dois ou
   * três filhos na escola, quem atende precisa ver o conjunto — não a linha
   * isolada que abriu.
   */
  app.get("/escola/matriculas/:id/familia", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);

    const matricula = await prisma.matricula.findUnique({
      where: { id },
      include: { responsavel: { select: { id: true, nome: true, telefone: true, cpf: true } } },
    });
    if (!matricula) return reply.code(404).send({ message: "Matrícula não encontrada." });

    const irmas = await prisma.matricula.findMany({
      where: {
        responsavelId: matricula.responsavelId,
        id: { not: id },
        arquivadoEm: null,
      },
      orderBy: [{ principal: "desc" }, { criadoEm: "desc" }],
      include: {
        aluno: { select: { id: true, nome: true } },
        turma: { select: { nome: true } },
        unidade: { select: { nome: true } },
        plano: { select: { nome: true, valor: true } },
      },
    });

    return { responsavel: matricula.responsavel, vinculadas: irmas };
  });

  app.post("/escola/matriculas", equipe, async (request, reply) => {
    const corpo = matriculaSchema.parse(request.body);

    const [aluno, turma, plano] = await Promise.all([
      prisma.aluno.findUnique({ where: { id: corpo.alunoId } }),
      prisma.turma.findUnique({
        where: { id: corpo.turmaId },
        include: { _count: { select: { matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } } } } },
      }),
      prisma.plano.findUnique({ where: { id: corpo.planoId } }),
    ]);

    if (!aluno) return reply.code(404).send({ message: "Aluno não encontrado." });
    if (!turma) return reply.code(404).send({ message: "Turma não encontrada." });
    if (!plano) return reply.code(404).send({ message: "Plano não encontrado." });
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

    const jaTemPrincipal = await prisma.matricula.count({
      where: {
        responsavelId: aluno.responsavelId,
        principal: true,
        arquivadoEm: null,
        status: { not: StatusMatricula.CANCELADA },
      },
    });

    const criada = await prisma.matricula.create({
      data: {
        ...corpo,
        // Sem data informada, a matrícula vale pelo número de parcelas do
        // plano: um semestral de 6 vence em 6 meses. É a mesma conta que o
        // sistema antigo fazia (now()->addMonths(installments)), só que lá ela
        // acontecia ao gerar a cobrança — então uma matrícula sem cobrança
        // gerada ficava sem vencimento e nunca aparecia como vencida.
        expiraEm: corpo.expiraEm ?? mesesAFrente(plano.parcelas),
        principal: corpo.principal ?? jaTemPrincipal === 0,
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

  app.patch("/escola/matriculas/:id", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { status, observacao, principal } = z
      .object({
        status: z.nativeEnum(StatusMatricula).optional(),
        observacao: z.string().max(1000).optional(),
        principal: z.boolean().optional(),
      })
      .parse(request.body);

    if (status === undefined && principal === undefined && observacao === undefined) {
      return reply.code(400).send({ message: "Nada para alterar." });
    }

    // Só o `principal` mudou: não é troca de situação, e mexer em
    // `canceladaEm` aqui apagaria a data de um cancelamento real.
    if (status === undefined) {
      return prisma.matricula.update({
        where: { id },
        data: {
          ...(principal === undefined ? {} : { principal }),
          ...(observacao === undefined ? {} : { observacao }),
        },
      });
    }

    return prisma.matricula.update({
      where: { id },
      data: {
        status,
        ...(principal === undefined ? {} : { principal }),
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
