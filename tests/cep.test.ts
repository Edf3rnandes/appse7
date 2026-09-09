import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";

/**
 * Busca de CEP.
 *
 * Sobe um ViaCEP de mentira na porta 4699 e aponta o cliente para ele: os
 * testes não tocam no serviço real nem dependem de internet. O que interessa
 * aqui não é o caminho feliz — é o que acontece quando o serviço responde
 * torto, porque é isso que decide se uma matrícula trava.
 *
 * Rode com: DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const PORTA = 4699;
process.env.CEP_BASE_URL = `http://127.0.0.1:${PORTA}`;
process.env.CEP_TIMEOUT_MS = "600";

const { buscarCep, CepIndisponivelError, CepInvalidoError } = await import(
  "../src/services/cep/cep.client.js"
);

/** O que o servidor de mentira responde na próxima chamada. */
let resposta: { status: number; corpo: unknown; demora?: number } = {
  status: 200,
  corpo: {},
};

let servidor: Server;

describe("busca de CEP", () => {
  before(async () => {
    servidor = createServer((_req, res) => {
      const enviar = () => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(resposta.status).end(JSON.stringify(resposta.corpo));
      };
      if (resposta.demora) setTimeout(enviar, resposta.demora);
      else enviar();
    });
    await new Promise<void>((ok) => servidor.listen(PORTA, "127.0.0.1", ok));
  });

  after(async () => {
    await new Promise<void>((ok) => servidor.close(() => ok()));
  });

  it("aceita CEP com máscara e devolve o endereço", async () => {
    resposta = {
      status: 200,
      corpo: {
        cep: "58038-000",
        logradouro: "Avenida Cabo Branco",
        bairro: "Cabo Branco",
        localidade: "João Pessoa",
        uf: "pb",
      },
    };

    const e = await buscarCep("58038-000");
    assert.deepEqual(e, {
      cep: "58038000",
      logradouro: "Avenida Cabo Branco",
      bairro: "Cabo Branco",
      cidade: "João Pessoa",
      estado: "PB",
    });
  });

  it("recusa CEP fora de oito dígitos antes de ir à rede", async () => {
    // Se fosse à rede, o servidor de mentira responderia 200 e o teste passaria
    // pelo motivo errado. A resposta abaixo é a prova de que ele não foi
    // consultado.
    resposta = { status: 200, corpo: { localidade: "Não deveria chegar aqui" } };
    await assert.rejects(() => buscarCep("5803"), CepInvalidoError);
    await assert.rejects(() => buscarCep(""), CepInvalidoError);
  });

  it("devolve null quando o CEP não existe", async () => {
    // O ViaCEP responde 200 com {"erro": ...} — não 404. Os dois formatos que
    // ele já usou precisam continuar funcionando.
    resposta = { status: 200, corpo: { erro: true } };
    assert.equal(await buscarCep("58000999"), null);

    resposta = { status: 200, corpo: { erro: "true" } };
    assert.equal(await buscarCep("58000999"), null);
  });

  it("devolve cidade e estado quando o CEP não tem rua", async () => {
    resposta = {
      status: 200,
      corpo: { logradouro: "", bairro: "", localidade: "Cajazeiras", uf: "PB" },
    };

    const e = await buscarCep("58900000");
    assert.equal(e?.cidade, "Cajazeiras");
    assert.equal(e?.logradouro, "", "sem rua, mas a cidade já ajuda");
  });

  it("trata serviço fora do ar como indisponível, não como CEP inválido", async () => {
    resposta = { status: 500, corpo: { erro: "boom" } };
    await assert.rejects(() => buscarCep("58038000"), CepIndisponivelError);
  });

  it("desiste quando o serviço demora demais", async () => {
    // Sem o timeout, uma matrícula ficaria pendurada esperando um terceiro.
    resposta = { status: 200, corpo: { localidade: "Tarde demais" }, demora: 1500 };
    await assert.rejects(() => buscarCep("58038000"), CepIndisponivelError);
  });

  it("não confia no formato: resposta estranha é indisponibilidade", async () => {
    resposta = { status: 200, corpo: "isto não é um objeto" };
    await assert.rejects(() => buscarCep("58038000"), CepIndisponivelError);
  });
});
