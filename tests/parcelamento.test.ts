import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import authPlugin from "../src/plugins/auth.js";
import { cobrancaRoutes } from "../src/modules/financeiro/cobranca.routes.js";

/**
 * Emissão em lote das parcelas do plano.
 *
 * O parcelamento em si (a chamada de verdade ao Asaas) não é testado aqui —
 * exigiria mockar a API externa, e o risco de emitir cobrança de verdade por
 * engano numa suíte de teste é pior que a cobertura que isso daria. O que
 * vale travar é o que roda ANTES do Asaas: o mesmo guarda de emissão
 * desligada que a cobrança avulsa já tem, e o limite de parcelas (1 a 24,
 * o mesmo teto do cadastro do plano).
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-parcelamento";
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
  const plano = await prisma.plano.create({ data: { nome: `${MARCA} plano`, valor: 100, parcelas: 12 } });
  const turma = await prisma.turma.create({ data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 10 } });
  contadorCpf += 1;
  const responsavel = await prisma.responsavel.create({
    data: { nome: `${MARCA} responsável`, cpf: String(90222000000 + contadorCpf) },
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
    },
  });
  return matricula.id;
}

describe("emissão em lote das parcelas", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("recusa com emissão desligada, como a cobrança avulsa", async () => {
    const matriculaId = await cenario();
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: `/financeiro/matriculas/${matriculaId}/parcelas`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    assert.equal(r.statusCode, 409);
    assert.match(r.json().message, /desligada/i);

    await app.close();
  });

  it("recusa número de parcelas fora do intervalo", async () => {
    const matriculaId = await cenario();
    const { app, token } = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: `/financeiro/matriculas/${matriculaId}/parcelas`,
      headers: { authorization: `Bearer ${token}` },
      payload: { parcelas: 25 },
    });

    assert.equal(r.statusCode, 400);

    await app.close();
  });
});
