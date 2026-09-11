import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { MotivoCancelamento, StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import authPlugin from "../src/plugins/auth.js";
import { cadastroRoutes } from "../src/modules/escola/cadastro.routes.js";
import { cobrancaRoutes } from "../src/modules/financeiro/cobranca.routes.js";

/**
 * Cancelamento com motivo, e troca de turma/plano numa matrícula já feita.
 *
 * Três regras que valem a pena travar em teste:
 *
 *   1. Cancelar sem motivo não existe mais pelo PATCH genérico — só pela rota
 *      dedicada, que também decide o que fazer com cobrança em aberto.
 *   2. Trocar só a turma não mexe em nada financeiro; só quando o plano
 *      também muda é que a contagem de parcelas reinicia.
 *   3. Reativar uma matrícula cancelada limpa o motivo — senão a tela mostra
 *      "cancelada por tal motivo" numa matrícula que voltou a valer.
 *
 * Sobe as rotas de verdade num Fastify próprio, com um token assinado para
 * ADMIN. Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-cancelamento";
let contadorCpf = 0;

async function limpar() {
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.planoTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

async function subirApp() {
  const app = Fastify();
  await app.register(authPlugin);
  await app.register(cadastroRoutes);
  await app.register(cobrancaRoutes);
  await app.ready();
  const token = app.jwt.sign({
    sub: "teste-admin",
    email: "admin@teste.com",
    nome: "Admin de Teste",
    papeis: ["ADMIN"],
  });
  return { app, token };
}

async function cenario() {
  const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
  const planoA = await prisma.plano.create({ data: { nome: `${MARCA} plano A`, valor: 100, parcelas: 12 } });
  const planoB = await prisma.plano.create({ data: { nome: `${MARCA} plano B`, valor: 150, parcelas: 6 } });
  const turmaOrigem = await prisma.turma.create({
    data: { nome: `${MARCA} turma origem`, unidadeId: unidade.id, capacidade: 10 },
  });
  const turmaDestino = await prisma.turma.create({
    data: { nome: `${MARCA} turma destino`, unidadeId: unidade.id, capacidade: 10 },
  });
  const turmaCheia = await prisma.turma.create({
    data: { nome: `${MARCA} turma cheia`, unidadeId: unidade.id, capacidade: 1 },
  });
  await prisma.planoTurma.createMany({
    data: [
      { turmaId: turmaOrigem.id, planoId: planoA.id },
      { turmaId: turmaDestino.id, planoId: planoA.id },
      { turmaId: turmaDestino.id, planoId: planoB.id },
      { turmaId: turmaCheia.id, planoId: planoA.id },
    ],
  });

  contadorCpf += 1;
  const responsavel = await prisma.responsavel.create({
    data: { nome: `${MARCA} responsável`, cpf: String(90000000000 + contadorCpf) },
  });
  const aluno = await prisma.aluno.create({
    data: { nome: `${MARCA} aluno`, responsavelId: responsavel.id, nascimento: new Date("2012-01-01") },
  });

  // A turma cheia precisa de uma matrícula confirmada ocupando a vaga única,
  // senão "cheia" nunca é verdade.
  const outroAluno = await prisma.aluno.create({
    data: { nome: `${MARCA} aluno da vaga`, responsavelId: responsavel.id, nascimento: new Date("2012-01-01") },
  });
  await prisma.matricula.create({
    data: {
      alunoId: outroAluno.id,
      responsavelId: responsavel.id,
      turmaId: turmaCheia.id,
      unidadeId: unidade.id,
      planoId: planoA.id,
      status: StatusMatricula.CONFIRMADA,
    },
  });

  const matricula = await prisma.matricula.create({
    data: {
      alunoId: aluno.id,
      responsavelId: responsavel.id,
      turmaId: turmaOrigem.id,
      unidadeId: unidade.id,
      planoId: planoA.id,
      status: StatusMatricula.CONFIRMADA,
    },
  });

  return { matriculaId: matricula.id, turmaDestinoId: turmaDestino.id, turmaCheiaId: turmaCheia.id, planoAId: planoA.id, planoBId: planoB.id };
}

describe("cancelamento com motivo", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("o PATCH genérico recusa cancelar sem motivo", async () => {
    const { matriculaId } = await cenario();
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "CANCELADA" },
    });

    assert.equal(r.statusCode, 409);
    assert.match(r.json().message, /motivo/i);

    const matricula = await prisma.matricula.findUniqueOrThrow({ where: { id: matriculaId } });
    assert.equal(matricula.status, StatusMatricula.CONFIRMADA, "não pode ter cancelado mesmo assim");

    await app.close();
  });

  it("cancela com motivo, e sem emissão ligada não mexe no Asaas mas registra o aviso", async () => {
    const { matriculaId } = await cenario();
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: `/financeiro/matriculas/${matriculaId}/cancelar`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        motivo: "MUDOU_CIDADE",
        motivoDetalhe: "Foi para Recife",
        apagarFuturas: true,
        apagarVencidas: false,
      },
    });

    assert.equal(r.statusCode, 200);
    const corpo = r.json();
    assert.equal(corpo.matricula.status, StatusMatricula.CANCELADA);
    assert.equal(corpo.matricula.motivoCancelamento, "MUDOU_CIDADE");
    assert.equal(corpo.cobrancasApagadas, 0);
    assert.ok(corpo.erros.length >= 1, "emissão desligada devia gerar um aviso, não silêncio");

    const matricula = await prisma.matricula.findUniqueOrThrow({ where: { id: matriculaId } });
    assert.equal(matricula.motivoCancelamentoDetalhe, "Foi para Recife");
    assert.ok(matricula.canceladaEm);

    await app.close();
  });

  it("recusa cancelar de novo uma matrícula já cancelada", async () => {
    const { matriculaId } = await cenario();
    await prisma.matricula.update({
      where: { id: matriculaId },
      data: { status: StatusMatricula.CANCELADA, canceladaEm: new Date(), motivoCancelamento: MotivoCancelamento.OUTRO },
    });
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: `/financeiro/matriculas/${matriculaId}/cancelar`,
      headers: { authorization: `Bearer ${token}` },
      payload: { motivo: "FINANCEIRO", apagarFuturas: false, apagarVencidas: false },
    });

    assert.equal(r.statusCode, 409);
    await app.close();
  });

  it("reativar limpa o motivo do cancelamento", async () => {
    const { matriculaId } = await cenario();
    await prisma.matricula.update({
      where: { id: matriculaId },
      data: {
        status: StatusMatricula.CANCELADA,
        canceladaEm: new Date(),
        motivoCancelamento: MotivoCancelamento.INSATISFACAO,
        motivoCancelamentoDetalhe: "não gostou do horário",
      },
    });
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "CONFIRMADA" },
    });

    assert.equal(r.statusCode, 200);
    const matricula = r.json();
    assert.equal(matricula.canceladaEm, null);
    assert.equal(matricula.motivoCancelamento, null);
    assert.equal(matricula.motivoCancelamentoDetalhe, null);

    await app.close();
  });
});

describe("troca de turma e plano numa matrícula existente", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("trocar só a turma não mexe em expiraEm", async () => {
    const { matriculaId, turmaDestinoId } = await cenario();
    await prisma.matricula.update({ where: { id: matriculaId }, data: { expiraEm: new Date("2027-01-01") } });
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { turmaId: turmaDestinoId },
    });

    assert.equal(r.statusCode, 200);
    const matricula = r.json();
    assert.equal(matricula.turmaId, turmaDestinoId);
    assert.equal(
      new Date(matricula.expiraEm).toISOString().slice(0, 10),
      "2027-01-01",
      "trocar só a turma não pode reiniciar a contagem de parcelas",
    );

    await app.close();
  });

  it("trocar o plano reinicia expiraEm a partir de hoje", async () => {
    const { matriculaId, planoBId } = await cenario();
    await prisma.matricula.update({ where: { id: matriculaId }, data: { expiraEm: new Date("2027-01-01") } });
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planoId: planoBId },
    });

    assert.equal(r.statusCode, 200);
    const matricula = r.json();
    assert.equal(matricula.planoId, planoBId);
    assert.notEqual(
      new Date(matricula.expiraEm).toISOString().slice(0, 10),
      "2027-01-01",
      "trocar o plano precisa reiniciar a contagem de parcelas",
    );

    await app.close();
  });

  it("recusa mover para uma turma sem vaga", async () => {
    const { matriculaId, turmaCheiaId } = await cenario();
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { turmaId: turmaCheiaId },
    });

    assert.equal(r.statusCode, 409);
    assert.match(r.json().message, /vaga/i);

    await app.close();
  });
});
