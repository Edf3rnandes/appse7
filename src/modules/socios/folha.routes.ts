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
  cref: z.string().max(30).optional(),
  chavePix: z.string().max(140).optional(),
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

// ======================================================================
// Fase 3 — Folha de Pagamento e Controle Interno.
//
// Tudo abaixo é puro (recebe dados já carregados, nenhuma chamada ao
// banco): dá pra testar a regra de negócio inteira — VT antecipado,
// feriado por unidade, férias, falta descontando nível — sem precisar de
// Postgres, e as rotas HTTP só carregam os dados e chamam estas funções.
// É a mesma conta que a planilha original fazia, linha por linha do mês.
// ======================================================================

export type GradeParaCalculo = {
  colaboradorId: string;
  unidadeId: string;
  codigo: CodigoDiasFolha;
  duracaoHoras: number;
  nivel: number;
  semVt: boolean;
  dataInicio: string | null; // "AAAA-MM-DD"
  dataFim: string | null;
};
export type FeriadoParaCalculo = { data: string; unidadeId: string | null; contaTrabalhado: boolean };
export type FeriasParaCalculo = { colaboradorId: string; dataInicio: string; dataFim: string };
export type LancamentoParaCalculo = {
  colaboradorId: string; data: string; tipo: TipoLancamentoFolha; nivel: number; horas: number; usaVt: boolean;
};
export type ValorParaCalculo = { tipo: TipoColaboradorFolha; nivel: number; valorHora: number; valorVt: number };
export type ColaboradorParaCalculo = { id: string; tipo: TipoColaboradorFolha; ativo: boolean; dataDesligamento: string | null };

// 0=domingo ... 6=sábado, mesma convenção do Date.getUTCDay().
const CODIGO_DIAS_SEMANA: Record<CodigoDiasFolha, number[]> = {
  TQ: [2, 4], SQS: [1, 3, 5], SQ: [1, 3], QS: [3, 5], SEX: [5], SAB: [6],
};

/** "2026-09" -> "2026-10". Vira o ano quando o mês é dezembro. */
export function proximoMes(mes: string): string {
  const [ano, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(ano, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function* diasDoMes(mes: string): Generator<{ iso: string; weekday: number }> {
  const [ano, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(ano, m - 1, 1));
  while (d.getUTCMonth() === m - 1) {
    yield { iso: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export function feriadoExclui(feriados: FeriadoParaCalculo[], iso: string, unidadeId: string): boolean {
  return feriados.some((f) => f.data === iso && !f.contaTrabalhado && (f.unidadeId === null || f.unidadeId === unidadeId));
}

export function emFerias(ferias: FeriasParaCalculo[], colaboradorId: string, iso: string): boolean {
  return ferias.some((f) => f.colaboradorId === colaboradorId && iso >= f.dataInicio && iso <= f.dataFim);
}

/**
 * Um colaborador conta num mês se ainda está ativo, ou se foi desligado
 * naquele mês ou depois dele (o mês do próprio desligamento ainda entra
 * normalmente — só os meses seguintes é que somem).
 */
export function colaboradorAtivoNoMes(colaborador: { ativo: boolean; dataDesligamento: string | null }, mes: string): boolean {
  if (colaborador.ativo) return true;
  if (!colaborador.dataDesligamento) return true;
  return colaborador.dataDesligamento.slice(0, 7) >= mes;
}

export type ResultadoGrade = {
  totalHoras: number;
  porNivel: Record<number, number>;
  diasLetivosTotais: number;
  diasComVT: number;
  diasDeFerias: number;
  temGrade: boolean;
};

/**
 * Horas esperadas no mês pela Grade Horária, percorrendo dia a dia (pra
 * aplicar feriado por unidade e férias corretamente) e contando quantos
 * dias distintos o colaborador dá aula de fato (pro VT).
 */
export function horasEsperadasGrade(
  colaboradorId: string,
  mes: string,
  grade: GradeParaCalculo[],
  feriados: FeriadoParaCalculo[],
  ferias: FeriasParaCalculo[],
): ResultadoGrade {
  const blocos = grade.filter((g) => g.colaboradorId === colaboradorId);
  const porNivel: Record<number, number> = {};
  let totalHoras = 0;
  let diasLetivosTotais = 0;
  let diasComVT = 0;
  let diasDeFerias = 0;

  for (const { iso, weekday } of diasDoMes(mes)) {
    if (emFerias(ferias, colaboradorId, iso)) { diasDeFerias++; continue; }
    let trabalhouHoje = false;
    let temVTHoje = false;
    for (const g of blocos) {
      if (g.dataInicio && iso < g.dataInicio) continue;
      if (g.dataFim && iso > g.dataFim) continue;
      const dias = CODIGO_DIAS_SEMANA[g.codigo] || [];
      if (dias.includes(weekday) && !feriadoExclui(feriados, iso, g.unidadeId)) {
        totalHoras += g.duracaoHoras;
        porNivel[g.nivel] = (porNivel[g.nivel] || 0) + g.duracaoHoras;
        trabalhouHoje = true;
        if (!g.semVt) temVTHoje = true;
      }
    }
    if (trabalhouHoje) diasLetivosTotais++;
    if (temVTHoje) diasComVT++;
  }

  return { totalHoras, porNivel, diasLetivosTotais, diasComVT, diasDeFerias, temGrade: blocos.length > 0 };
}

/** Espelha o calc() de um lançamento usado no Extrato/Compilado (Fase 2), agora do lado do servidor. */
export function calcLancamentoValor(
  l: { tipo: TipoLancamentoFolha; nivel: number; horas: number; usaVt: boolean },
  colaboradorTipo: TipoColaboradorFolha,
  valores: ValorParaCalculo[],
): { valorHoras: number; valorVt: number; total: number } {
  const v = valores.find((x) => x.tipo === colaboradorTipo && x.nivel === l.nivel) || { valorHora: 0, valorVt: 0 };
  const valorHoras = (l.horas || 0) * v.valorHora;
  const isAusencia = l.tipo === "AUSENCIA" || l.tipo === "AUSENCIA_ATESTADO";
  const valorVt = l.usaVt && !isAusencia ? v.valorVt : 0;
  let total = 0;
  switch (l.tipo) {
    case "COMPETICAO": total = 90; break;
    case "COMPETICAO_PSICOLOGA": total = 40; break;
    case "DESCONTO_VT": total = -(l.horas || 0) * v.valorVt; break;
    case "BONUS": total = 25; break;
    case "BANCO_HORAS_COMPENSADO": total = 0; break;
    case "EXTRA": total = valorHoras + valorVt; break;
    case "AUSENCIA_ATESTADO": total = 0; break;
    case "AUSENCIA": total = colaboradorTipo === "PROFESSOR" ? 0 : -valorHoras; break;
  }
  return { valorHoras, valorVt, total };
}

export type ResultadoFolhaColab = {
  temGrade: boolean;
  horasNoMes: number;
  horasPorNivel: Record<number, number>;
  diasLetivosTotais: number;
  diasDeFerias: number;
  faltasSem: number;
  diasTrabalhados: number | null;
  diasVTProximoMes: number | null;
  valorBruto: number;
  valorDiaria: number | null;
  diariasBonus: number;
};

/**
 * A conta inteira de um colaborador num mês: horas por nível já líquidas
 * de falta, dias trabalhados, VT antecipado (contado na grade do MÊS
 * SEGUINTE, zerado se ele já estiver desligado lá) e os valores em R$.
 */
export function folhaColabCalc(
  colaborador: ColaboradorParaCalculo,
  mes: string,
  grade: GradeParaCalculo[],
  feriados: FeriadoParaCalculo[],
  ferias: FeriasParaCalculo[],
  lancamentos: LancamentoParaCalculo[],
  valores: ValorParaCalculo[],
): ResultadoFolhaColab {
  const gradeMes = horasEsperadasGrade(colaborador.id, mes, grade, feriados, ferias);
  const seusMes = lancamentos.filter((l) => l.colaboradorId === colaborador.id && l.data.slice(0, 7) === mes);
  const faltasSem = seusMes.filter((l) => l.tipo === "AUSENCIA");
  const diasTrabalhados = gradeMes.temGrade ? Math.max(0, gradeMes.diasLetivosTotais - faltasSem.length) : null;

  const proxMes = gradeMes.temGrade ? proximoMes(mes) : null;
  const aindaAtivoProxMes = proxMes ? colaboradorAtivoNoMes(colaborador, proxMes) : false;
  const gradeProxMes = proxMes && aindaAtivoProxMes ? horasEsperadasGrade(colaborador.id, proxMes, grade, feriados, ferias) : null;
  const faltasProxMes = proxMes && aindaAtivoProxMes
    ? lancamentos.filter((l) => l.colaboradorId === colaborador.id && l.data.slice(0, 7) === proxMes && l.tipo === "AUSENCIA")
    : [];
  const diasVTProximoMes = gradeMes.temGrade
    ? (aindaAtivoProxMes ? Math.max(0, (gradeProxMes?.diasComVT ?? 0) - faltasProxMes.length) : 0)
    : null;

  const horasPorNivel: Record<number, number> = { ...gradeMes.porNivel };
  for (const l of faltasSem) horasPorNivel[l.nivel] = (horasPorNivel[l.nivel] || 0) - (l.horas || 0);
  for (const nivel of Object.keys(horasPorNivel).map(Number)) {
    if (horasPorNivel[nivel] < 0) horasPorNivel[nivel] = 0;
  }

  let valorBruto = 0;
  for (const [nivelStr, horas] of Object.entries(gradeMes.porNivel)) {
    const v = valores.find((x) => x.tipo === colaborador.tipo && x.nivel === Number(nivelStr));
    valorBruto += horas * (v?.valorHora || 0);
  }
  const valorFaltas = faltasSem.reduce((s, l) => s + calcLancamentoValor(l, colaborador.tipo, valores).total, 0);
  const descontosVT = seusMes
    .filter((l) => l.tipo === "DESCONTO_VT")
    .reduce((s, l) => s + calcLancamentoValor(l, colaborador.tipo, valores).total, 0);
  const valorDiaria = gradeMes.temGrade ? valorBruto + valorFaltas + descontosVT : null;

  const diariasBonus = seusMes
    .filter((l) => l.tipo === "EXTRA" || l.tipo === "BONUS" || l.tipo === "COMPETICAO" || l.tipo === "COMPETICAO_PSICOLOGA")
    .reduce((s, l) => s + calcLancamentoValor(l, colaborador.tipo, valores).total, 0);

  return {
    temGrade: gradeMes.temGrade,
    horasNoMes: gradeMes.totalHoras,
    horasPorNivel,
    diasLetivosTotais: gradeMes.diasLetivosTotais,
    diasDeFerias: gradeMes.diasDeFerias,
    faltasSem: faltasSem.length,
    diasTrabalhados,
    diasVTProximoMes,
    valorBruto,
    valorDiaria,
    diariasBonus,
  };
}

const CAMPOS_OVERRIDE = ["bolsa", "complementar", "vt", "hn1", "hn2", "dias", "diariaBonus"] as const;
type CampoOverride = (typeof CAMPOS_OVERRIDE)[number];

function overrideValor(
  overrides: { mes: string; colaboradorId: string; campo: string; valor: number }[],
  mes: string, colaboradorId: string, campo: CampoOverride, calculado: number,
): { valor: number; sobrescrito: boolean } {
  const o = overrides.find((x) => x.mes === mes && x.colaboradorId === colaboradorId && x.campo === campo);
  return o ? { valor: o.valor, sobrescrito: true } : { valor: calculado, sobrescrito: false };
}

export async function folhaRoutes(app: FastifyInstance) {
  const somenteSocios = { preHandler: [app.exigirPapel("SOCIO")] };

  // ----------------------------------------------------------- colaboradores
  //
  // A lista já vem com o `professor` embutido (nome, e-mail, telefone, ativo,
  // desligamento e os documentos) — a tela não faz uma segunda chamada pra
  // montar isso.
  const PROFESSOR_SELECT_FOLHA = {
    nome: true, email: true, telefone: true, ativo: true, dataDesligamento: true,
    cpf: true, rg: true, dataNascimento: true,
  } as const;

  app.get("/folha/colaboradores", somenteSocios, async () =>
    prisma.colaboradorFolha.findMany({
      include: { professor: { select: PROFESSOR_SELECT_FOLHA } },
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
      select: { id: true, ...PROFESSOR_SELECT_FOLHA },
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
        cref: d.cref || null,
        chavePix: d.chavePix || null,
      },
      include: { professor: { select: PROFESSOR_SELECT_FOLHA } },
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
      data: {
        tipo: d.tipo, nivel: d.nivel, categoriaFolha: d.categoriaFolha || null,
        cref: d.cref || null, chavePix: d.chavePix || null,
      },
      include: { professor: { select: PROFESSOR_SELECT_FOLHA } },
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

  // -------------------------------------------------------------- feriados
  const feriadoSchema = z.object({
    data: dataIso,
    // ausente/"" = vale para todas as unidades.
    unidadeId: z.union([z.string().uuid(), z.literal("")]).optional(),
    descricao: z.string().max(200).optional(),
    contaTrabalhado: z.boolean().default(false),
  });

  app.get("/folha/feriados", somenteSocios, async () =>
    prisma.feriadoFolha.findMany({ include: { unidade: { select: { nome: true } } }, orderBy: { data: "asc" } }));

  app.post("/folha/feriados", somenteSocios, async (request, reply) => {
    const d = feriadoSchema.parse(request.body);
    const feriado = await prisma.feriadoFolha.create({
      data: {
        data: dataOpcional(d.data)!,
        unidadeId: d.unidadeId || null,
        descricao: d.descricao || null,
        contaTrabalhado: d.contaTrabalhado,
      },
      include: { unidade: { select: { nome: true } } },
    });
    return reply.code(201).send(feriado);
  });

  app.delete("/folha/feriados/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.feriadoFolha.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- férias
  //
  // Enquanto a pessoa está de férias, os dias da grade dela nesse período
  // não contam como trabalhados nem geram desconto — ficam fora da Folha
  // (pagas à parte, fora deste controle).
  const feriasSchema = z.object({
    colaboradorId: z.string().uuid("Escolha o colaborador."),
    dataInicio: dataIso,
    dataFim: dataIso,
    observacao: z.string().max(300).optional(),
  });

  app.get("/folha/ferias", somenteSocios, async () =>
    prisma.feriasFolha.findMany({ orderBy: { dataInicio: "asc" } }));

  app.post("/folha/ferias", somenteSocios, async (request, reply) => {
    const d = feriasSchema.parse(request.body);
    if (d.dataInicio > d.dataFim) return reply.code(400).send({ message: 'O "Início" não pode ser depois do "Fim".' });

    const colaborador = await prisma.colaboradorFolha.findUnique({ where: { id: d.colaboradorId } });
    if (!colaborador) return reply.code(404).send({ message: "Colaborador não encontrado." });

    const ferias = await prisma.feriasFolha.create({
      data: {
        colaboradorId: d.colaboradorId,
        dataInicio: dataOpcional(d.dataInicio)!,
        dataFim: dataOpcional(d.dataFim)!,
        observacao: d.observacao || null,
      },
    });
    return reply.code(201).send(ferias);
  });

  app.delete("/folha/ferias/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.feriasFolha.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ overrides
  //
  // Correção manual de um número calculado da Folha — existe, se existir,
  // do jeito que foi corrigido; apagar a linha volta o cálculo automático.
  const overrideSchema = z.object({
    mes: z.string().regex(/^\d{4}-\d{2}$/, "Informe o mês como AAAA-MM."),
    colaboradorId: z.string().uuid(),
    campo: z.enum(CAMPOS_OVERRIDE),
    valor: z.number(),
  });

  app.put("/folha/overrides", somenteSocios, async (request) => {
    const d = overrideSchema.parse(request.body);
    return prisma.folhaOverride.upsert({
      where: { mes_colaboradorId_campo: { mes: d.mes, colaboradorId: d.colaboradorId, campo: d.campo } },
      create: d,
      update: { valor: d.valor },
    });
  });

  const overrideParams = z.object({
    mes: z.string().regex(/^\d{4}-\d{2}$/),
    colaboradorId: z.string().uuid(),
    campo: z.string(),
  });

  app.delete("/folha/overrides/:mes/:colaboradorId/:campo", somenteSocios, async (request, reply) => {
    const d = overrideParams.parse(request.params);
    await prisma.folhaOverride.delete({ where: { mes_colaboradorId_campo: d } }).catch(() => null);
    return reply.code(204).send();
  });

  // ------------------------------------------------- dados para os cálculos
  //
  // Base compartilhada por Folha de Pagamento e Controle Interno — o
  // dataset é pequeno (dezenas de colaboradores, centenas de lançamentos),
  // então carrega tudo e deixa a conta pras funções puras acima.
  async function carregarDadosParaCalculo() {
    const [colaboradoresRaw, gradeRaw, feriadosRaw, feriasRaw, lancamentosRaw, valoresRaw] = await Promise.all([
      prisma.colaboradorFolha.findMany({
        include: { professor: { select: { nome: true, ativo: true, dataDesligamento: true } } },
      }),
      prisma.gradeHorariaFolha.findMany(),
      prisma.feriadoFolha.findMany(),
      prisma.feriasFolha.findMany(),
      prisma.lancamentoFolha.findMany(),
      prisma.valorFolha.findMany(),
    ]);

    const colaboradores: ColaboradorParaCalculo[] = colaboradoresRaw.map((c) => ({
      id: c.id, tipo: c.tipo, ativo: c.professor.ativo,
      dataDesligamento: c.professor.dataDesligamento ? c.professor.dataDesligamento.toISOString().slice(0, 10) : null,
    }));
    const grade: GradeParaCalculo[] = gradeRaw.map((g) => ({
      colaboradorId: g.colaboradorId, unidadeId: g.unidadeId, codigo: g.codigo,
      duracaoHoras: Number(g.duracaoHoras), nivel: g.nivel, semVt: g.semVt,
      dataInicio: g.dataInicio ? g.dataInicio.toISOString().slice(0, 10) : null,
      dataFim: g.dataFim ? g.dataFim.toISOString().slice(0, 10) : null,
    }));
    const feriados: FeriadoParaCalculo[] = feriadosRaw.map((f) => ({
      data: f.data.toISOString().slice(0, 10), unidadeId: f.unidadeId, contaTrabalhado: f.contaTrabalhado,
    }));
    const ferias: FeriasParaCalculo[] = feriasRaw.map((f) => ({
      colaboradorId: f.colaboradorId,
      dataInicio: f.dataInicio.toISOString().slice(0, 10),
      dataFim: f.dataFim.toISOString().slice(0, 10),
    }));
    const lancamentos: LancamentoParaCalculo[] = lancamentosRaw.map((l) => ({
      colaboradorId: l.colaboradorId, data: l.data.toISOString().slice(0, 10), tipo: l.tipo,
      nivel: l.nivel, horas: Number(l.horas), usaVt: l.usaVt,
    }));
    const valores: ValorParaCalculo[] = valoresRaw.map((v) => ({
      tipo: v.tipo, nivel: v.nivel, valorHora: Number(v.valorHora), valorVt: Number(v.valorVt),
    }));

    return { colaboradoresRaw, colaboradores, grade, feriados, ferias, lancamentos, valores };
  }

  const mesQuery = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/, "Informe o mês como AAAA-MM.") });

  // ----------------------------------------------------- folha de pagamento
  app.get("/folha/pagamento", somenteSocios, async (request) => {
    const { mes } = mesQuery.parse(request.query);
    const proxMes = proximoMes(mes);
    const { colaboradoresRaw, colaboradores, grade, feriados, ferias, lancamentos, valores } = await carregarDadosParaCalculo();
    const overridesRaw = await prisma.folhaOverride.findMany({ where: { mes } });
    const overrides = overridesRaw.map((o) => ({ ...o, valor: Number(o.valor) }));

    const linhaBase = (raw: (typeof colaboradoresRaw)[number]) => {
      const cc = colaboradores.find((x) => x.id === raw.id)!;
      const r = folhaColabCalc(cc, mes, grade, feriados, ferias, lancamentos, valores);
      return { raw, r };
    };

    const doMesCategoria = (raw: (typeof colaboradoresRaw)[number], categoria: CategoriaFolha) => {
      const cc = colaboradores.find((x) => x.id === raw.id)!;
      return colaboradorAtivoNoMes(cc, mes) && (raw.categoriaFolha || raw.tipo) === categoria;
    };

    const estagiarios = colaboradoresRaw
      .filter((c) => doMesCategoria(c, "ESTAGIARIO"))
      .sort((a, b) => a.professor.nome.localeCompare(b.professor.nome, "pt-BR"))
      .map((raw) => {
        const { r } = linhaBase(raw);
        if (!r.temGrade) return { colaboradorId: raw.id, nome: raw.professor.nome, temGrade: false as const };
        const bolsa = overrideValor(overrides, mes, raw.id, "bolsa", r.valorDiaria ?? 0);
        const complementar = overrideValor(overrides, mes, raw.id, "complementar", r.diariasBonus);
        const vt = overrideValor(overrides, mes, raw.id, "vt", r.diasVTProximoMes ?? 0);
        return {
          colaboradorId: raw.id, nome: raw.professor.nome, temGrade: true as const,
          bolsa: bolsa.valor, bolsaCalculada: r.valorDiaria ?? 0, bolsaSobrescrita: bolsa.sobrescrito,
          complementar: complementar.valor, complementarCalculada: r.diariasBonus, complementarSobrescrita: complementar.sobrescrito,
          vt: vt.valor, vtCalculado: r.diasVTProximoMes ?? 0, vtSobrescrito: vt.sobrescrito,
        };
      });

    const professores = colaboradoresRaw
      .filter((c) => doMesCategoria(c, "PROFESSOR"))
      .sort((a, b) => a.professor.nome.localeCompare(b.professor.nome, "pt-BR"))
      .map((raw) => {
        const { r } = linhaBase(raw);
        if (!r.temGrade) return { colaboradorId: raw.id, nome: raw.professor.nome, temGrade: false as const };
        const hn1Calc = r.horasPorNivel[1] || 0;
        const hn2Calc = r.horasPorNivel[2] || 0;
        const hn1 = overrideValor(overrides, mes, raw.id, "hn1", hn1Calc);
        const hn2 = overrideValor(overrides, mes, raw.id, "hn2", hn2Calc);
        const dias = overrideValor(overrides, mes, raw.id, "dias", r.diasTrabalhados ?? 0);
        const vt = overrideValor(overrides, mes, raw.id, "vt", r.diasVTProximoMes ?? 0);
        const diariaBonus = overrideValor(overrides, mes, raw.id, "diariaBonus", r.diariasBonus);
        return {
          colaboradorId: raw.id, nome: raw.professor.nome, temGrade: true as const,
          hn1: hn1.valor, hn1Calculado: hn1Calc, hn1Sobrescrito: hn1.sobrescrito,
          hn2: hn2.valor, hn2Calculado: hn2Calc, hn2Sobrescrito: hn2.sobrescrito,
          dias: dias.valor, diasCalculado: r.diasTrabalhados ?? 0, diasSobrescrito: dias.sobrescrito,
          vt: vt.valor, vtCalculado: r.diasVTProximoMes ?? 0, vtSobrescrito: vt.sobrescrito,
          diariaBonus: diariaBonus.valor, diariaBonusCalculado: r.diariasBonus, diariaBonusSobrescrito: diariaBonus.sobrescrito,
        };
      });

    const valorHoraNivel1 = valores.find((v) => v.tipo === "PROFESSOR" && v.nivel === 1)?.valorHora ?? null;
    const valorHoraNivel2 = valores.find((v) => v.tipo === "PROFESSOR" && v.nivel === 2)?.valorHora ?? null;

    return { mes, proxMes, valorHoraNivel1, valorHoraNivel2, estagiarios, professores };
  });

  // ------------------------------------------------------- controle interno
  app.get("/folha/controle-interno", somenteSocios, async (request) => {
    const { mes } = mesQuery.parse(request.query);
    const proxMes = proximoMes(mes);
    const { colaboradoresRaw, colaboradores, grade, feriados, ferias, lancamentos, valores } = await carregarDadosParaCalculo();

    const linhas = colaboradoresRaw
      .filter((raw) => colaboradorAtivoNoMes(colaboradores.find((x) => x.id === raw.id)!, mes))
      .sort((a, b) => a.professor.nome.localeCompare(b.professor.nome, "pt-BR"))
      .map((raw) => {
        const cc = colaboradores.find((x) => x.id === raw.id)!;
        const r = folhaColabCalc(cc, mes, grade, feriados, ferias, lancamentos, valores);
        if (!r.temGrade) return { colaboradorId: raw.id, nome: raw.professor.nome, tipo: raw.tipo, temGrade: false as const };

        const niveis = Object.entries(r.horasPorNivel).filter(([, h]) => h > 0).map(([n]) => Number(n)).sort();
        const rhMedio = r.horasNoMes > 0 ? r.valorBruto / r.horasNoMes : 0;
        const valorVtNivel1 = valores.find((v) => v.tipo === raw.tipo && v.nivel === 1)?.valorVt ?? 0;
        const vtRs = (r.diasVTProximoMes || 0) * valorVtNivel1;
        const total = (r.valorDiaria || 0) + r.diariasBonus + vtRs;

        return {
          colaboradorId: raw.id, nome: raw.professor.nome, tipo: raw.tipo, temGrade: true as const,
          niveis, horasNoMes: r.horasNoMes, rhMedio,
          valorBase: r.valorDiaria || 0, diariasBonus: r.diariasBonus,
          diasVt: r.diasVTProximoMes || 0, vtRs, diasFerias: r.diasDeFerias, total,
        };
      });

    return { mes, proxMes, linhas };
  });
}
