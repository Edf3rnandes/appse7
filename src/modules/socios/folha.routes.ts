import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CategoriaFolha, CodigoDiasFolha, TipoColaboradorFolha, TipoLancamentoFolha } from "@prisma/client";
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
 * Mora na aba da Diretoria (área dos sócios): é controle de pagamento da equipe, não operação
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
const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.");

const lancamentoSchema = z.object({
  colaboradorId: z.string().uuid("Escolha o colaborador."),
  data: dataIso,
  tipo: z.nativeEnum(TipoLancamentoFolha),
  nivel: z.number().int().min(1).max(3).default(1),
  horas: z.number().min(0).default(0),
  usaVt: z.boolean().default(true),
  motivo: z.string().max(500).optional(),
});

const loteSchema = z.object({ texto: z.string().min(1, "Cole ao menos uma linha.") });

const recorrenteSchema = z.object({
  colaboradorId: z.string().uuid("Escolha o colaborador."),
  tipo: z.nativeEnum(TipoLancamentoFolha),
  nivel: z.number().int().min(1).max(3).default(1),
  horas: z.number().min(0).default(0),
  usaVt: z.boolean().default(true),
  motivo: z.string().max(500).optional(),
  de: dataIso,
  ate: dataIso,
  // 0 = domingo ... 6 = sábado, mesma convenção do Date.getUTCDay().
  diasSemana: z.array(z.number().int().min(0).max(6)).min(1, "Marque pelo menos um dia da semana."),
});

/**
 * "07/08/2026", "2026-08-07" ou variações com "-" — o mesmo tanto de formato
 * que colar de uma planilha brasileira produz. Devolve null quando não
 * reconhece, pra quem chama decidir se é erro de linha ou data ausente.
 */
function parseDataFlexivel(str: string): string | null {
  const s = (str || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, d, mo, yRaw] = m;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

// As mesmas variações que a tela aceita ao colar de uma planilha — "falta
// atestado", "psicóloga" sozinho etc. Ficam num mapa achatado (sem acento
// também) pra não exigir que quem cola escreva do jeito exato do sistema.
const MAPA_TIPO_LOTE: Record<string, TipoLancamentoFolha> = {
  extra: "EXTRA", "aula extra": "EXTRA",
  ausência: "AUSENCIA", ausencia: "AUSENCIA", falta: "AUSENCIA",
  "falta sem atestado": "AUSENCIA", "ausência sem atestado": "AUSENCIA", "ausencia sem atestado": "AUSENCIA",
  "ausência com atestado": "AUSENCIA_ATESTADO", "ausencia com atestado": "AUSENCIA_ATESTADO",
  "falta com atestado": "AUSENCIA_ATESTADO", "falta atestado": "AUSENCIA_ATESTADO", atestado: "AUSENCIA_ATESTADO",
  bônus: "BONUS", bonus: "BONUS",
  competição: "COMPETICAO", competicao: "COMPETICAO",
  "competição psicóloga": "COMPETICAO_PSICOLOGA", "competicao psicologa": "COMPETICAO_PSICOLOGA",
  psicóloga: "COMPETICAO_PSICOLOGA", psicologa: "COMPETICAO_PSICOLOGA",
  "desconto vt": "DESCONTO_VT", "desconto de vt": "DESCONTO_VT", "estorno vt": "DESCONTO_VT",
  "devolução vt": "DESCONTO_VT", "devolucao vt": "DESCONTO_VT",
  "banco de horas": "BANCO_HORAS_COMPENSADO", "banco de horas - compensado": "BANCO_HORAS_COMPENSADO",
  compensado: "BANCO_HORAS_COMPENSADO",
};

function normalizarTipoLote(str: string): TipoLancamentoFolha | null {
  return MAPA_TIPO_LOTE[(str || "").trim().toLowerCase()] ?? null;
}

function normalizarVtLote(str: string): boolean {
  const s = (str || "").trim().toLowerCase();
  return !["não", "nao", "n", "no", "false", "0"].includes(s);
}

function splitLinhaLote(linha: string): string[] {
  const partes = linha.includes("\t") ? linha.split("\t") : linha.includes(";") ? linha.split(";") : linha.split(",");
  return partes.map((p) => p.trim());
}

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

  // ------------------------------------------------------------ lançamentos
  //
  // O valor em R$ nunca é gravado aqui — só o evento (data, tipo, horas). Que
  // tanto vale isso hoje é sempre calculado na hora de mostrar, cruzando com
  // ValorFolha (ver o comentário de LancamentoFolha no schema). Sem edição em
  // lugar: um lançamento errado se apaga e se lança de novo, não se corrige —
  // mesma regra do sistema original, e evita que um histórico de "quem mudou
  // o quê" precise existir só pra isto.
  app.get("/folha/lancamentos", somenteSocios, async () =>
    prisma.lancamentoFolha.findMany({
      include: { colaborador: { select: { professor: { select: { nome: true } } } } },
      orderBy: { data: "desc" },
    }));

  app.post("/folha/lancamentos", somenteSocios, async (request, reply) => {
    const d = lancamentoSchema.parse(request.body);
    const colaborador = await prisma.colaboradorFolha.findUnique({ where: { id: d.colaboradorId } });
    if (!colaborador) return reply.code(404).send({ message: "Colaborador não encontrado." });

    const lancamento = await prisma.lancamentoFolha.create({
      data: {
        colaboradorId: d.colaboradorId,
        data: dataOpcional(d.data)!,
        tipo: d.tipo,
        nivel: d.nivel,
        horas: d.horas,
        usaVt: d.usaVt,
        motivo: d.motivo || null,
      },
      include: { colaborador: { select: { professor: { select: { nome: true } } } } },
    });
    return reply.code(201).send(lancamento);
  });

  app.delete("/folha/lancamentos/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.lancamentoFolha.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  /**
   * Colar uma lista do Excel (uma linha por lançamento) e importar de uma
   * vez. Ordem das colunas: Data, Colaborador, Tipo, Nível, Horas, Usa VT,
   * Motivo — separadas por Tab, ponto e vírgula ou vírgula. Linhas com
   * problema (colaborador não encontrado, tipo não reconhecido, data
   * inválida) não travam as outras: entram as boas, e as com erro voltam
   * na resposta pra corrigir e colar de novo só essas.
   */
  app.post("/folha/lancamentos/lote", somenteSocios, async (request, reply) => {
    const { texto } = loteSchema.parse(request.body);
    const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let corpo = linhas;
    const primeiraCols = linhas[0] ? splitLinhaLote(linhas[0]) : [];
    if (primeiraCols[0] && /^data$/i.test(primeiraCols[0])) corpo = linhas.slice(1);
    if (!corpo.length) return reply.code(400).send({ message: "Nenhuma linha de dados encontrada." });

    const colaboradores = await prisma.colaboradorFolha.findMany({
      select: { id: true, nivel: true, professor: { select: { nome: true } } },
    });
    const porNome = new Map(colaboradores.map((c) => [c.professor.nome.toLowerCase(), c]));

    const validos: { colaboradorId: string; data: Date; tipo: TipoLancamentoFolha; nivel: number; horas: number; usaVt: boolean; motivo: string | null }[] = [];
    const erros: { linha: number; texto: string; motivo: string }[] = [];

    corpo.forEach((linha, i) => {
      const [dataRaw, colaboradorRaw, tipoRaw, nivelRaw, horasRaw, vtRaw, ...motivoRest] = splitLinhaLote(linha);
      const dataIsoStr = parseDataFlexivel(dataRaw);
      const colaboradorNome = (colaboradorRaw || "").trim();
      const colab = porNome.get(colaboradorNome.toLowerCase());
      const tipo = normalizarTipoLote(tipoRaw);

      const problemas: string[] = [];
      if (!dataIsoStr) problemas.push("data inválida");
      if (!colaboradorNome) problemas.push("colaborador em branco");
      else if (!colab) problemas.push(`colaborador não encontrado: "${colaboradorNome}"`);
      if (!tipo) problemas.push(`tipo não reconhecido: "${tipoRaw || ""}"`);

      if (problemas.length) {
        erros.push({ linha: i + 1, texto: linha, motivo: problemas.join("; ") });
        return;
      }

      let nivel = parseInt(nivelRaw, 10);
      if (Number.isNaN(nivel)) nivel = colab!.nivel;
      let horas = parseFloat((horasRaw || "").replace(",", "."));
      if (Number.isNaN(horas)) horas = 0;

      validos.push({
        colaboradorId: colab!.id,
        data: dataOpcional(dataIsoStr ?? undefined)!,
        tipo: tipo!,
        nivel,
        horas,
        usaVt: normalizarVtLote(vtRaw),
        motivo: motivoRest.join(" ").trim() || null,
      });
    });

    if (validos.length) await prisma.lancamentoFolha.createMany({ data: validos });

    return { inseridos: validos.length, erros };
  });

  /**
   * Gera vários lançamentos iguais de uma vez, um por data que caia nos dias
   * da semana marcados dentro do período — pra hora extra fixa (Seg/Qua/Sex
   * toda semana) ou pra fechar o mês de quem está saindo sem lançar falta
   * dia a dia.
   */
  app.post("/folha/lancamentos/recorrente", somenteSocios, async (request, reply) => {
    const d = recorrenteSchema.parse(request.body);
    if (d.de > d.ate) return reply.code(400).send({ message: 'A data "De" não pode ser depois da data "Até".' });

    const colaborador = await prisma.colaboradorFolha.findUnique({ where: { id: d.colaboradorId } });
    if (!colaborador) return reply.code(404).send({ message: "Colaborador não encontrado." });

    const datas: Date[] = [];
    const cursor = new Date(`${d.de}T00:00:00.000Z`);
    const fim = new Date(`${d.ate}T00:00:00.000Z`);
    while (cursor <= fim) {
      if (d.diasSemana.includes(cursor.getUTCDay())) datas.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    if (!datas.length) {
      return reply.code(400).send({ message: "Não caiu nenhuma data desse período nos dias da semana marcados." });
    }

    await prisma.lancamentoFolha.createMany({
      data: datas.map((data) => ({
        colaboradorId: d.colaboradorId,
        data,
        tipo: d.tipo,
        nivel: d.nivel,
        horas: d.horas,
        usaVt: d.usaVt,
        motivo: d.motivo || null,
      })),
    });

    return { criados: datas.length };
  });
}
