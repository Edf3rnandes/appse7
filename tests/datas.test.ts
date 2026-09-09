import assert from "node:assert/strict";
import {
  mesesAFrente, describe, it } from "node:test";
import {
  mesesAFrente, emUtc, hoje, primeiroDiaDoMes, segundaDaSemana, somarDias, ultimoDiaDoMes } from "../src/lib/datas.js";

/**
 * Estes testes existem por causa de um bug real: com o servidor em
 * America/Fortaleza (UTC-3), a meia-noite UTC de uma segunda-feira é domingo
 * 21h no horário local. A função lia componentes locais e remontava em UTC, e
 * toda semana do cronograma acabava gravada 7 dias antes — sem erro nenhum,
 * só no lugar errado.
 *
 * Rodam sem banco.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("datas de calendário", () => {
  it("devolve a própria segunda-feira sem deslocar", () => {
    // O caso que quebrava: entra segunda, tem de sair a mesma segunda.
    assert.equal(iso(segundaDaSemana(emUtc(2026, 8, 7))), "2026-09-07");
  });

  it("acha a segunda a partir de qualquer dia da semana", () => {
    for (const dia of [7, 8, 9, 10, 11, 12, 13]) {
      assert.equal(
        iso(segundaDaSemana(emUtc(2026, 8, dia))),
        "2026-09-07",
        `dia ${dia} deveria pertencer à semana de 07/09`,
      );
    }
  });

  it("trata domingo como fim da semana que começou na segunda anterior", () => {
    // 13/09/2026 é domingo: pertence à semana de 07/09, não à de 14/09.
    assert.equal(iso(segundaDaSemana(emUtc(2026, 8, 13))), "2026-09-07");
    assert.equal(iso(segundaDaSemana(emUtc(2026, 8, 14))), "2026-09-14");
  });

  it("atravessa a virada de mês e de ano", () => {
    assert.equal(iso(segundaDaSemana(emUtc(2026, 0, 1))), "2025-12-29");
    assert.equal(iso(segundaDaSemana(emUtc(2026, 2, 1))), "2026-02-23");
  });

  it("é estável em qualquer fuso do servidor", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["America/Fortaleza", "UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
        process.env.TZ = tz;
        assert.equal(
          iso(segundaDaSemana(emUtc(2026, 8, 7))),
          "2026-09-07",
          `deu errado em ${tz}`,
        );
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("soma dias sem escorregar no horário de verão", () => {
    assert.equal(iso(somarDias(emUtc(2026, 8, 7), 7)), "2026-09-14");
    assert.equal(iso(somarDias(emUtc(2026, 8, 7), -6)), "2026-09-01");
  });

  it("delimita o mês", () => {
    assert.equal(iso(primeiroDiaDoMes(2026, 9)), "2026-09-01");
    assert.equal(iso(ultimoDiaDoMes(2026, 9)), "2026-09-30");
    assert.equal(iso(ultimoDiaDoMes(2024, 2)), "2024-02-29");
  });

  it("hoje() devolve meia-noite UTC do dia local", () => {
    const d = hoje();
    assert.equal(d.getUTCHours(), 0);
    assert.equal(d.getUTCMinutes(), 0);
    const agora = new Date();
    assert.equal(d.getUTCDate(), agora.getDate(), "tem de ser o dia do relógio de parede");
  });
});

/**
 * A conta de vencimento da matrícula.
 *
 * Não é aritmética inocente: ela decide até quando o aluno pode treinar e
 * quando o administrativo liga para renovar.
 */
describe("mesesAFrente", () => {
  const em = (ano: number, mes: number, dia: number) => emUtc(ano, mes - 1, dia);

  it("soma os meses do plano", () => {
    assert.equal(
      mesesAFrente(6, em(2026, 9, 9)).toISOString().slice(0, 10),
      "2027-03-09",
      "um semestral de 6 parcelas vence seis meses depois",
    );
    assert.equal(mesesAFrente(1, em(2026, 9, 9)).toISOString().slice(0, 10), "2026-10-09");
    assert.equal(mesesAFrente(12, em(2026, 9, 9)).toISOString().slice(0, 10), "2027-09-09");
  });

  it("vira o ano sozinho", () => {
    assert.equal(mesesAFrente(6, em(2026, 11, 20)).toISOString().slice(0, 10), "2027-05-20");
  });

  // O dia 31 num mês de 30 escorrega para o dia 1 do seguinte. É o
  // comportamento do próprio Date e o mesmo do Carbon, que o sistema antigo
  // usava — a data não muda de significado na migração.
  it("trata o dia 31 num mês de 30 como o Carbon tratava", () => {
    assert.equal(mesesAFrente(1, em(2026, 1, 31)).toISOString().slice(0, 10), "2026-03-03");
    assert.equal(mesesAFrente(1, em(2026, 3, 31)).toISOString().slice(0, 10), "2026-05-01");
  });

  it("não escorrega de dia por causa do fuso", () => {
    const original = process.env.TZ;
    for (const fuso of ["America/Fortaleza", "UTC", "Asia/Tokyo", "Pacific/Kiritimati"]) {
      process.env.TZ = fuso;
      assert.equal(
        mesesAFrente(6, em(2026, 9, 9)).toISOString().slice(0, 10),
        "2027-03-09",
        `errou em ${fuso}`,
      );
    }
    process.env.TZ = original;
  });

  // Renovar adiantado não pode custar os dias que ainda faltavam: a regra é
  // somar a partir da data que vencer por último.
  it("renovação adiantada soma a partir do vencimento, não de hoje", () => {
    const agora = em(2026, 9, 9);
    const vencimentoFuturo = em(2026, 10, 20);
    const base = vencimentoFuturo > agora ? vencimentoFuturo : agora;

    assert.equal(
      mesesAFrente(6, base).toISOString().slice(0, 10),
      "2027-04-20",
      "quem renova com 41 dias de sobra deveria mantê-los",
    );
  });

  it("renovação atrasada soma a partir de hoje", () => {
    const agora = em(2026, 9, 9);
    const vencimentoPassado = em(2026, 8, 28);
    const base = vencimentoPassado > agora ? vencimentoPassado : agora;

    assert.equal(mesesAFrente(6, base).toISOString().slice(0, 10), "2027-03-09");
  });
});
