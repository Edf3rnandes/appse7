import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import Fastify from "fastify";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

/**
 * A taxa de matrícula agora sai sozinha, assim que a família confirma pelo
 * site — sem o administrativo precisar entrar no painel e clicar em "Cobrar
 * taxa". Ver `emitirTaxaAutomatica` em financeiro/cobranca.routes.ts, chamada
 * no fim de POST /publico/matricula.
 *
 * Três coisas importam aqui:
 *
 *   1. Com a emissão ligada, a cobrança sai de verdade e o link de pagamento
 *      volta na resposta — é o que a tela de recibo usa para mostrar o botão
 *      "Pagar".
 *   2. Com a emissão desligada (o padrão em produção enquanto o Laravel
 *      estiver no ar), nada é cobrado — a matrícula continua CRIADA, igual
 *      sempre foi.
 *   3. Se o Asaas falhar, a matrícula continua valendo: quem preencheu o
 *      site não pode ficar sem cadastro por causa de uma falha de rede numa
 *      chamada que nem é dele.
 *
 * Sobe a rota de verdade com fastify.inject, e um servidor HTTP mudo no
 * lugar do Asaas, do mesmo jeito que cobranca-duplicada.test.ts.
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const MARCA = "ZZ-teste-taxa-automatica";
const PORTA_ASAAS = 4701;

/** Gera um CPF com dígitos verificadores válidos — a rota recusa CPF inválido antes de tudo. */
function cpfDeTeste(sequencia: number): string {
  const base = String(300000000 + sequencia).padStart(9, "0").slice(-9);
  const digito = (nums: string, ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(nums[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(base, 9);
  const d2 = digito(base + d1, 10);
  return `${base}${d1}${d2}`;
}

process.env.ASAAS_API_KEY = "chave-de-teste";
process.env.ASAAS_BASE_URL = `http://127.0.0.1:${PORTA_ASAAS}`;

const { publicoRoutes } = await import("../src/modules/publico/matricula.routes.js");

const CHAVE_EMISSAO = "asaas.emissaoAtiva";
let emissaoAtivaOriginal: string | null = null;

let servidorAsaas: Server;
let pagamentosCriados: { id: string; externalReference: string; description: string }[] = [];
let proximoId = 1;
let falharProximaCobranca = false;
let contadorCpf = 0;

async function limpar() {
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.horarioTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.planoTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

async function cenario() {
  const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
  const plano = await prisma.plano.create({ data: { nome: `${MARCA} plano`, valor: 100, parcelas: 6 } });
  const turma = await prisma.turma.create({
    data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 10, aceitaNovasMatriculas: true },
  });
  await prisma.planoTurma.create({ data: { turmaId: turma.id, planoId: plano.id } });
  return { turmaId: turma.id, planoId: plano.id };
}

function corpo(cpf: string, turmaId: string, planoId: string) {
  return {
    aluno: { nome: `${MARCA} aluno`, nascimento: "2012-04-05", turmaId, planoId },
    responsavelEhOAluno: false,
    aceitouTermos: true,
    responsavel: {
      nome: "Quem Preencheu o Site",
      cpf,
      telefone: "83 98888-0000",
      email: "site@exemplo.com",
      endereco: {
        cep: "58038-000",
        logradouro: "Avenida Cabo Branco",
        numero: "1210",
        bairro: "Cabo Branco",
        cidade: "João Pessoa",
        estado: "pb",
      },
    },
  };
}

async function subirApp() {
  const app = Fastify();
  await app.register(publicoRoutes);
  await app.ready();
  return app;
}

async function ligarEmissao(ativa: boolean) {
  await prisma.configuracao.upsert({
    where: { chave: CHAVE_EMISSAO },
    create: { chave: CHAVE_EMISSAO, valor: String(ativa) },
    update: { valor: String(ativa) },
  });
}

describe("taxa de matrícula emitida sozinha pelo site", () => {
  before(async () => {
    await limpar();

    servidorAsaas = createServer((req, res) => {
      let corpoRecebido = "";
      req.on("data", (c) => (corpoRecebido += c));
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
          if (falharProximaCobranca) {
            return res.writeHead(500).end(JSON.stringify({ errors: [{ description: "falha de propósito, pro teste" }] }));
          }
          const dados = JSON.parse(corpoRecebido);
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
              invoiceUrl: "https://asaas.example/fatura-taxa",
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

    const atual = await prisma.configuracao.findUnique({ where: { chave: CHAVE_EMISSAO } });
    emissaoAtivaOriginal = atual?.valor ?? null;
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

  it("com a emissão ligada, a matrícula pelo site já sai com a taxa cobrada e o link de pagamento", async () => {
    await ligarEmissao(true);
    falharProximaCobranca = false;
    pagamentosCriados = [];
    contadorCpf += 1;
    const cpf = cpfDeTeste(contadorCpf);

    const { turmaId, planoId } = await cenario();
    const app = await subirApp();

    const r = await app.inject({ method: "POST", url: "/publico/matricula", payload: corpo(cpf, turmaId, planoId) });

    assert.equal(r.statusCode, 201);
    const resposta = r.json();
    assert.equal(resposta.matriculas.length, 1);
    assert.equal(resposta.matriculas[0].linkPagamentoTaxa, "https://asaas.example/fatura-taxa");

    const noAsaas = pagamentosCriados.filter((p) => p.description?.startsWith("Taxa de matrícula"));
    assert.equal(noAsaas.length, 1, "devia ter criado exatamente uma cobrança de taxa no Asaas");

    const responsavel = await prisma.responsavel.findUniqueOrThrow({ where: { cpf } });
    const matricula = await prisma.matricula.findFirstOrThrow({ where: { responsavelId: responsavel.id } });
    assert.equal(matricula.status, StatusMatricula.PAGAMENTO_PENDENTE, "a matrícula deixa de ser CRIADA quando a taxa sai");
    assert.ok(matricula.asaasPagamento, "o id da cobrança precisa ficar gravado na matrícula");
    assert.equal(matricula.linkPagamento, "https://asaas.example/fatura-taxa");

    await app.close();
  });

  it("com a emissão desligada, a matrícula nasce CRIADA e nenhuma cobrança é tentada", async () => {
    await ligarEmissao(false);
    falharProximaCobranca = false;
    pagamentosCriados = [];
    contadorCpf += 1;
    const cpf = cpfDeTeste(contadorCpf);

    const { turmaId, planoId } = await cenario();
    const app = await subirApp();

    const r = await app.inject({ method: "POST", url: "/publico/matricula", payload: corpo(cpf, turmaId, planoId) });

    assert.equal(r.statusCode, 201);
    const resposta = r.json();
    assert.equal(resposta.matriculas[0].linkPagamentoTaxa, null);
    assert.equal(pagamentosCriados.length, 0, "com a emissão desligada, o Asaas não pode ser chamado");

    const responsavel = await prisma.responsavel.findUniqueOrThrow({ where: { cpf } });
    const matricula = await prisma.matricula.findFirstOrThrow({ where: { responsavelId: responsavel.id } });
    assert.equal(matricula.status, StatusMatricula.CRIADA);

    await app.close();
  });

  it("se o Asaas falhar ao emitir a taxa, a matrícula continua valendo mesmo assim", async () => {
    await ligarEmissao(true);
    falharProximaCobranca = true;
    pagamentosCriados = [];
    contadorCpf += 1;
    const cpf = cpfDeTeste(contadorCpf);

    const { turmaId, planoId } = await cenario();
    const app = await subirApp();

    const r = await app.inject({ method: "POST", url: "/publico/matricula", payload: corpo(cpf, turmaId, planoId) });

    assert.equal(r.statusCode, 201, "uma falha no Asaas não pode derrubar a matrícula");
    assert.equal(r.json().matriculas[0].linkPagamentoTaxa, null);

    const responsavel = await prisma.responsavel.findUniqueOrThrow({ where: { cpf } });
    const matricula = await prisma.matricula.findFirstOrThrow({ where: { responsavelId: responsavel.id } });
    assert.equal(matricula.status, StatusMatricula.CRIADA, "sem cobrança de verdade, o status não muda");

    await app.close();
  });
});
