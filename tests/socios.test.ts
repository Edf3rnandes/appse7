import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusMatricula } from "@prisma/client";
import {
  ativaEm,
  saidaDe,
  ultimosMeses,
  type MatriculaParaConta,
} from "../src/modules/socios/socios.routes.js";
import { papeisEfetivos } from "../src/plugins/auth.js";

/**
 * As contas do painel dos sócios.
 *
 * Testadas como funções puras, sem banco: o risco aqui não é a tela quebrar —
 * é ela abrir com um número errado que parece plausível. Um sócio olha
 * "receita prevista" e decide contratar professor; se a conta contar matrícula
 * cancelada, ninguém percebe até o caixa não fechar.
 */

const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

function matricula(over: Partial<MatriculaParaConta> = {}): MatriculaParaConta {
  return {
    status: StatusMatricula.CONFIRMADA,
    criadoEm: d("2026-01-10"),
    canceladaEm: null,
    arquivadoEm: null,
    expiraEm: null,
    atualizadoEm: d("2026-01-10"),
    unidade: { id: "u1", nome: "Bessa" },
    plano: { valor: 112.9, descontoPercentual: 0 },
    ...over,
  };
}

// Junho de 2026, fechado.
const INICIO = new Date(Date.UTC(2026, 5, 1));
const FIM = new Date(Date.UTC(2026, 6, 1) - 1);

describe("quem conta como ativo no mês", () => {
  it("conta a matrícula confirmada que já existia", () => {
    assert.equal(ativaEm(matricula(), FIM, INICIO), true);
  });

  it("não conta a que ainda não tinha sido criada", () => {
    assert.equal(ativaEm(matricula({ criadoEm: d("2026-08-02") }), FIM, INICIO), false);
  });

  it("conta a criada dentro do próprio mês", () => {
    assert.equal(ativaEm(matricula({ criadoEm: d("2026-06-20") }), FIM, INICIO), true);
  });

  it("não conta depois do cancelamento, mas conta no mês em que ele aconteceu", () => {
    // Cancelou em julho: junho ainda foi mês pago.
    assert.equal(ativaEm(matricula({ canceladaEm: d("2026-07-03") }), FIM, INICIO), true);
    // Cancelou em maio: junho não.
    assert.equal(ativaEm(matricula({ canceladaEm: d("2026-05-20") }), FIM, INICIO), false);
  });

  it("não conta pedido que o administrativo ainda não confirmou", () => {
    assert.equal(ativaEm(matricula({ status: StatusMatricula.CRIADA }), FIM, INICIO), false);
  });

  it("conta quem está com pagamento pendente", () => {
    // A vaga está ocupada e a mensalidade é devida: é receita prevista, mesmo
    // que ainda não tenha entrado. Quem responde por "entrou" é a aba Caixa.
    assert.equal(
      ativaEm(matricula({ status: StatusMatricula.PAGAMENTO_PENDENTE }), FIM, INICIO),
      true,
    );
  });

  it("para de contar depois que o plano venceu", () => {
    assert.equal(ativaEm(matricula({ expiraEm: d("2026-05-31") }), FIM, INICIO), false);
    assert.equal(ativaEm(matricula({ expiraEm: d("2026-06-15") }), FIM, INICIO), true);
  });

  it("não conta a arquivada", () => {
    assert.equal(ativaEm(matricula({ arquivadoEm: d("2026-04-01") }), FIM, INICIO), false);
  });
});

describe("quando a matrícula saiu", () => {
  it("usa a data de cancelamento quando ela existe", () => {
    const m = matricula({ canceladaEm: d("2026-03-05"), arquivadoEm: d("2026-04-05") });
    assert.equal(saidaDe(m)?.toISOString().slice(0, 10), "2026-03-05");
  });

  it("cai para o arquivamento quando não houve data de cancelamento", () => {
    const m = matricula({ arquivadoEm: d("2026-04-05") });
    assert.equal(saidaDe(m)?.toISOString().slice(0, 10), "2026-04-05");
  });

  it("cancelada sem data nenhuma ainda conta como saída", () => {
    // É o que a importação do Laravel vai produzir: lá cancelar apagava a
    // linha, então não há data. Sem este caso, uma matrícula cancelada
    // apareceria como ativa para sempre e inflaria a receita prevista.
    const m = matricula({ status: StatusMatricula.CANCELADA, atualizadoEm: d("2026-02-09") });
    assert.equal(saidaDe(m)?.toISOString().slice(0, 10), "2026-02-09");
    assert.equal(ativaEm(m, FIM, INICIO), false);
  });

  it("matrícula viva não tem saída", () => {
    assert.equal(saidaDe(matricula()), null);
  });
});

describe("janela de meses", () => {
  it("devolve a quantidade pedida, terminando no mês corrente", () => {
    const meses = ultimosMeses(6);
    assert.equal(meses.length, 6);
    assert.equal(meses[5].corrente, true);
    assert.equal(meses[0].corrente, false);
  });

  it("o fim de cada mês é o último instante dele, não o primeiro do seguinte", () => {
    // Um dia de diferença aqui move matrícula de um mês para o outro na série
    // inteira — o tipo de erro que ninguém enxerga olhando o gráfico.
    for (const m of ultimosMeses(4)) {
      assert.equal(m.fim.getUTCDate() >= 28, true, `fim de ${m.chave} caiu cedo demais`);
      assert.equal(m.inicio.getUTCDate(), 1);
      assert.equal(m.fim.getTime() - m.inicio.getTime() > 0, true);
    }
  });
});

describe("papel de sócio", () => {
  it("sócio vale como admin, sem precisar do papel de admin", () => {
    assert.deepEqual(papeisEfetivos(["SOCIO"]).sort(), ["ADMIN", "SOCIO"]);
  });

  it("administrativo não vira admin de graça", () => {
    assert.deepEqual(papeisEfetivos(["ADMINISTRATIVO"]), ["ADMINISTRATIVO"]);
  });

  it("quem não é sócio continua igual", () => {
    assert.deepEqual(papeisEfetivos(["PROFESSOR", "RESPONSAVEL"]), ["PROFESSOR", "RESPONSAVEL"]);
  });
});
