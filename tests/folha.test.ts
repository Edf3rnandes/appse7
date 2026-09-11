import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calcLancamentoValor,
  colaboradorAtivoNoMes,
  emFerias,
  feriadoExclui,
  folhaColabCalc,
  horasEsperadasGrade,
  proximoMes,
  type ColaboradorParaCalculo,
  type FeriadoParaCalculo,
  type FeriasParaCalculo,
  type GradeParaCalculo,
  type LancamentoParaCalculo,
  type ValorParaCalculo,
} from "../src/modules/socios/folha.routes.js";

/**
 * A conta da Folha de Pagamento: horas esperadas pela grade, VT antecipado
 * (contado no mês SEGUINTE), faltas descontando por nível, feriado por
 * unidade e férias. O risco aqui não é a tela quebrar — é pagar errado sem
 * ninguém perceber, então cada regra tem seu próprio teste.
 */

const grade = (over: Partial<GradeParaCalculo> = {}): GradeParaCalculo => ({
  colaboradorId: "c1", unidadeId: "u1", codigo: "TQ", duracaoHoras: 2, nivel: 1, semVt: false,
  dataInicio: null, dataFim: null,
  ...over,
});

describe("proximoMes", () => {
  it("avança o mês normalmente", () => {
    assert.equal(proximoMes("2026-09"), "2026-10");
  });
  it("vira o ano em dezembro", () => {
    assert.equal(proximoMes("2026-12"), "2027-01");
  });
});

describe("feriadoExclui", () => {
  const feriados: FeriadoParaCalculo[] = [
    { data: "2026-09-08", unidadeId: "u1", contaTrabalhado: false },
    { data: "2026-09-09", unidadeId: null, contaTrabalhado: false },
    { data: "2026-09-10", unidadeId: "u1", contaTrabalhado: true },
  ];
  it("exclui feriado da própria unidade", () => {
    assert.equal(feriadoExclui(feriados, "2026-09-08", "u1"), true);
  });
  it("não exclui feriado de outra unidade", () => {
    assert.equal(feriadoExclui(feriados, "2026-09-08", "u2"), false);
  });
  it("feriado sem unidade (\"Todas\") exclui qualquer uma", () => {
    assert.equal(feriadoExclui(feriados, "2026-09-09", "u2"), true);
  });
  it("feriado marcado como trabalhado não exclui", () => {
    assert.equal(feriadoExclui(feriados, "2026-09-10", "u1"), false);
  });
});

describe("emFerias", () => {
  const ferias: FeriasParaCalculo[] = [{ colaboradorId: "c1", dataInicio: "2026-09-10", dataFim: "2026-09-14" }];
  it("dia dentro do período conta como férias", () => {
    assert.equal(emFerias(ferias, "c1", "2026-09-12"), true);
  });
  it("dia fora do período não conta", () => {
    assert.equal(emFerias(ferias, "c1", "2026-09-20"), false);
  });
  it("não confunde com outro colaborador", () => {
    assert.equal(emFerias(ferias, "c2", "2026-09-12"), false);
  });
});

describe("colaboradorAtivoNoMes", () => {
  it("ativo sempre conta", () => {
    assert.equal(colaboradorAtivoNoMes({ ativo: true, dataDesligamento: null }, "2026-09"), true);
  });
  it("desligado sem data ainda conta (caso raro)", () => {
    assert.equal(colaboradorAtivoNoMes({ ativo: false, dataDesligamento: null }, "2026-09"), true);
  });
  it("conta no mês do próprio desligamento", () => {
    assert.equal(colaboradorAtivoNoMes({ ativo: false, dataDesligamento: "2026-09-15" }, "2026-09"), true);
  });
  it("não conta no mês seguinte ao desligamento", () => {
    assert.equal(colaboradorAtivoNoMes({ ativo: false, dataDesligamento: "2026-08-15" }, "2026-09"), false);
  });
});

describe("horasEsperadasGrade", () => {
  it("conta terças e quintas de setembro/2026 (TQ)", () => {
    // Setembro/2026: terças em 1,8,15,22,29 (5) e quintas em 3,10,17,24 (4) — 9 dias, 18h a 2h/dia.
    const r = horasEsperadasGrade("c1", "2026-09", [grade()], [], []);
    assert.equal(r.temGrade, true);
    assert.equal(r.diasLetivosTotais, 9);
    assert.equal(r.totalHoras, 18);
    assert.equal(r.porNivel[1], 18);
    assert.equal(r.diasComVT, 9);
  });

  it("sem nenhum bloco de grade, temGrade é falso", () => {
    const r = horasEsperadasGrade("outro", "2026-09", [grade()], [], []);
    assert.equal(r.temGrade, false);
    assert.equal(r.diasLetivosTotais, 0);
  });

  it("feriado da unidade tira o dia da contagem", () => {
    const feriados: FeriadoParaCalculo[] = [{ data: "2026-09-01", unidadeId: "u1", contaTrabalhado: false }];
    const r = horasEsperadasGrade("c1", "2026-09", [grade()], feriados, []);
    assert.equal(r.diasLetivosTotais, 8);
    assert.equal(r.totalHoras, 16);
  });

  it("feriado de outra unidade não afeta", () => {
    const feriados: FeriadoParaCalculo[] = [{ data: "2026-09-01", unidadeId: "u2", contaTrabalhado: false }];
    const r = horasEsperadasGrade("c1", "2026-09", [grade()], feriados, []);
    assert.equal(r.diasLetivosTotais, 9);
  });

  it("férias tira o dia inteiro, mesmo que fosse dia de aula", () => {
    const ferias: FeriasParaCalculo[] = [{ colaboradorId: "c1", dataInicio: "2026-09-01", dataFim: "2026-09-01" }];
    const r = horasEsperadasGrade("c1", "2026-09", [grade()], [], ferias);
    assert.equal(r.diasLetivosTotais, 8);
    assert.equal(r.diasDeFerias, 1);
  });

  it("turma semVt não soma no VT, mas soma nas horas", () => {
    const r = horasEsperadasGrade("c1", "2026-09", [grade({ semVt: true })], [], []);
    assert.equal(r.diasComVT, 0);
    assert.equal(r.diasLetivosTotais, 9);
  });

  it("respeita dataInicio/dataFim da turma", () => {
    // Só a partir do dia 10 — tira as terças/quintas de 01, 03 e 08, fica com 6 dias.
    const r = horasEsperadasGrade("c1", "2026-09", [grade({ dataInicio: "2026-09-10" })], [], []);
    assert.equal(r.diasLetivosTotais, 6);
  });
});

describe("calcLancamentoValor", () => {
  const valores: ValorParaCalculo[] = [
    { tipo: "PROFESSOR", nivel: 1, valorHora: 25, valorVt: 8 },
    { tipo: "ESTAGIARIO", nivel: 1, valorHora: 25, valorVt: 8 },
  ];

  it("Extra soma hora-aula e VT", () => {
    const r = calcLancamentoValor({ tipo: "EXTRA", nivel: 1, horas: 2, usaVt: true }, "PROFESSOR", valores);
    assert.equal(r.total, 2 * 25 + 8);
  });

  it("Ausência sem atestado não desconta Professor (desconto vem da Folha, não do lançamento)", () => {
    const r = calcLancamentoValor({ tipo: "AUSENCIA", nivel: 1, horas: 2, usaVt: true }, "PROFESSOR", valores);
    assert.equal(r.total, 0);
  });

  it("Ausência sem atestado desconta Estagiário", () => {
    const r = calcLancamentoValor({ tipo: "AUSENCIA", nivel: 1, horas: 2, usaVt: true }, "ESTAGIARIO", valores);
    assert.equal(r.total, -50);
  });

  it("Ausência com atestado nunca desconta", () => {
    const r = calcLancamentoValor({ tipo: "AUSENCIA_ATESTADO", nivel: 1, horas: 3, usaVt: true }, "ESTAGIARIO", valores);
    assert.equal(r.total, 0);
  });

  it("Competição, Competição Psicóloga e Bônus são valores fixos", () => {
    assert.equal(calcLancamentoValor({ tipo: "COMPETICAO", nivel: 1, horas: 0, usaVt: false }, "PROFESSOR", valores).total, 90);
    assert.equal(calcLancamentoValor({ tipo: "COMPETICAO_PSICOLOGA", nivel: 1, horas: 0, usaVt: false }, "PROFESSOR", valores).total, 40);
    assert.equal(calcLancamentoValor({ tipo: "BONUS", nivel: 1, horas: 0, usaVt: false }, "PROFESSOR", valores).total, 25);
  });

  it("Desconto VT é negativo, na hora do VT (não na hora-aula)", () => {
    const r = calcLancamentoValor({ tipo: "DESCONTO_VT", nivel: 1, horas: 3, usaVt: true }, "PROFESSOR", valores);
    assert.equal(r.total, -3 * 8);
  });
});

describe("folhaColabCalc", () => {
  const colaborador: ColaboradorParaCalculo = { id: "c1", tipo: "PROFESSOR", ativo: true, dataDesligamento: null };
  const valores: ValorParaCalculo[] = [{ tipo: "PROFESSOR", nivel: 1, valorHora: 25, valorVt: 8 }];

  it("sem grade, os campos dependentes de grade vêm null e o resto zerado", () => {
    const r = folhaColabCalc(colaborador, "2026-09", [], [], [], [], valores);
    assert.equal(r.temGrade, false);
    assert.equal(r.diasTrabalhados, null);
    assert.equal(r.diasVTProximoMes, null);
    assert.equal(r.valorDiaria, null);
  });

  it("falta sem atestado desconta 1 dia trabalhado e as horas daquele nível", () => {
    const lancamentos: LancamentoParaCalculo[] = [
      { colaboradorId: "c1", data: "2026-09-01", tipo: "AUSENCIA", nivel: 1, horas: 2, usaVt: true },
    ];
    const r = folhaColabCalc(colaborador, "2026-09", [grade()], [], [], lancamentos, valores);
    assert.equal(r.diasTrabalhados, 8); // 9 dias de TQ - 1 falta
    assert.equal(r.horasPorNivel[1], 16); // 18h - 2h da falta
    // valorDiaria = valorBruto(18h*25) + valorFaltas(Professor falta = 0) + desconto VT(0)
    assert.equal(r.valorDiaria, 18 * 25);
  });

  it("VT antecipado usa a grade do mês seguinte, já líquida de falta lá", () => {
    // Setembro tem grade; outubro também, com 1 falta lançada em outubro.
    const lancamentos: LancamentoParaCalculo[] = [
      { colaboradorId: "c1", data: "2026-10-01", tipo: "AUSENCIA", nivel: 1, horas: 2, usaVt: true },
    ];
    const r = folhaColabCalc(colaborador, "2026-09", [grade()], [], [], lancamentos, valores);
    const semFalta = horasEsperadasGrade("c1", "2026-10", [grade()], [], []).diasComVT;
    assert.equal(r.diasVTProximoMes, semFalta - 1);
  });

  it("colaborador desligado a partir do mês seguinte não recebe VT antecipado", () => {
    const desligado: ColaboradorParaCalculo = { id: "c1", tipo: "PROFESSOR", ativo: false, dataDesligamento: "2026-09-20" };
    const r = folhaColabCalc(desligado, "2026-09", [grade()], [], [], [], valores);
    assert.equal(r.diasVTProximoMes, 0);
  });

  it("diárias/bônus soma extra, bônus e competição, mas não é salário (não entra no valorDiaria)", () => {
    const lancamentos: LancamentoParaCalculo[] = [
      { colaboradorId: "c1", data: "2026-09-05", tipo: "EXTRA", nivel: 1, horas: 1, usaVt: false },
      { colaboradorId: "c1", data: "2026-09-06", tipo: "BONUS", nivel: 1, horas: 0, usaVt: false },
    ];
    const r = folhaColabCalc(colaborador, "2026-09", [grade()], [], [], lancamentos, valores);
    assert.equal(r.diariasBonus, 25 + 25);
    assert.equal(r.valorDiaria, 18 * 25); // não inclui diárias/bônus
  });
});
