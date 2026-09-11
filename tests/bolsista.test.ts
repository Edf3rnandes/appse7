import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import authPlugin from "../src/plugins/auth.js";
import { cadastroRoutes } from "../src/modules/escola/cadastro.routes.js";
import { cobrancaRoutes } from "../src/modules/financeiro/cobranca.routes.js";

/**
 * Bolsista: matriculado de verdade, isento de cobrança.
 *
 * Três coisas precisam ser verdade:
 *
 *   1. Marcar/desmarcar bolsista é um PATCH normal, e desmarcar limpa a
 *      data de revisão — não pode sobrar um "revisar até" numa matrícula
 *      que não é mais bolsista.
 *   2. As duas rotas de emissão (avulsa e parcelamento) recusam cobrança
 *      pra bolsista, mesmo com a emissão ligada.
 *   3. O filtro `bolsista` em GET /escola/matriculas separa quem é de quem
 *      não é.
 *
 * A receita (receitaDe) já tem teste próprio em precos.test.ts.
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-bolsista";
let contadorCpf = 0;

async function limpar() {
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
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

async function cenario(bolsista = false) {
  const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
  const plano = await prisma.plano.create({ data: { nome: `${MARCA} plano`, valor: 150, parcelas: 12 } });
  const turma = await prisma.turma.create({ data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 10 } });
  contadorCpf += 1;
  const responsavel = await prisma.responsavel.create({
    data: { nome: `${MARCA} responsável`, cpf: String(90666000000 + contadorCpf) },
  });
  const aluno = await prisma.aluno.create({
    data: { nome: `${MARCA} aluno`, responsavelId: responsavel.id, nascimento: new Date("2012-01-01") },
  });
  const matricula = await prisma.matricula.create({
    data: {
      alunoId: aluno.id,
      responsavelId: responsavel.id,
      turmaId: turma.id,
      unidadeId: unidade.id,
      planoId: plano.id,
      status: StatusMatricula.CONFIRMADA,
      bolsista,
    },
  });
  return matricula.id;
}

describe("marcar e desmarcar bolsista", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("marca bolsista com data de revisão", async () => {
    const matriculaId = await cenario();
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { bolsista: true, bolsaRevisarEm: "2027-01-15" },
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.json().bolsista, true);
    assert.equal(new Date(r.json().bolsaRevisarEm).toISOString().slice(0, 10), "2027-01-15");

    await app.close();
  });

  it("desmarcar bolsista limpa a data de revisão junto", async () => {
    const matriculaId = await cenario(true);
    await prisma.matricula.update({ where: { id: matriculaId }, data: { bolsaRevisarEm: new Date("2027-01-15") } });
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "PATCH",
      url: `/escola/matriculas/${matriculaId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { bolsista: false },
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.json().bolsista, false);
    assert.equal(r.json().bolsaRevisarEm, null);

    await app.close();
  });
});

describe("bolsista não recebe cobrança", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("recusa emitir mensalidade/taxa avulsa e o parcelamento pra bolsista, com emissão ligada", async () => {
    const matriculaId = await cenario(true);
    const CHAVE_EMISSAO = "asaas.emissaoAtiva";
    const atual = await prisma.configuracao.findUnique({ where: { chave: CHAVE_EMISSAO } });
    await prisma.configuracao.upsert({
      where: { chave: CHAVE_EMISSAO },
      create: { chave: CHAVE_EMISSAO, valor: "true" },
      update: { valor: "true" },
    });

    try {
      const { app, token } = await subirApp();

      const r1 = await app.inject({
        method: "POST",
        url: `/financeiro/matriculas/${matriculaId}/cobranca`,
        headers: { authorization: `Bearer ${token}` },
        payload: { tipo: "MENSALIDADE" },
      });
      assert.equal(r1.statusCode, 409);
      assert.match(r1.json().message, /bolsista/i);

      const r2 = await app.inject({
        method: "POST",
        url: `/financeiro/matriculas/${matriculaId}/parcelas`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      assert.equal(r2.statusCode, 409);
      assert.match(r2.json().message, /bolsista/i);

      await app.close();
    } finally {
      if (atual === null) {
        await prisma.configuracao.deleteMany({ where: { chave: CHAVE_EMISSAO } });
      } else {
        await prisma.configuracao.update({ where: { chave: CHAVE_EMISSAO }, data: { valor: atual.valor } });
      }
    }
  });
});

describe("filtro de bolsistas na listagem", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("bolsista=true só traz bolsistas", async () => {
    await cenario(true);
    await cenario(false);
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "GET",
      url: `/escola/matriculas?busca=${encodeURIComponent(MARCA)}&bolsista=true`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(r.statusCode, 200);
    const corpo = r.json();
    assert.equal(corpo.total, 1);
    assert.equal(corpo.itens[0].bolsista, true);

    await app.close();
  });
});
