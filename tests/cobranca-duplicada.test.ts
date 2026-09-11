import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import Fastify from "fastify";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import authPlugin from "../src/plugins/auth.js";

/**
 * Duplo clique em "Emitir cobrança" — o bug real do sistema atual: dois
 * cliques rápidos geram dois boletos para a mesma mensalidade, a família
 * paga um e o outro fica cobrando como se estivesse vencido.
 *
 * Três camadas de proteção contra isso, e este arquivo prova as duas mais
 * fundas:
 *
 *   1. No navegador, o botão desliga (`disabled`) antes da chamada à API, e
 *      os `prompt()` de valor/vencimento bloqueiam o clique duplo mesmo
 *      antes disso — verificado com Playwright, não dá pra automatizar
 *      aqui.
 *   2. No servidor, a rota confere no Asaas se já existe cobrança em aberto
 *      do mesmo tipo antes de criar outra.
 *   3. Como a 2 sozinha ainda deixava passar duas requisições disparadas no
 *      mesmo instante — checar e criar não são atômicos —, existe também
 *      uma trava (`pg_advisory_xact_lock`, em cobranca.routes.ts) que
 *      serializa por id de matrícula. O primeiro teste aqui reproduziu o
 *      buraco antes da trava existir (duas cobranças de verdade, num Asaas
 *      de mentira) e agora prova que ele está fechado.
 *
 * O Asaas de mentira não confia na resposta HTTP de cada chamada — confia
 * no que de fato foi registrado nele, que é a pergunta que importa: quantos
 * boletos a família vai ver.
 *
 * Sobe a rota de verdade com fastify.inject, e um servidor HTTP mudo no
 * lugar do Asaas — puxado por ASAAS_BASE_URL antes de qualquer import do
 * cliente, porque `asaasConfigurado` é decidido na carga do módulo.
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-cobranca-duplicada";
const PORTA_ASAAS = 4700;

process.env.ASAAS_API_KEY = "chave-de-teste";
process.env.ASAAS_BASE_URL = `http://127.0.0.1:${PORTA_ASAAS}`;

const { cobrancaRoutes } = await import("../src/modules/financeiro/cobranca.routes.js");

const CHAVE_EMISSAO = "asaas.emissaoAtiva";
let emissaoAtivaOriginal: string | null = null;

let servidorAsaas: Server;
// O "banco" do Asaas de mentira: só o que passou pelo POST /payments entra
// aqui — é essa lista, e não a resposta HTTP de cada chamada, que decide se
// o teste passa.
let pagamentosCriados: { id: string; externalReference: string; description: string }[] = [];
let proximoId = 1;
let contadorCpf = 0;

async function limpar() {
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

async function cenario() {
  const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
  const plano = await prisma.plano.create({ data: { nome: `${MARCA} plano`, valor: 100, parcelas: 12 } });
  const turma = await prisma.turma.create({ data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 10 } });
  contadorCpf += 1;
  const responsavel = await prisma.responsavel.create({
    data: { nome: `${MARCA} responsável`, cpf: String(90555000000 + contadorCpf) },
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

describe("dois cliques na emissão de cobrança não podem virar dois boletos", () => {
  before(async () => {
    await limpar();

    // Um Asaas de mentira: cliente sempre existe, cobrança consultada é o
    // que já foi criado, e criar cobrança grava na lista — sem atraso
    // artificial nenhum, de propósito, pra dar a MENOR folga possível pra
    // proteção do servidor segurar a corrida.
    servidorAsaas = createServer((req, res) => {
      let corpo = "";
      req.on("data", (c) => (corpo += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");

        if (req.method === "POST" && req.url === "/customers") {
          return res.writeHead(200).end(JSON.stringify({ id: "cus_teste", name: "x", cpfCnpj: "x" }));
        }

        if (req.method === "GET" && req.url?.startsWith("/payments?")) {
          const url = new URL(req.url, "http://x");
          const ref = url.searchParams.get("externalReference");
          const data = pagamentosCriados
            .filter((p) => p.externalReference === ref)
            .map((p) => ({ ...p, status: "PENDING", value: 100, dueDate: "2026-10-10", invoiceUrl: null, bankSlipUrl: null, paymentDate: null, customer: "cus_teste" }));
          return res.writeHead(200).end(JSON.stringify({ data }));
        }

        if (req.method === "POST" && req.url === "/payments") {
          const dados = JSON.parse(corpo);
          const pagamento = {
            id: `pay_${proximoId++}`,
            externalReference: dados.externalReference,
            description: dados.description,
          };
          pagamentosCriados.push(pagamento);
          return res.writeHead(200).end(
            JSON.stringify({
              ...pagamento,
              status: "PENDING",
              value: dados.value,
              dueDate: dados.dueDate,
              invoiceUrl: "https://asaas.example/fatura",
              bankSlipUrl: null,
              paymentDate: null,
              customer: "cus_teste",
            }),
          );
        }

        res.writeHead(404).end("{}");
      });
    });
    await new Promise<void>((ok) => servidorAsaas.listen(PORTA_ASAAS, "127.0.0.1", ok));

    // A emissão precisa estar ligada — é o que o botão de verdade exige.
    // Guarda o valor de antes pra devolver depois: esta chave é a mesma que
    // a tela de Cobrança usa de verdade, não uma cópia de teste.
    const atual = await prisma.configuracao.findUnique({ where: { chave: CHAVE_EMISSAO } });
    emissaoAtivaOriginal = atual?.valor ?? null;
    await prisma.configuracao.upsert({
      where: { chave: CHAVE_EMISSAO },
      create: { chave: CHAVE_EMISSAO, valor: "true" },
      update: { valor: "true" },
    });
  });

  after(async () => {
    if (emissaoAtivaOriginal === null) {
      await prisma.configuracao.deleteMany({ where: { chave: CHAVE_EMISSAO } });
    } else {
      await prisma.configuracao.update({ where: { chave: CHAVE_EMISSAO }, data: { valor: emissaoAtivaOriginal } });
    }
    await limpar();
    await new Promise<void>((ok) => servidorAsaas.close(() => ok()));
    await prisma.$disconnect();
  });

  it("duas requisições simultâneas pra mesma matrícula geram só uma cobrança no Asaas", async () => {
    const matriculaId = await cenario();
    pagamentosCriados = [];
    const { app, token } = await subirApp();

    const corpo = { tipo: "MENSALIDADE" };
    const cabecalho = { authorization: `Bearer ${token}` };
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/financeiro/matriculas/${matriculaId}/cobranca`, headers: cabecalho, payload: corpo }),
      app.inject({ method: "POST", url: `/financeiro/matriculas/${matriculaId}/cobranca`, headers: cabecalho, payload: corpo }),
    ]);

    const sucessos = [r1, r2].filter((r) => r.statusCode === 201).length;
    const noAsaas = pagamentosCriados.filter((p) => p.externalReference === matriculaId);

    console.log(`status das duas respostas: ${r1.statusCode}, ${r2.statusCode}`);
    console.log(`cobranças que existem de verdade no Asaas de mentira: ${noAsaas.length}`);

    assert.equal(
      noAsaas.length,
      1,
      "duas chamadas simultâneas criaram duas cobranças no Asaas — é exatamente o bug do duplo clique",
    );
    assert.equal(sucessos, 1, "só uma das duas respostas deveria ter sido 201");

    await app.close();
  });

  it("clicar de novo depois que a primeira já existe é bloqueado (o caso comum: dois cliques não-simultâneos)", async () => {
    const matriculaId = await cenario();
    pagamentosCriados = [];
    const { app, token } = await subirApp();

    const corpo = { tipo: "MENSALIDADE" };
    const cabecalho = { authorization: `Bearer ${token}` };
    const r1 = await app.inject({ method: "POST", url: `/financeiro/matriculas/${matriculaId}/cobranca`, headers: cabecalho, payload: corpo });
    const r2 = await app.inject({ method: "POST", url: `/financeiro/matriculas/${matriculaId}/cobranca`, headers: cabecalho, payload: corpo });

    assert.equal(r1.statusCode, 201);
    assert.equal(r2.statusCode, 409);
    assert.match(r2.json().message, /já existe/i);

    const noAsaas = pagamentosCriados.filter((p) => p.externalReference === matriculaId);
    assert.equal(noAsaas.length, 1);

    await app.close();
  });

  it("o mesmo vale para o parcelamento em lote — a trava é a mesma função", async () => {
    const matriculaId = await cenario();
    pagamentosCriados = [];
    const { app, token } = await subirApp();

    const cabecalho = { authorization: `Bearer ${token}` };
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `/financeiro/matriculas/${matriculaId}/parcelas`, headers: cabecalho, payload: {} }),
      app.inject({ method: "POST", url: `/financeiro/matriculas/${matriculaId}/parcelas`, headers: cabecalho, payload: {} }),
    ]);

    const sucessos = [r1, r2].filter((r) => r.statusCode === 201).length;
    const noAsaas = pagamentosCriados.filter((p) => p.externalReference === matriculaId);

    assert.equal(sucessos, 1, "só um dos dois parcelamentos simultâneos deveria ter sido criado");
    assert.equal(noAsaas.length, 1, "duas chamadas simultâneas não podem virar dois parcelamentos no Asaas");

    await app.close();
  });
});
