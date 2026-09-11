import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TipoCategoriaFinanceira } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Financeiro — extrato bancário, categorização e DRE (Fase 5 da
 * reconstrução da plataforma de Folha/Financeiro que existia à parte).
 *
 * Deliberadamente menor que o sistema original: aquele tinha 19 tabelas
 * (contas a pagar, contas recorrentes, recebíveis, conciliação linha a
 * linha, projeções). Aqui entra só o que sustenta "o que entrou/saiu,
 * classificado, vira um DRE por mês" — ver o comentário no schema.prisma
 * sobre o porquê do corte.
 *
 * Mora na aba Financeiro, dentro da área da Diretoria — dinheiro de
 * verdade, não é operação do dia a dia da escola.
 */

const idParams = z.object({ id: z.string().uuid() });

// ============================================================================
// Funções puras — a parte arriscada de errar sem ninguém perceber. Testadas
// isoladas em tests/financeiro.test.ts.
// ============================================================================

/** Sem acento, minúsculo, espaços colapsados — a mesma forma usada tanto pro hash de dedup quanto pra bater regra de categorização. */
export function normalizarTexto(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Chave de deduplicação: colar o mesmo extrato duas vezes (mesma conta) não duplica nada. */
export function gerarHashLinha(data: string, valor: number, descricao: string): string {
  return `${data}|${valor.toFixed(2)}|${normalizarTexto(descricao)}`;
}

export type RegraParaAplicar = {
  padrao: string;
  categoriaId: string;
  centroCustoId: string | null;
  ordem: number;
};

/**
 * A primeira regra (por `ordem`) cujo padrão aparece dentro da descrição
 * classifica a transação sozinha. Não é regex de propósito — "contém tal
 * palavra" é o que dá pra revisar de olho sem virar campo minado.
 */
export function aplicarRegra(
  descricao: string,
  regras: RegraParaAplicar[],
): { categoriaId: string; centroCustoId: string | null } | null {
  const alvo = normalizarTexto(descricao);
  const ordenadas = [...regras].sort((a, b) => a.ordem - b.ordem);
  for (const r of ordenadas) {
    const padrao = normalizarTexto(r.padrao);
    if (padrao && alvo.includes(padrao)) {
      return { categoriaId: r.categoriaId, centroCustoId: r.centroCustoId };
    }
  }
  return null;
}

/**
 * "07/08/2026", "2026-08-07" ou variações com "-" — mesmas variações que o
 * lote de lançamentos da Folha aceita.
 */
export function parseDataFlexivelFin(str: string): string | null {
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

/** "1.234,56" (BR), "-50,00" ou "50.00" (já americano) — o que sai ao colar de uma planilha ou de um extrato de banco. */
export function parseValorFlexivel(str: string): number | null {
  const limpo = (str || "").trim().replace(/[^\d,.\-]/g, "");
  if (!limpo) return null;
  let normalizado = limpo;
  if (limpo.includes(",") && limpo.includes(".")) {
    normalizado = limpo.replace(/\./g, "").replace(",", ".");
  } else if (limpo.includes(",")) {
    normalizado = limpo.replace(",", ".");
  }
  const v = parseFloat(normalizado);
  return Number.isNaN(v) ? null : v;
}

/** Tab ou ; — não "," de propósito: colidiria com "1.234,56" no meio da própria coluna de valor. */
export function splitLinhaExtrato(linha: string): string[] {
  const partes = linha.includes("\t") ? linha.split("\t") : linha.split(";");
  return partes.map((p) => p.trim());
}

export type CategoriaParaDre = {
  id: string;
  tipo: TipoCategoriaFinanceira;
  grupoDre: string;
  ordem: number;
};
export type LinhaDre = { grupoDre: string; tipo: TipoCategoriaFinanceira; total: number; ordem: number };
export type ResultadoDre = { linhas: LinhaDre[]; totalReceitas: number; totalDespesas: number; resultado: number };

/**
 * Agrupa as transações classificadas pela linha do DRE da categoria
 * (`grupoDre`) e soma. `valor` já carrega o sinal do banco (entrada
 * positiva, saída negativa) — o resultado nunca discorda do extrato, mesmo
 * que uma categoria esteja marcada com o tipo "errado" (ex.: um estorno de
 * despesa com valor positivo continua entrando na soma daquela categoria).
 */
export function calcularDre(
  transacoes: { valor: number; categoriaId: string | null }[],
  categorias: CategoriaParaDre[],
): ResultadoDre {
  const porId = new Map(categorias.map((c) => [c.id, c]));
  const porGrupo = new Map<string, LinhaDre>();
  let totalReceitas = 0;
  let totalDespesas = 0;

  for (const t of transacoes) {
    if (!t.categoriaId) continue;
    const cat = porId.get(t.categoriaId);
    if (!cat) continue;
    const linha = porGrupo.get(cat.grupoDre) ?? { grupoDre: cat.grupoDre, tipo: cat.tipo, total: 0, ordem: cat.ordem };
    linha.total += t.valor;
    porGrupo.set(cat.grupoDre, linha);
    if (cat.tipo === "RECEITA") totalReceitas += t.valor;
    else totalDespesas += t.valor;
  }

  const linhas = [...porGrupo.values()].sort((a, b) => a.ordem - b.ordem || a.grupoDre.localeCompare(b.grupoDre, "pt-BR"));
  return { linhas, totalReceitas, totalDespesas, resultado: totalReceitas + totalDespesas };
}

// ============================================================================
// Schemas
// ============================================================================

const contaSchema = z.object({
  nome: z.string().trim().min(1, "Nome é obrigatório.").max(120),
  banco: z.string().max(80).optional(),
  agencia: z.string().max(20).optional(),
  conta: z.string().max(30).optional(),
  saldoInicial: z.number().default(0),
  ativa: z.boolean().default(true),
});

const categoriaSchema = z.object({
  nome: z.string().trim().min(1, "Nome é obrigatório.").max(120),
  tipo: z.enum(["RECEITA", "DESPESA"]),
  grupoDre: z.string().trim().min(1, "Escolha a linha do DRE.").max(120),
  ordem: z.number().int().default(0),
  ativa: z.boolean().default(true),
});

const centroCustoSchema = z.object({
  nome: z.string().trim().min(1, "Nome é obrigatório.").max(120),
  unidadeId: z.union([z.string().uuid(), z.literal("")]).optional(),
  ativo: z.boolean().default(true),
});

const regraSchema = z.object({
  padrao: z.string().trim().min(1, "Escreva o que deve aparecer na descrição.").max(200),
  categoriaId: z.string().uuid("Escolha a categoria."),
  centroCustoId: z.union([z.string().uuid(), z.literal("")]).optional(),
  ordem: z.number().int().default(0),
});

const importarSchema = z.object({
  contaId: z.string().uuid(),
  texto: z.string().min(1, "Cole ao menos uma linha."),
});

const classificarSchema = z.object({
  categoriaId: z.union([z.string().uuid(), z.literal("")]).optional(),
  centroCustoId: z.union([z.string().uuid(), z.literal("")]).optional(),
  unidadeId: z.union([z.string().uuid(), z.literal("")]).optional(),
  colaboradorId: z.union([z.string().uuid(), z.literal("")]).optional(),
  observacao: z.string().max(500).optional(),
});

const mesQuery = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/, "Informe o mês como AAAA-MM.") });

export async function financeiroRoutes(app: FastifyInstance) {
  const somenteSocios = { preHandler: [app.exigirPapel("SOCIO")] };

  // ------------------------------------------------------- contas bancárias
  app.get("/financeiro/contas", somenteSocios, async () =>
    prisma.contaBancaria.findMany({ orderBy: { nome: "asc" } }));

  app.post("/financeiro/contas", somenteSocios, async (request, reply) => {
    const d = contaSchema.parse(request.body);
    const conta = await prisma.contaBancaria.create({ data: d });
    return reply.code(201).send(conta);
  });

  app.put("/financeiro/contas/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const d = contaSchema.parse(request.body);
    const existe = await prisma.contaBancaria.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Conta não encontrada." });
    return prisma.contaBancaria.update({ where: { id }, data: d });
  });

  // ------------------------------------------------------------ categorias
  app.get("/financeiro/categorias", somenteSocios, async () =>
    prisma.categoriaFinanceira.findMany({ orderBy: [{ tipo: "asc" }, { ordem: "asc" }, { nome: "asc" }] }));

  app.post("/financeiro/categorias", somenteSocios, async (request, reply) => {
    const d = categoriaSchema.parse(request.body);
    const categoria = await prisma.categoriaFinanceira.create({ data: d });
    return reply.code(201).send(categoria);
  });

  app.put("/financeiro/categorias/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const d = categoriaSchema.parse(request.body);
    const existe = await prisma.categoriaFinanceira.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Categoria não encontrada." });
    return prisma.categoriaFinanceira.update({ where: { id }, data: d });
  });

  // --------------------------------------------------------- centro de custo
  app.get("/financeiro/centros-custo", somenteSocios, async () =>
    prisma.centroCusto.findMany({
      include: { unidade: { select: { nome: true } } },
      orderBy: { nome: "asc" },
    }));

  app.post("/financeiro/centros-custo", somenteSocios, async (request, reply) => {
    const d = centroCustoSchema.parse(request.body);
    const centro = await prisma.centroCusto.create({
      data: { nome: d.nome, unidadeId: d.unidadeId || null, ativo: d.ativo },
      include: { unidade: { select: { nome: true } } },
    });
    return reply.code(201).send(centro);
  });

  app.put("/financeiro/centros-custo/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const d = centroCustoSchema.parse(request.body);
    const existe = await prisma.centroCusto.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Centro de custo não encontrado." });
    return prisma.centroCusto.update({
      where: { id },
      data: { nome: d.nome, unidadeId: d.unidadeId || null, ativo: d.ativo },
      include: { unidade: { select: { nome: true } } },
    });
  });

  // ------------------------------------------------- regras de categorização
  app.get("/financeiro/regras", somenteSocios, async () =>
    prisma.regraCategorizacaoFinanceira.findMany({
      include: { categoria: { select: { nome: true } }, centroCusto: { select: { nome: true } } },
      orderBy: { ordem: "asc" },
    }));

  app.post("/financeiro/regras", somenteSocios, async (request, reply) => {
    const d = regraSchema.parse(request.body);
    const regra = await prisma.regraCategorizacaoFinanceira.create({
      data: { padrao: d.padrao, categoriaId: d.categoriaId, centroCustoId: d.centroCustoId || null, ordem: d.ordem },
      include: { categoria: { select: { nome: true } }, centroCusto: { select: { nome: true } } },
    });
    return reply.code(201).send(regra);
  });

  app.delete("/financeiro/regras/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.regraCategorizacaoFinanceira.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------- extrato
  //
  // Colar o mesmo extrato duas vezes não duplica nada — a chave de dedup
  // (data + valor + descrição normalizada) é conferida contra o que já
  // existe NAQUELA conta antes de gravar. Uma regra de categorização que bate
  // já classifica a linha na hora; o resto entra como PENDENTE pra revisão.
  app.post("/financeiro/transacoes/importar", somenteSocios, async (request, reply) => {
    const { contaId, texto } = importarSchema.parse(request.body);
    const conta = await prisma.contaBancaria.findUnique({ where: { id: contaId } });
    if (!conta) return reply.code(404).send({ message: "Conta bancária não encontrada." });

    const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let corpo = linhas;
    const primeiraCols = linhas[0] ? splitLinhaExtrato(linhas[0]) : [];
    if (primeiraCols[0] && /^data$/i.test(primeiraCols[0])) corpo = linhas.slice(1);
    if (!corpo.length) return reply.code(400).send({ message: "Nenhuma linha de dados encontrada." });

    const regras = await prisma.regraCategorizacaoFinanceira.findMany();
    const existentes = new Set(
      (await prisma.transacaoFinanceira.findMany({ where: { contaId }, select: { hashLinha: true } }))
        .map((t) => t.hashLinha),
    );

    const validas: {
      contaId: string; data: Date; valor: number; descricao: string;
      categoriaId: string | null; centroCustoId: string | null;
      status: "PENDENTE" | "CLASSIFICADA"; hashLinha: string;
    }[] = [];
    const duplicadas: { linha: number; texto: string }[] = [];
    const erros: { linha: number; texto: string; motivo: string }[] = [];

    corpo.forEach((linha, i) => {
      const [dataRaw, valorRaw, ...descPartes] = splitLinhaExtrato(linha);
      const descricao = descPartes.join(" ").trim();
      const dataIsoStr = parseDataFlexivelFin(dataRaw);
      const valor = parseValorFlexivel(valorRaw);

      const problemas: string[] = [];
      if (!dataIsoStr) problemas.push("data inválida");
      if (valor === null || valor === 0) problemas.push("valor inválido ou zero");
      if (!descricao) problemas.push("descrição em branco");
      if (problemas.length) { erros.push({ linha: i + 1, texto: linha, motivo: problemas.join("; ") }); return; }

      const hashLinha = gerarHashLinha(dataIsoStr!, valor!, descricao);
      if (existentes.has(hashLinha)) { duplicadas.push({ linha: i + 1, texto: linha }); return; }
      existentes.add(hashLinha);

      const classificacao = aplicarRegra(descricao, regras);
      validas.push({
        contaId, data: new Date(`${dataIsoStr}T00:00:00.000Z`), valor: valor!, descricao,
        categoriaId: classificacao?.categoriaId ?? null,
        centroCustoId: classificacao?.centroCustoId ?? null,
        status: classificacao ? "CLASSIFICADA" : "PENDENTE",
        hashLinha,
      });
    });

    if (validas.length) await prisma.transacaoFinanceira.createMany({ data: validas });
    return { inseridas: validas.length, duplicadas: duplicadas.length, erros };
  });

  app.get("/financeiro/transacoes", somenteSocios, async (request) => {
    const { mes, contaId, status } = z
      .object({
        mes: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        contaId: z.string().uuid().optional(),
        status: z.enum(["PENDENTE", "CLASSIFICADA"]).optional(),
      })
      .parse(request.query);

    return prisma.transacaoFinanceira.findMany({
      where: {
        ...(contaId ? { contaId } : {}),
        ...(status ? { status } : {}),
        ...(mes ? { data: { gte: new Date(`${mes}-01T00:00:00.000Z`), lt: new Date(`${proximoMesFin(mes)}-01T00:00:00.000Z`) } } : {}),
      },
      include: {
        conta: { select: { nome: true } },
        categoria: { select: { nome: true, tipo: true, grupoDre: true } },
        centroCusto: { select: { nome: true } },
        unidade: { select: { nome: true } },
        colaborador: { select: { professor: { select: { nome: true } } } },
      },
      orderBy: { data: "desc" },
    });
  });

  app.put("/financeiro/transacoes/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const d = classificarSchema.parse(request.body);
    const existe = await prisma.transacaoFinanceira.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Transação não encontrada." });

    return prisma.transacaoFinanceira.update({
      where: { id },
      data: {
        categoriaId: d.categoriaId || null,
        centroCustoId: d.centroCustoId || null,
        unidadeId: d.unidadeId || null,
        colaboradorId: d.colaboradorId || null,
        observacao: d.observacao || null,
        status: d.categoriaId ? "CLASSIFICADA" : "PENDENTE",
      },
      include: {
        conta: { select: { nome: true } },
        categoria: { select: { nome: true, tipo: true, grupoDre: true } },
        centroCusto: { select: { nome: true } },
        unidade: { select: { nome: true } },
        colaborador: { select: { professor: { select: { nome: true } } } },
      },
    });
  });

  app.delete("/financeiro/transacoes/:id", somenteSocios, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.transacaoFinanceira.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------- DRE
  app.get("/financeiro/dre", somenteSocios, async (request) => {
    const { mes } = mesQuery.parse(request.query);
    const proxMes = proximoMesFin(mes);

    const [transacoesRaw, categorias] = await Promise.all([
      prisma.transacaoFinanceira.findMany({
        where: { data: { gte: new Date(`${mes}-01T00:00:00.000Z`), lt: new Date(`${proxMes}-01T00:00:00.000Z`) } },
        select: { valor: true, categoriaId: true },
      }),
      prisma.categoriaFinanceira.findMany({ select: { id: true, tipo: true, grupoDre: true, ordem: true } }),
    ]);

    const transacoes = transacoesRaw.map((t) => ({ valor: Number(t.valor), categoriaId: t.categoriaId }));
    const dre = calcularDre(transacoes, categorias);
    const naoClassificadas = transacoesRaw.filter((t) => !t.categoriaId).length;

    return { mes, ...dre, naoClassificadas };
  });
}

function proximoMesFin(mes: string): string {
  const [ano, m] = mes.split("-").map(Number);
  const d = new Date(Date.UTC(ano, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
