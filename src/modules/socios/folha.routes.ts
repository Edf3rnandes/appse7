import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CategoriaFolha, CodigoDiasFolha, TipoColaboradorFolha } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Folha de pagamento — controle de horas, faltas e valores da equipe.
 *
 * Reconstrução nativa de uma plataforma que já existia separada (HTML
 * próprio, banco à parte). A pessoa em si (nome, e-mail, ativo/desligado)
 * é o `Professor` que Administrativo → Colaboradores já cadastra, com
 * convite e papéis — ver o cabeçalho de ColaboradorFolha no schema para o
 * porquê disto NÃO duplica esse cadastro, só complementa com o que é
 * específico de folha (tipo pra fins de pagamento, nível, categoria).
 *
 * Mora na aba dos sócios: é controle de pagamento da equipe, não operação
 * do dia a dia da escola — por isso um módulo próprio, e não mais rotas
 * dentro de socios.routes.ts (que hoje é praticamente só leitura). Mas quem
 * a pessoa É continua sendo decidido só em Administrativo.
 *
 * Fase 1 desta reconstrução: Colaboradores, Grade Horária e Valores — a
 * base de cadastro de que todo o resto (lançamentos, folha calculada,
 * financeiro) depende. As fases seguintes chegam em cima desta.
 */

const idParams = z.object({ id: z.string().uuid() });

const colaboradorSchema = z.object({
  professorId: z.string().uuid("Escolha o colaborador."),
  tipo: z.nativeEnum(TipoColaboradorFolha),
  nivel: z.number().int().min(1).max(3).default(1),
  // "" limpa (volta a usar o `tipo`) — mesmo padrão do resto do sistema.
  categoriaFolha: z.union([z.nativeEnum(CategoriaFolha), z.literal("")]).optional(),
});

const colaboradorEdicaoSchema = colaboradorSchema.omit({ professorId: true });

const gradeSchema = z.object({
  unidadeId: z.string().uuid("Escolha a unidade."),
  turma: z.string().trim().min(1, "Turma é obrigatória.").max(160),
  codigo: z.nativeEnum(CodigoDiasFolha),
  horario: z.string().max(60).optional(),
  duracaoHoras: z.number().min(0).max(24),
  tipo: z.nativeEnum(TipoColaboradorFolha),
  nivel: z.number().int().min(1).max(3).default(1),
  semVt: z.boolean().default(false),
  nota: z.string().max(300).optional(),
  // Ausente/"" = vale desde sempre / sem fim.
  dataInicio: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional(),
  dataFim: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional(),
});

const valorSchema = z.object({
  tipo: z.nativeEnum(TipoColaboradorFolha),
  nivel: z.number().int().min(1).max(3),
  valorHora: z.number().min(0),
  valorVt: z.number().min(0),
});

const dataOpcional = (v?: string) => (v ? new Date(`${v}T00:00:00.000Z`) : null);

export async function folhaRoutes(app: FastifyInstance) {
  const somenteSocios = { preHandler: [app.exigirPapel("SOCIO")] };

  // ----------------------------------------------------------- colaboradores
  //
  // A lista já vem com o `professor` embutido (nome, e-mail, ativo,
  // desligamento) — a tela não faz uma segunda chamada pra montar isso.
  app.get("/folha/colaboradores", somenteSocios, async () =>
    prisma.colaboradorFolha.findMany({
      include: { professor: { select: { nome: true, email: true, ativo: true, dataDesligamento: true } } },
      orderBy: [{ professor: { ativo: "desc" } }, { professor: { nome: "asc" } }],
    }));

  /**
   * Quem em Administrativo → Colaboradores ainda não tem perfil de folha —
   * a lista que alimenta o seletor de "novo colaborador" aqui. Não cria
   * pessoa nenhuma: só aponta pra quem já existe.
   */
  app.get("/folha/colaboradores/disponiveis", somenteSocios, async () => {
    const jaTemFolha = (await prisma.colaboradorFolha.findMany({ select: { professorId: true } }))
      .map((c) => c.professorId);
    return prisma.professor.findMany({
      where: { ativo: true, id: { notIn: jaTemFolha } },
      orderBy: { nome: "asc" },
      select: { id: true, nome: true, email: true },
    });
  });

  app.post("/folha/colaboradores", somenteSocios, async (request, reply) => {
    const d = colaboradorSchema.parse(request.body);

    const professor = await prisma.professor.findUnique({ where: { id: d.professorId } });
    if (!professor) return reply.code(404).send({ message: "Colaborador não encontrado em Administrativo." });

    const jaTem = await prisma.colaboradorFolha.findUnique({ where: { professorId: d.professorId } });
    if (jaTem) return reply.code(409).send({ message: "Esse colaborador já tem perfil de folha." });

    const colaborador = await prisma.colaboradorFolha.create({
      data: {
        professorId: d.professorId,
        tipo: d.tipo,
        nivel: d.nivel,
        categoriaFolha: d.categoriaFolha || null,
      },
      include: { professor: { select: { nome: true, email: true, ativo: true, dataDesligamento: true } } },
    });
    return reply.code(201).send(colaborador);
  });

  app.put("/folha/colaboradores/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const d = colaboradorEdicaoSchema.parse(request.body);

    const existe = await prisma.colaboradorFolha.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Colaborador não encontrado." });

    return prisma.colaboradorFolha.update({
      where: { id },
      data: { tipo: d.tipo, nivel: d.nivel, categoriaFolha: d.categoriaFolha || null },
      include: { professor: { select: { nome: true, email: true, ativo: true, dataDesligamento: true } } },
    });
  });

  /**
   * Demitir e Reativar mexem no `Professor`, não no perfil de folha — é o
   * mesmo campo que Administrativo → Colaboradores usa (Desativar/o PUT com
   * ativo:true). Duas telas, um estado só: não tem como um dizer "ativo" e o
   * outro "desligado" pra mesma pessoa.
   */
  app.post("/folha/colaboradores/:id/demitir", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { dataDesligamento } = z
      .object({ dataDesligamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(request.body);

    const existe = await prisma.colaboradorFolha.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Colaborador não encontrado." });

    await prisma.professor.update({
      where: { id: existe.professorId },
      data: { ativo: false, dataDesligamento: dataOpcional(dataDesligamento) },
    });
    return { id };
  });

  app.post("/folha/colaboradores/:id/reativar", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const existe = await prisma.colaboradorFolha.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Colaborador não encontrado." });

    await prisma.professor.update({
      where: { id: existe.professorId },
      data: { ativo: true, dataDesligamento: null },
    });
    return { id };
  });

  /**
   * Remove só o perfil de folha (grade, lançamentos, férias e correções
   * dele — a foreign key é `onDelete: Cascade`). O cadastro da pessoa em
   * Administrativo não é tocado: pra excluí-la de vez, é lá que se faz.
   */
  app.delete("/folha/colaboradores/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.colaboradorFolha.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ----------------------------------------------------------- grade horária
  app.get("/folha/grade", somenteSocios, async () =>
    prisma.gradeHorariaFolha.findMany({
      include: { unidade: { select: { nome: true } } },
      orderBy: [{ colaboradorId: "asc" }, { turma: "asc" }],
    }));

  app.post("/folha/grade/:colaboradorId", somenteSocios, async (request, reply) => {
    const { colaboradorId } = z.object({ colaboradorId: z.string().uuid() }).parse(request.params);
    const d = gradeSchema.parse(request.body);

    const colaborador = await prisma.colaboradorFolha.findUnique({ where: { id: colaboradorId } });
    if (!colaborador) return reply.code(404).send({ message: "Colaborador não encontrado." });

    const linha = await prisma.gradeHorariaFolha.create({
      data: {
        colaboradorId,
        unidadeId: d.unidadeId,
        turma: d.turma,
        codigo: d.codigo,
        horario: d.horario ?? "",
        duracaoHoras: d.duracaoHoras,
        tipo: d.tipo,
        nivel: d.nivel,
        semVt: d.semVt,
        nota: d.nota || null,
        dataInicio: dataOpcional(d.dataInicio),
        dataFim: dataOpcional(d.dataFim),
      },
      include: { unidade: { select: { nome: true } } },
    });
    return reply.code(201).send(linha);
  });

  app.put("/folha/grade/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const d = gradeSchema.parse(request.body);

    const existe = await prisma.gradeHorariaFolha.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Linha de grade não encontrada." });

    return prisma.gradeHorariaFolha.update({
      where: { id },
      data: {
        unidadeId: d.unidadeId,
        turma: d.turma,
        codigo: d.codigo,
        horario: d.horario ?? "",
        duracaoHoras: d.duracaoHoras,
        tipo: d.tipo,
        nivel: d.nivel,
        semVt: d.semVt,
        nota: d.nota || null,
        dataInicio: dataOpcional(d.dataInicio),
        dataFim: dataOpcional(d.dataFim),
      },
      include: { unidade: { select: { nome: true } } },
    });
  });

  app.delete("/folha/grade/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.gradeHorariaFolha.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- valores
  //
  // Uma linha por tipo+nível (6 no total: Professor/Estagiário × 1/2/3).
  // Não tem POST/DELETE de propósito — a lista de combinações é fixa, só o
  // valor de cada uma muda. `upsert` cria a linha na primeira vez que
  // alguém preenche aquele tipo+nível.
  app.get("/folha/valores", somenteSocios, async () =>
    prisma.valorFolha.findMany({ orderBy: [{ tipo: "asc" }, { nivel: "asc" }] }));

  app.put("/folha/valores", somenteSocios, async (request) => {
    const d = valorSchema.parse(request.body);
    return prisma.valorFolha.upsert({
      where: { tipo_nivel: { tipo: d.tipo, nivel: d.nivel } },
      create: d,
      update: { valorHora: d.valorHora, valorVt: d.valorVt },
    });
  });
}
