import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error — módulo do navegador, sem tipos.
import { idadeEm } from "../public/app.js";

/**
 * A idade que decide, na matrícula do site, se aparecem os campos do
 * responsável — sem caixa nenhuma para marcar. O bug que essa troca
 * eliminou: uma caixa "o aluno é menor de 18 anos" desmarcada por esquecimento
 * deixava passar uma matrícula de criança sem responsável nenhum. Sem a
 * caixa, não há como esquecer — só há data de nascimento certa ou errada.
 */

const HOJE = new Date("2026-09-10T12:00:00.000Z");

describe("idadeEm", () => {
  it("sem data, devolve null", () => {
    assert.equal(idadeEm("", HOJE), null);
  });

  it("data inválida, devolve null — não quebra, não mente", () => {
    assert.equal(idadeEm("não é data", HOJE), null);
  });

  it("conta os anos completos, ainda não fez aniversário este ano", () => {
    // Nasceu 15/09/2010: em 10/09/2026 ainda tem 15, faz 16 em 5 dias.
    assert.equal(idadeEm("2010-09-15", HOJE), 15);
  });

  it("já fez aniversário este ano", () => {
    assert.equal(idadeEm("2010-01-01", HOJE), 16);
  });

  it("faz aniversário hoje: já conta o ano novo", () => {
    assert.equal(idadeEm("2010-09-10", HOJE), 16);
  });

  it("recém-nascido não vira idade negativa nem null", () => {
    assert.equal(idadeEm("2026-09-01", HOJE), 0);
  });

  it("29 de fevereiro não quebra em ano sem esse dia", () => {
    // Nasceu num ano bissexto; 2026 não é. new Date(2026, 1, 29) rola para
    // 1º de março — o aniversário "atrasa" um dia, nunca trava a conta.
    assert.doesNotThrow(() => idadeEm("2008-02-29", HOJE));
    assert.equal(idadeEm("2008-02-29", HOJE), 18);
  });

  it("na véspera do 18º aniversário ainda é menor; no dia, já não é", () => {
    // Nasceu 11/09/2008: faz 18 anos amanhã (11/09/2026) — hoje ainda são 17,
    // e é o dia mais apertado que existe para testar "menor de idade".
    assert.equal(idadeEm("2008-09-11", HOJE), 17);
    // Nasceu 10/09/2008: o aniversário de 18 é hoje — já conta.
    assert.equal(idadeEm("2008-09-10", HOJE), 18);
  });
});
