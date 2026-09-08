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
