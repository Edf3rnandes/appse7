import { z } from "zod";

// Cliente do Asaas para o Hub.
//
// Duas diferencas deliberadas em relacao ao servico equivalente no Laravel:
//   1. A verificacao de certificado TLS fica LIGADA. O codigo atual chama
//      `withoutVerifying()` em todas as 17 chamadas, o que expoe a chave de
//      producao — nao repetimos isso aqui.
//   2. Tem timeout. Uma indisponibilidade do Asaas nao pode segurar uma
//      requisicao do portal ate o limite do servidor.

const envSchema = z.object({
  ASAAS_API_KEY: z.string().default(""),
  ASAAS_BASE_URL: z.string().default("https://api.asaas.com/v3"),
  ASAAS_TIMEOUT_MS: z.coerce.number().default(8000),
});

const cfg = envSchema.parse(process.env);

export const asaasConfigurado = cfg.ASAAS_API_KEY !== "";

export class AsaasIndisponivelError extends Error {}

async function get<T>(caminho: string): Promise<T> {
  if (!asaasConfigurado) {
    throw new AsaasIndisponivelError("Integracao com o Asaas nao configurada (ASAAS_API_KEY).");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ASAAS_TIMEOUT_MS);

  try {
    const resposta = await fetch(`${cfg.ASAAS_BASE_URL}${caminho}`, {
      headers: { access_token: cfg.ASAAS_API_KEY, "Content-Type": "application/json" },
      signal: controller.signal,
    });

    if (!resposta.ok) {
      throw new AsaasIndisponivelError(`Asaas respondeu ${resposta.status}.`);
    }

    return (await resposta.json()) as T;
  } catch (err) {
    if (err instanceof AsaasIndisponivelError) throw err;
    throw new AsaasIndisponivelError("Nao foi possivel falar com o Asaas.");
  } finally {
    clearTimeout(timer);
  }
}

export interface FaturaAsaas {
  id: string;
  status: string;
  value: number;
  dueDate: string;
  description: string | null;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  paymentDate: string | null;
}

interface ListaAsaas<T> {
  data: T[];
}

// Faturas de UM cliente. O id do cliente nunca vem do navegador: e resolvido no
// servidor a partir do vinculo do token com `customers.asaas_customer`.
export async function listarFaturasDoCliente(asaasCustomerId: string): Promise<FaturaAsaas[]> {
  const resposta = await get<ListaAsaas<FaturaAsaas>>(
    `/payments?customer=${encodeURIComponent(asaasCustomerId)}&limit=50&order=desc`,
  );
  return resposta.data ?? [];
}

// ---------------------------------------------------------------------------
// Escrita — criar cliente e cobrança
// ---------------------------------------------------------------------------
//
// Tudo daqui para baixo MOVIMENTA DINHEIRO na conta da escola, e por isso não
// depende só da chave de API estar presente: quem decide se o Hub pode emitir
// é uma configuração no banco, desligada por padrão (ver `emissaoAtiva` em
// src/modules/financeiro). Enquanto os dois sistemas estiverem no ar, dois
// emissores na mesma conta do Asaas geram duas cobranças para o mesmo pai.
//
// Não há retentativa aqui, de propósito. Repetir um POST /payments que talvez
// tenha dado certo cria cobrança duplicada — o mesmo motivo pelo qual o
// AsaasClient do patch do Laravel também não repete.

async function post<T>(caminho: string, corpo: unknown): Promise<T> {
  if (!asaasConfigurado) {
    throw new AsaasIndisponivelError("Integracao com o Asaas nao configurada (ASAAS_API_KEY).");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.ASAAS_TIMEOUT_MS);

  try {
    const resposta = await fetch(`${cfg.ASAAS_BASE_URL}${caminho}`, {
      method: "POST",
      headers: { access_token: cfg.ASAAS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: controller.signal,
    });

    const dados = (await resposta.json().catch(() => ({}))) as {
      errors?: { description?: string }[];
    };

    if (!resposta.ok) {
      // O Asaas explica a recusa em `errors[].description` — "CPF inválido",
      // "cliente já existe". Repassar isso é a diferença entre o administrativo
      // resolver sozinha e abrir um chamado.
      const motivo = dados.errors?.[0]?.description;
      throw new AsaasIndisponivelError(
        motivo ? `Asaas recusou: ${motivo}` : `Asaas respondeu ${resposta.status}.`,
      );
    }

    return dados as T;
  } catch (err) {
    if (err instanceof AsaasIndisponivelError) throw err;
    throw new AsaasIndisponivelError("Nao foi possivel falar com o Asaas.");
  } finally {
    clearTimeout(timer);
  }
}

export interface ClienteAsaas {
  id: string;
  name: string;
  cpfCnpj: string;
}

/** Cria o cliente no Asaas. O id devolvido é gravado no responsável do Hub. */
export async function criarCliente(dados: {
  nome: string;
  cpf: string;
  email?: string | null;
  telefone?: string | null;
}): Promise<ClienteAsaas> {
  return post<ClienteAsaas>("/customers", {
    name: dados.nome,
    cpfCnpj: dados.cpf,
    ...(dados.email ? { email: dados.email } : {}),
    ...(dados.telefone ? { mobilePhone: dados.telefone.replace(/\D/g, "") } : {}),
  });
}

export interface CobrancaAsaas extends FaturaAsaas {
  externalReference: string | null;
  customer: string;
}

/**
 * Cria uma cobrança.
 *
 * `billingType: "UNDEFINED"` deixa o pagador escolher entre PIX e boleto na
 * própria fatura — que é o que as condições dos planos prometem.
 *
 * `externalReference` leva o id da matrícula. É o que permite reencontrar a
 * cobrança depois e, principalmente, saber que ela já existe: sem isso, dois
 * cliques no botão viram duas cobranças para o mesmo pai.
 */
export async function criarCobranca(dados: {
  clienteAsaas: string;
  valor: number;
  vencimento: string;
  descricao: string;
  referencia: string;
  descontoPercentual?: number;
}): Promise<CobrancaAsaas> {
  return post<CobrancaAsaas>("/payments", {
    customer: dados.clienteAsaas,
    billingType: "UNDEFINED",
    value: dados.valor,
    dueDate: dados.vencimento,
    description: dados.descricao,
    externalReference: dados.referencia,
    ...(dados.descontoPercentual
      ? {
          // Desconto até o vencimento, como as condições do plano dizem.
          discount: { value: dados.descontoPercentual, dueDateLimitDays: 0, type: "PERCENTAGE" },
        }
      : {}),
  });
}

/** Cobranças de uma matrícula, achadas pela referência que gravamos nelas. */
export async function listarCobrancasDaMatricula(matriculaId: string): Promise<CobrancaAsaas[]> {
  const resposta = await get<ListaAsaas<CobrancaAsaas>>(
    `/payments?externalReference=${encodeURIComponent(matriculaId)}&limit=50&order=desc`,
  );
  return resposta.data ?? [];
}

/** Todas as cobranças vencidas da escola — a tela Financeiro > Cobranças vencidas. */
export async function listarVencidas(limite = 100): Promise<CobrancaAsaas[]> {
  const resposta = await get<ListaAsaas<CobrancaAsaas>>(
    `/payments?status=OVERDUE&limit=${limite}&order=asc`,
  );
  return resposta.data ?? [];
}

/**
 * Cobranças recebidas num intervalo, pela data do pagamento.
 *
 * `paymentDate` e não `dueDate`: o painel dos sócios pergunta quanto ENTROU no
 * mês, e um boleto de março pago em abril é dinheiro de abril. Vencimento
 * responde outra pergunta.
 *
 * O Asaas pagina em 100. Aqui seguimos até o fim, com um teto: uma escola de
 * 570 alunos gera algo perto de 600 cobranças por mês, e parar na primeira
 * página daria um faturamento silenciosamente menor que o real — o pior tipo
 * de número errado, porque parece plausível.
 */
export async function listarRecebidas(
  de: string,
  ate: string,
  tetoDePaginas = 20,
): Promise<CobrancaAsaas[]> {
  const todas: CobrancaAsaas[] = [];

  for (let pagina = 0; pagina < tetoDePaginas; pagina++) {
    const resposta = await get<ListaAsaas<CobrancaAsaas>>(
      `/payments?status=RECEIVED&paymentDate%5Bge%5D=${de}&paymentDate%5Ble%5D=${ate}` +
        `&limit=100&offset=${pagina * 100}&order=asc`,
    );
    const lote = resposta.data ?? [];
    todas.push(...lote);
    if (lote.length < 100) break;
  }

  return todas;
}
