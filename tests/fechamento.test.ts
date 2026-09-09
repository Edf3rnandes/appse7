import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { diaUtc, fecharDia, milissegundosAte } from "../src/modules/socios/fechamento.js";

/**
 * O fechamento diário.
 *
 * Duas coisas precisam ser verdade para esta série valer alguma coisa:
 *
 *   1. Rodar duas vezes no mesmo dia corrige, não duplica. Sem isso,
 *      reprocessar um dia que falhou dobraria o número de alunos daquele dia.
 *   2. O agendamento aponta para 23:59 no fuso da escola, não no do servidor.
 *      Em UTC, 23:59 de Fortaleza é 02:59 do dia seguinte — o fechamento
 *      cairia no dia errado, todo dia.
 */

const MARCA = "ZZ-teste-fechamento";

async function limpar() {
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.planoTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

describe("horário do fechamento", () => {
  it("aponta para daqui a no máximo 24 horas, e nunca para o passado", () => {
    const falta = milissegundosAte(23, 59, "America/Fortaleza");
    assert.ok(falta > 0, "um alvo no passado agendaria o disparo imediato, em looping");
    assert.ok(falta <= 24 * 3600 * 1000);
  });

  it("dois fusos diferentes dão horários diferentes", () => {
    // Se a conta ignorasse o fuso e usasse só o relógio do processo, os dois
    // dariam o mesmo número — e o fechamento cairia na hora errada em
    // produção sem ninguém perceber.
    const fortaleza = milissegundosAte(23, 59, "America/Fortaleza");
    const toquio = milissegundosAte(23, 59, "Asia/Tokyo");
    assert.notEqual(Math.round(fortaleza / 60000), Math.round(toquio / 60000));
  });

  it("normaliza qualquer instante do dia para a meia-noite dele", () => {
    const manha = diaUtc(new Date("2026-03-15T08:20:00.000Z"));
    const noite = diaUtc(new Date("2026-03-15T23:50:00.000Z"));
    assert.equal(manha.toISOString(), "2026-03-15T00:00:00.000Z");
    assert.equal(manha.getTime(), noite.getTime(), "o dia é o mesmo, a hora não importa");
  });
});

describe("gravação do fechamento", () => {
  after(async () => {
    await limpar();
    await prisma.fechamentoDiario.deleteMany({
      where: { data: new Date("2024-05-10T00:00:00.000Z") },
    });
    await prisma.$disconnect();
  });

  it("rodar duas vezes no mesmo dia corrige em vez de duplicar", async () => {
    await limpar();

    const dia = new Date("2024-05-10T00:00:00.000Z");
    const primeiro = await fecharDia(dia, "MANUAL");

    // Uma matrícula nova, criada naquele dia, entra na segunda passada.
    const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
    const plano = await prisma.plano.create({
      data: { nome: `${MARCA} plano`, valor: 200, parcelas: 6 },
    });
    const turma = await prisma.turma.create({
      data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 10 },
    });
    const responsavel = await prisma.responsavel.create({
      data: { nome: `${MARCA} responsavel`, cpf: "56045274036" },
    });
    const aluno = await prisma.aluno.create({
      data: { nome: `${MARCA} aluno`, responsavelId: responsavel.id },
    });
    await prisma.matricula.create({
      data: {
        alunoId: aluno.id,
        responsavelId: responsavel.id,
        turmaId: turma.id,
        unidadeId: unidade.id,
        planoId: plano.id,
        status: StatusMatricula.CONFIRMADA,
        criadoEm: new Date("2024-05-10T14:00:00.000Z"),
      },
    });

    const segundo = await fecharDia(dia, "MANUAL");

    assert.equal(segundo.id, primeiro.id, "tem de ser a mesma linha, não uma nova");
    assert.equal(segundo.ativos, primeiro.ativos + 1, "e o número tem de ter sido corrigido");
    assert.equal(segundo.entradas, primeiro.entradas + 1);

    const quantas = await prisma.fechamentoDiario.count({ where: { data: dia } });
    assert.equal(quantas, 1, "um dia, uma linha");
  });

  it("carimba de onde a linha veio", async () => {
    const dia = new Date("2024-05-10T00:00:00.000Z");
    const f = await fecharDia(dia, "RECONSTRUIDO");
    assert.equal(f.origem, "RECONSTRUIDO");
  });
});
