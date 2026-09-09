import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import Fastify from "fastify";
import { prisma } from "../src/lib/prisma.js";

/**
 * O endereço na matrícula feita pelo site.
 *
 * Duas regras, e a segunda é a que importa:
 *
 *   1. Sem endereço a matrícula não passa. É por ele que sai nota fiscal e
 *      boleto, e o sistema atual tem essas colunas vazias porque nenhuma tela
 *      as pedia.
 *   2. Um cadastro que já existe NÃO ganha o endereço digitado no site — nem
 *      quando o endereço dele está vazio. Preencher campo vazio parece
 *      inofensivo, mas o caminho é o mesmo de quem só descobriu o CPF de
 *      alguém, e é no endereço que o boleto impresso chega. Vira recado para a
 *      secretaria.
 *
 * Sobe a rota de verdade num Fastify próprio e usa `inject`, sem rede.
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-endereco";
const CPF_NOVO = "11122233396";
const CPF_EXISTENTE = "22233344405";
const PORTA_CEP = 4698;

process.env.CEP_BASE_URL = `http://127.0.0.1:${PORTA_CEP}`;

const { publicoRoutes } = await import("../src/modules/publico/matricula.routes.js");

const ENDERECO = {
  cep: "58038-000",
  logradouro: "Avenida Cabo Branco",
  numero: "1210",
  complemento: "apto 302",
  bairro: "Cabo Branco",
  cidade: "João Pessoa",
  estado: "pb",
};

let servidorCep: Server;

async function limpar() {
  const resps = await prisma.responsavel.findMany({
    where: { cpf: { in: [CPF_NOVO, CPF_EXISTENTE] } },
  });
  const ids = resps.map((r) => r.id);
  if (ids.length) {
    await prisma.matricula.deleteMany({ where: { responsavelId: { in: ids } } });
    await prisma.aluno.deleteMany({ where: { responsavelId: { in: ids } } });
    await prisma.responsavel.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.horarioTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.planoTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

async function cenario() {
  const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
  const plano = await prisma.plano.create({
    data: { nome: `${MARCA} plano`, valor: 100, parcelas: 6 },
  });
  const turma = await prisma.turma.create({
    data: {
      nome: `${MARCA} turma`,
      unidadeId: unidade.id,
      capacidade: 10,
      aceitaNovasMatriculas: true,
    },
  });
  await prisma.planoTurma.create({ data: { turmaId: turma.id, planoId: plano.id } });
  return { turmaId: turma.id, planoId: plano.id };
}

const corpo = (cpf: string, turmaId: string, planoId: string, endereco: unknown) => ({
  aluno: { nome: `${MARCA} aluno`, nascimento: "2012-04-05", turmaId, planoId },
  responsavelEhOAluno: false,
  aceitouTermos: true,
  responsavel: {
    nome: "Quem Preencheu o Site",
    cpf,
    telefone: "83 98888-0000",
    email: "site@exemplo.com",
    ...(endereco === undefined ? {} : { endereco }),
  },
});

async function subirApp() {
  const app = Fastify();
  await app.register(publicoRoutes);
  await app.ready();
  return app;
}

describe("endereço na matrícula pelo site", () => {
  before(async () => {
    await limpar();
    // O CEP não é consultado por esta rota, mas o módulo é carregado junto:
    // um servidor mudo evita qualquer chamada acidental à internet.
    servidorCep = createServer((_q, r) => r.writeHead(200).end("{}"));
    await new Promise<void>((ok) => servidorCep.listen(PORTA_CEP, "127.0.0.1", ok));
  });

  after(async () => {
    await limpar();
    await new Promise<void>((ok) => servidorCep.close(() => ok()));
    await prisma.$disconnect();
  });

  it("recusa a matrícula sem endereço", async () => {
    const { turmaId, planoId } = await cenario();
    const app = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: "/publico/matricula",
      payload: corpo(CPF_NOVO, turmaId, planoId, undefined),
    });

    assert.equal(r.statusCode, 400);
    assert.match(r.json().message, /endereco/i);
    assert.equal(
      await prisma.responsavel.count({ where: { cpf: CPF_NOVO } }),
      0,
      "recusa não pode deixar responsável meio criado",
    );
    await app.close();
  });

  it("recusa CEP que não tem oito dígitos", async () => {
    const { turmaId, planoId } = await cenario();
    const app = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: "/publico/matricula",
      payload: corpo(CPF_NOVO, turmaId, planoId, { ...ENDERECO, cep: "5803" }),
    });

    assert.equal(r.statusCode, 400);
    assert.match(r.json().message, /8 dígitos/);
    await app.close();
  });

  it("grava o endereço do responsável novo, normalizado", async () => {
    const { turmaId, planoId } = await cenario();
    const app = await subirApp();

    const r = await app.inject({
      method: "POST",
      url: "/publico/matricula",
      payload: corpo(CPF_NOVO, turmaId, planoId, ENDERECO),
    });

    assert.equal(r.statusCode, 201);

    const salvo = await prisma.responsavel.findUniqueOrThrow({ where: { cpf: CPF_NOVO } });
    assert.equal(salvo.cep, "58038000", "a máscara do CEP não vai para o banco");
    assert.equal(salvo.estado, "PB", "a UF é gravada em maiúsculas");
    assert.equal(salvo.logradouro, "Avenida Cabo Branco");
    assert.equal(salvo.numero, "1210");
    assert.equal(salvo.complemento, "apto 302");
    await app.close();
  });

  it("não escreve o endereço num cadastro que já existe, mesmo vazio", async () => {
    const { turmaId, planoId } = await cenario();
    await prisma.responsavel.create({
      data: { nome: "Cadastro Antigo", cpf: CPF_EXISTENTE, telefone: "83 91111-2222" },
    });

    const app = await subirApp();
    const r = await app.inject({
      method: "POST",
      url: "/publico/matricula",
      payload: corpo(CPF_EXISTENTE, turmaId, planoId, ENDERECO),
    });

    assert.equal(r.statusCode, 201);

    const depois = await prisma.responsavel.findUniqueOrThrow({ where: { cpf: CPF_EXISTENTE } });
    assert.equal(depois.logradouro, null, "o site não escreve no cadastro existente");
    assert.equal(depois.cep, null);
    assert.equal(depois.nome, "Cadastro Antigo", "nem o nome");

    const matricula = await prisma.matricula.findFirstOrThrow({
      where: { responsavel: { cpf: CPF_EXISTENTE } },
      orderBy: { criadoEm: "desc" },
    });
    assert.match(
      matricula.observacao ?? "",
      /Avenida Cabo Branco/,
      "o endereço informado precisa chegar à secretaria como recado",
    );
    assert.match(matricula.observacao ?? "", /sem endereço/i);
    await app.close();
  });
});
