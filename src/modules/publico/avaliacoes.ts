import { lerConfig } from "../conteudo/conteudo.routes.js";

/**
 * Avaliações do Google Maps (Google Meu Negócio) da escola.
 *
 * Precisa de duas coisas, as duas configuráveis sem deploy:
 *   - `GOOGLE_PLACES_API_KEY`, uma chave da Places API no Google Cloud — vai
 *     em variável de ambiente porque é credencial, não conteúdo (mesma regra
 *     de ASAAS_API_KEY);
 *   - o Place ID do local, colado pelo administrativo na tela de
 *     configurações — não é segredo (aparece em qualquer link do Google
 *     Maps do lugar), por isso mora em Configuracao, não em variável de
 *     ambiente.
 *
 * Sem as duas, a seção "O que dizem sobre a gente" da página de entrada
 * mostra os depoimentos fixos — nunca fica vazia por falta de configuração.
 *
 * A busca é cacheada em memória por algumas horas: a Places API cobra por
 * chamada (a cota gratuita mensal do Google costuma cobrir um site pequeno
 * de sobra, mas buscar de novo a cada visita da página de entrada gastaria
 * essa cota sem necessidade — a nota de um lugar não muda a cada minuto).
 */

const TTL_MS = 12 * 3600 * 1000;

interface Avaliacao {
  autor: string;
  nota: number;
  texto: string;
  quando: string;
  // Foto do perfil de quem avaliou, hospedada pelo próprio Google — vem
  // pronta da Places API, e cai bem no cartão do depoimento. Sem ela (o
  // Google nem sempre manda), a tela usa a inicial do nome.
  foto: string | null;
}

interface Resultado {
  nota: number | null;
  total: number | null;
  avaliacoes: Avaliacao[];
}

let cache: { placeId: string; dados: Resultado; buscadoEm: number } | null = null;

export async function buscarAvaliacoesGoogle(): Promise<
  | { configurado: false }
  | { configurado: true; disponivel: false }
  | { configurado: true; disponivel: true; dados: Resultado }
> {
  const config = await lerConfig();
  const placeId = config.googlePlaceId;
  const chave = process.env.GOOGLE_PLACES_API_KEY;
  if (!placeId || !chave) return { configurado: false };

  if (cache && cache.placeId === placeId && Date.now() - cache.buscadoEm < TTL_MS) {
    return { configurado: true, disponivel: true, dados: cache.dados };
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total,reviews` +
      `&language=pt-BR&key=${encodeURIComponent(chave)}`;
    const resposta = await fetch(url);
    const corpo = await resposta.json();
    if (corpo.status !== "OK") throw new Error(corpo.error_message || corpo.status);

    const dados: Resultado = {
      nota: corpo.result?.rating ?? null,
      total: corpo.result?.user_ratings_total ?? null,
      avaliacoes: (corpo.result?.reviews ?? []).slice(0, 6).map((r: any) => ({
        autor: r.author_name,
        nota: r.rating,
        texto: r.text,
        quando: r.relative_time_description,
        foto: r.profile_photo_url ?? null,
      })),
    };
    cache = { placeId, dados, buscadoEm: Date.now() };
    return { configurado: true, disponivel: true, dados };
  } catch {
    // Falha na busca: um cache velho do mesmo lugar ainda vale mais que nada.
    if (cache && cache.placeId === placeId) {
      return { configurado: true, disponivel: true, dados: cache.dados };
    }
    return { configurado: true, disponivel: false };
  }
}
