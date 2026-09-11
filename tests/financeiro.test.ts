import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aplicarRegra,
  calcularDre,
  gerarHashLinha,
  normalizarTexto,
  parseDataFlexivelFin,
  parseValorFlexivel,
  splitLinhaExtrato,
  type CategoriaParaDre,
  type RegraParaAplicar,
} from "../src/modules/socios/financeiro.routes.js";

/**
 * Financeiro: dinheiro de verdade sendo lido de um extrato bancário. O risco
 * aqui não é a tela quebrar — é importar um valor errado, categorizar a
 * linha errada, ou duplicar uma transação, e ninguém perceber até o DRE não
 * fechar. Cada regra tem seu próprio teste.
 */

describe("normalizarTexto", () => {
  it("tira acento, baixa caixa e colapsa espaço", () => {
    assert.equal(normalizarTexto("  Aluguel  Bessa  "), "aluguel bessa");
    assert.equal(normalizarTexto("Condomínio Alagoa Grande"), "condominio alagoa grande");
  });
});

describe("gerarHashLinha", () => {
  it("mesma data+valor+descrição gera o mesmo hash", () => {
    const a = gerarHashLinha("2026-09-05", -150.5, "Aluguel Bessa");
    const b = gerarHashLinha("2026-09-05", -150.5, "aluguel   bessa");
    assert.equal(a, b);
  });
  it("valor diferente gera hash diferente", () => {
    const a = gerarHashLinha("2026-09-05", -150.5, "Aluguel Bessa");
    const b = gerarHashLinha("2026-09-05", -150.51, "Aluguel Bessa");
    assert.notEqual(a, b);
  });
});

describe("parseDataFlexivelFin", () => {
  it("aceita AAAA-MM-DD", () => assert.equal(parseDataFlexivelFin("2026-9-5"), "2026-09-05"));
  it("aceita DD/MM/AAAA", () => assert.equal(parseDataFlexivelFin("05/09/2026"), "2026-09-05"));
  it("aceita ano com 2 dígitos", () => assert.equal(parseDataFlexivelFin("05/09/26"), "2026-09-05"));
  it("rejeita lixo", () => assert.equal(parseDataFlexivelFin("não é data"), null));
});

describe("parseValorFlexivel", () => {
  it("formato brasileiro com milhar", () => assert.equal(parseValorFlexivel("1.234,56"), 1234.56));
  it("negativo brasileiro", () => assert.equal(parseValorFlexivel("-150,50"), -150.5));
  it("já americano", () => assert.equal(parseValorFlexivel("150.50"), 150.5));
  it("com prefixo R$ e espaços", () => assert.equal(parseValorFlexivel("R$ 90,00"), 90));
  it("lixo vira null", () => assert.equal(parseValorFlexivel("abc"), null));
});

describe("splitLinhaExtrato", () => {
  it("separa por tab quando presente", () => {
    assert.deepEqual(splitLinhaExtrato("05/09/2026\t-150,00\tAluguel"), ["05/09/2026", "-150,00", "Aluguel"]);
  });
  it("separa por ; quando não há tab", () => {
    assert.deepEqual(splitLinhaExtrato("05/09/2026;-150,00;Aluguel"), ["05/09/2026", "-150,00", "Aluguel"]);
  });
  it("não separa por vírgula (colidiria com o valor)", () => {
    assert.deepEqual(splitLinhaExtrato("05/09/2026;1.234,56;Mensalidades"), ["05/09/2026", "1.234,56", "Mensalidades"]);
  });
});

describe("aplicarRegra", () => {
  const regras: RegraParaAplicar[] = [
    { padrao: "aluguel", categoriaId: "cat-aluguel", centroCustoId: null, ordem: 1 },
    { padrao: "energisa", categoriaId: "cat-energia", centroCustoId: "cc-bessa", ordem: 2 },
  ];
  it("bate pela substring, sem acento e sem caixa", () => {
    const r = aplicarRegra("PAGAMENTO ALUGUEL SETEMBRO", regras);
    assert.deepEqual(r, { categoriaId: "cat-aluguel", centroCustoId: null });
  });
  it("usa a de menor ordem quando mais de uma bate", () => {
    const duas: RegraParaAplicar[] = [
      { padrao: "pix", categoriaId: "cat-generico", centroCustoId: null, ordem: 5 },
      { padrao: "pix rafael", categoriaId: "cat-especifico", centroCustoId: null, ordem: 1 },
    ];
    const r = aplicarRegra("Transferência Pix Rafael Lima", duas);
    assert.equal(r?.categoriaId, "cat-especifico");
  });
  it("sem batida, devolve null", () => {
    assert.equal(aplicarRegra("Compra desconhecida", regras), null);
  });
});

describe("calcularDre", () => {
  const categorias: CategoriaParaDre[] = [
    { id: "cat-mensalidade", tipo: "RECEITA", grupoDre: "Mensalidades", ordem: 1 },
    { id: "cat-aluguel", tipo: "DESPESA", grupoDre: "Aluguel e Contas Fixas", ordem: 2 },
    { id: "cat-folha", tipo: "DESPESA", grupoDre: "Folha de Pagamento", ordem: 3 },
  ];

  it("agrupa por linha do DRE e soma mantendo o sinal do banco", () => {
    const transacoes = [
      { valor: 5000, categoriaId: "cat-mensalidade" },
      { valor: 1200, categoriaId: "cat-mensalidade" },
      { valor: -1500, categoriaId: "cat-aluguel" },
      { valor: -3000, categoriaId: "cat-folha" },
    ];
    const dre = calcularDre(transacoes, categorias);
    assert.equal(dre.linhas.find((l) => l.grupoDre === "Mensalidades")?.total, 6200);
    assert.equal(dre.linhas.find((l) => l.grupoDre === "Aluguel e Contas Fixas")?.total, -1500);
    assert.equal(dre.totalReceitas, 6200);
    assert.equal(dre.totalDespesas, -4500);
    assert.equal(dre.resultado, 1700);
  });

  it("transação sem categoria não entra na conta", () => {
    const dre = calcularDre([{ valor: 999, categoriaId: null }], categorias);
    assert.equal(dre.linhas.length, 0);
    assert.equal(dre.resultado, 0);
  });

  it("estorno de despesa com valor positivo ainda soma na categoria de despesa (não vira receita)", () => {
    const transacoes = [
      { valor: -3000, categoriaId: "cat-folha" },
      { valor: 200, categoriaId: "cat-folha" }, // estorno parcial
    ];
    const dre = calcularDre(transacoes, categorias);
    assert.equal(dre.linhas.find((l) => l.grupoDre === "Folha de Pagamento")?.total, -2800);
    assert.equal(dre.totalReceitas, 0);
    assert.equal(dre.totalDespesas, -2800);
  });

  it("linhas saem ordenadas pela ordem da categoria", () => {
    const transacoes = [
      { valor: -100, categoriaId: "cat-folha" },
      { valor: -100, categoriaId: "cat-aluguel" },
      { valor: 100, categoriaId: "cat-mensalidade" },
    ];
    const dre = calcularDre(transacoes, categorias);
    assert.deepEqual(dre.linhas.map((l) => l.grupoDre), ["Mensalidades", "Aluguel e Contas Fixas", "Folha de Pagamento"]);
  });
});
