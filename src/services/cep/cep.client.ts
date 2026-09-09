import { z } from "zod";

/**
 * Busca de endereço por CEP.
 *
 * Quem consulta é o servidor, não o navegador da família. Três razões:
 *
 *   1. Trocar de provedor vira uma variável de ambiente, não um deploy do
 *      site. O ViaCEP é gratuito e sem contrato — se ele sair do ar, ou passar
 *      a exigir chave, a escola não fica refém de uma URL escrita no meio do
 *      HTML.
 *   2. O navegador da família não fala com um terceiro. O CEP não é segredo,
 *      mas o padrão de "o site do cliente não vaza requisição para fora" é o
 *      que evita a próxima integração ser feita de qualquer jeito.
 *   3. Dá para testar contra um servidor de mentira, como já é feito com o
 *      Asaas, sem depender da internet nem bater no serviço real.
 *
 * A regra que mais importa está fora daqui, na tela: se esta busca falhar, a
 * matrícula NÃO pode parar. Os campos continuam editáveis e a pessoa digita o
 * endereço. Um serviço de CEP fora do ar não pode custar uma matrícula.
 */

const cfg = z
  .object({
    CEP_BASE_URL: z.string().default("https://viacep.com.br/ws"),
    CEP_TIMEOUT_MS: z.coerce.number().default(4000),
  })
  .parse(process.env);

export class CepInvalidoError extends Error {}
export class CepIndisponivelError extends Error {}

export interface EnderecoDoCep {
  cep: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  estado: string;
}

/** O que o ViaCEP devolve. Campos ausentes viram string vazia, não erro. */
const respostaViaCep = z.object({
  cep: z.string().optional(),
  logradouro: z.string().optional(),
  bairro: z.string().optional(),
  localidade: z.string().optional(),
  uf: z.string().optional(),
  // O ViaCEP responde 200 com `{"erro": true}` quando o CEP não existe. Ele
  // mudou de booleano para a string "true" em 2024 — os dois são aceitos aqui
  // para a busca não quebrar quando ele mudar de novo.
  erro: z.union([z.boolean(), z.string()]).optional(),
});

export const somenteDigitos = (v: string) => v.replace(/\D/g, "");

/**
 * Busca o CEP. Devolve `null` quando o CEP é válido mas não existe — isso não
 * é erro de sistema, é CEP digitado errado, e a tela trata diferente.
 */
export async function buscarCep(cepBruto: string): Promise<EnderecoDoCep | null> {
  const cep = somenteDigitos(cepBruto);

  // Barrado aqui, antes da rede: um CEP com menos de oito dígitos nunca vai
  // existir, e não há por que gastar uma requisição a cada tecla digitada.
  if (cep.length !== 8) {
    throw new CepInvalidoError("CEP precisa ter 8 dígitos.");
  }

  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), cfg.CEP_TIMEOUT_MS);

  let dados: unknown;
  try {
    const resposta = await fetch(`${cfg.CEP_BASE_URL}/${cep}/json/`, {
      signal: controlador.signal,
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    dados = await resposta.json();
  } catch {
    // O motivo não interessa a quem está preenchendo o formulário: fora do ar,
    // lento ou recusando, o próximo passo é o mesmo — digitar à mão.
    throw new CepIndisponivelError(
      "Não conseguimos buscar o CEP agora. Preencha o endereço à mão.",
    );
  } finally {
    clearTimeout(relogio);
  }

  const lido = respostaViaCep.safeParse(dados);
  if (!lido.success) throw new CepIndisponivelError("Resposta inesperada do serviço de CEP.");
  if (lido.data.erro) return null;

  const endereco = {
    cep,
    logradouro: (lido.data.logradouro ?? "").trim(),
    bairro: (lido.data.bairro ?? "").trim(),
    cidade: (lido.data.localidade ?? "").trim(),
    estado: (lido.data.uf ?? "").trim().toUpperCase(),
  };

  // CEP de cidade inteira (os terminados em -000 de município pequeno) vem sem
  // logradouro. Ainda serve: preenche cidade e estado, e a pessoa digita a rua.
  if (!endereco.cidade) return null;

  return endereco;
}
