import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import authPlugin from "../src/plugins/auth.js";
import { cadastroRoutes } from "../src/modules/escola/cadastro.routes.js";

/**
 * Busca e paginação de GET /escola/matriculas.
 *
 * A busca precisa achar pelo nome do aluno, do responsável, ou pelo CPF —
 * quem atende no balcão às vezes só tem um desses em mãos. E a paginação
 * precisa mesmo cortar em páginas: sem isso, uma escola com centenas de
 * matrículas só via as 50 mais recentes, sem jeito de ver o resto.
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-busca-matricula";

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
  await app.ready();
  const token = app.jwt.sign({
    sub: "teste-admin",
    email: "admin@teste.com",
    nome: "Admin de Teste",
    papeis: ["ADMIN"],
  });
  return { app, token };
}

describe("busca e paginação de matrículas", () => {
  let turmaId, planoId;

  before(async () => {
    await limpar();
    const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
    const plano = await prisma.plano.create({ data: { nome: `${MARCA} plano`, valor: 100, parcelas: 12 } });
    const turma = await prisma.turma.create({ data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 50 } });
    turmaId = turma.id;
    planoId = plano.id;

    // Três matrículas: uma achável só pelo nome do aluno, uma só pelo nome
    // do responsável, uma só pelo CPF — nenhuma pista sozinha acha as três.
    const casos = [
      { alunoNome: `${MARCA} João da Silva`, respNome: `${MARCA} resp 1`, cpf: "90333000001" },
      { alunoNome: `${MARCA} aluno 2`, respNome: `${MARCA} Maria Pereira`, cpf: "90333000002" },
      { alunoNome: `${MARCA} aluno 3`, respNome: `${MARCA} resp 3`, cpf: "90333777003" },
    ];
    for (const c of casos) {
      const responsavel = await prisma.responsavel.create({ data: { nome: c.respNome, cpf: c.cpf } });
      const aluno = await prisma.aluno.create({
        data: { nome: c.alunoNome, responsavelId: responsavel.id, nascimento: new Date("2012-01-01") },
      });
      await prisma.matricula.create({
        data: {
          alunoId: aluno.id,
          responsavelId: responsavel.id,
          turmaId,
          unidadeId: unidade.id,
          planoId,
          status: StatusMatricula.CONFIRMADA,
        },
      });
    }
  });

  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("acha pelo nome do aluno", async () => {
    const { app, token } = await subirApp();
    const r = await app.inject({
      method: "GET",
      url: `/escola/matriculas?busca=${encodeURIComponent("João da Silva")}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().total, 1);
    assert.match(r.json().itens[0].aluno.nome, /João da Silva/);
    await app.close();
  });

  it("acha pelo nome do responsável, não só do aluno", async () => {
    const { app, token } = await subirApp();
    const r = await app.inject({
      method: "GET",
      url: `/escola/matriculas?busca=${encodeURIComponent("Maria Pereira")}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().total, 1);
    assert.match(r.json().itens[0].responsavel.nome, /Maria Pereira/);
    await app.close();
  });

  it("acha pelo CPF, com ou sem pontuação", async () => {
    const { app, token } = await subirApp();
    const r = await app.inject({
      method: "GET",
      url: `/escola/matriculas?busca=${encodeURIComponent("903.337.770-03")}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().total, 1);
    assert.equal(r.json().itens[0].responsavel.cpf, "90333777003");
    await app.close();
  });

  it("pagina de verdade: 2 por página traz páginas diferentes", async () => {
    const { app, token } = await subirApp();
    const p1 = await app.inject({
      method: "GET",
      url: `/escola/matriculas?limite=2&pagina=1&turmaId=${turmaId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const p2 = await app.inject({
      method: "GET",
      url: `/escola/matriculas?limite=2&pagina=2&turmaId=${turmaId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(p1.json().total, 3);
    assert.equal(p1.json().itens.length, 2);
    assert.equal(p2.json().itens.length, 1);

    const idsP1 = p1.json().itens.map((m) => m.id);
    const idsP2 = p2.json().itens.map((m) => m.id);
    assert.equal(idsP1.some((id) => idsP2.includes(id)), false, "as páginas não podem repetir matrícula");

    await app.close();
  });
});
