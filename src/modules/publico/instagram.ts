import { prisma } from "../../lib/prisma.js";
import { milissegundosAte } from "../socios/fechamento.js";

/**
 * Integração de verdade com os últimos posts do Instagram.
 *
 * Usa a "Instagram API with Instagram Login" do Meta — o sucessor da antiga
 * Instagram Basic Display API (desligada em dez/2024) — que fala direto com
 * a conta profissional (Business ou Criador de conteúdo), sem precisar de
 * uma Página do Facebook no meio. O token dura 60 dias e se renova sozinho,
 * chamando o próprio endpoint de renovação — sem app secret, sem intervenção
 * de ninguém —, contanto que o job diário rode antes do vencimento.
 *
 * O que só o dono da conta pode fazer, uma vez, fora deste sistema (documentado
 * em docs/colocar-no-ar.md):
 *   1. criar um app em developers.facebook.com e adicionar o produto Instagram;
 *   2. adicionar a própria conta do Instagram como testadora do app;
 *   3. gerar o primeiro token de vida longa e pegar o ID da conta.
 *
 * A partir daí, colar os dois na tela Site: integrações é o bastante — o
 * resto (renovar o token, buscar posts novos) roda sozinho.
 */

const CHAVE_CONTA_ID = "instagram.contaId";
const CHAVE_TOKEN = "instagram.accessToken";
const CHAVE_TOKEN_EXPIRA = "instagram.tokenExpiraEm";
const CHAVE_ULTIMA_SINCRONIA = "instagram.ultimaSincronia";

const GRAPH = "https://graph.instagram.com";

// Renova quando faltam menos de 10 dias — dá folga para tentar de novo em
// caso de falha antes do token expirar de fato.
const DIAS_PARA_RENOVAR = 10;
const QTD_POSTS = 12;

async function lerValor(chave: string): Promise<string | null> {
  const r = await prisma.configuracao.findUnique({ where: { chave } }).catch(() => null);
  return r?.valor ?? null;
}

async function gravarValor(chave: string, valor: string) {
  await prisma.configuracao.upsert({ where: { chave }, create: { chave, valor }, update: { valor } });
}

async function apagarValor(chave: string) {
  await prisma.configuracao.deleteMany({ where: { chave } });
}

interface UltimaSincronia {
  status: "ok" | "erro";
  em: string;
  mensagem: string;
}

async function registrarSincronia(status: UltimaSincronia) {
  await gravarValor(CHAVE_ULTIMA_SINCRONIA, JSON.stringify(status));
}

export async function statusIntegracaoInstagram() {
  const [contaId, token, expiraEm, ultimaSincroniaTexto, qtdPosts] = await Promise.all([
    lerValor(CHAVE_CONTA_ID),
    lerValor(CHAVE_TOKEN),
    lerValor(CHAVE_TOKEN_EXPIRA),
    lerValor(CHAVE_ULTIMA_SINCRONIA),
    prisma.instagramPost.count(),
  ]);

  let ultimaSincronia: UltimaSincronia | null = null;
  if (ultimaSincroniaTexto) {
    try {
      ultimaSincronia = JSON.parse(ultimaSincroniaTexto);
    } catch {
      ultimaSincronia = null;
    }
  }

  return {
    conectado: Boolean(contaId && token),
    contaId: contaId ?? "",
    expiraEm: expiraEm ?? null,
    ultimaSincronia,
    qtdPosts,
  };
}

/** Liga a integração: guarda conta + token, e já tenta a primeira busca para confirmar que funciona. */
export async function conectarInstagram(contaId: string, accessToken: string) {
  await gravarValor(CHAVE_CONTA_ID, contaId);
  await gravarValor(CHAVE_TOKEN, accessToken);
  // 60 dias é o prazo padrão do token de vida longa do Instagram — o mesmo
  // que o próprio endpoint de renovação devolve depois, então nasce com essa
  // validade e é corrigido no primeiro ciclo se o Meta disser outra coisa.
  await gravarValor(CHAVE_TOKEN_EXPIRA, new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString());
  return sincronizarInstagram();
}

export async function desconectarInstagram() {
  await apagarValor(CHAVE_CONTA_ID);
  await apagarValor(CHAVE_TOKEN);
  await apagarValor(CHAVE_TOKEN_EXPIRA);
  await apagarValor(CHAVE_ULTIMA_SINCRONIA);
  // Sem a integração ligada, a página volta pra galeria manual (ou pro botão
  // sozinho) — posts antigos guardados aqui só confundiriam quem edita.
  await prisma.instagramPost.deleteMany({});
}

async function renovarTokenSeNecessario(): Promise<string | null> {
  const token = await lerValor(CHAVE_TOKEN);
  if (!token) return null;

  const expiraEm = await lerValor(CHAVE_TOKEN_EXPIRA);
  const faltam = expiraEm ? (new Date(expiraEm).getTime() - Date.now()) / (24 * 3600 * 1000) : 0;
  if (expiraEm && faltam > DIAS_PARA_RENOVAR) return token;

  const resposta = await fetch(
    `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
  const corpo = await resposta.json().catch(() => null);
  if (!resposta.ok || !corpo?.access_token) {
    throw new Error(corpo?.error?.message || "Não consegui renovar o token do Instagram.");
  }

  await gravarValor(CHAVE_TOKEN, corpo.access_token);
  await gravarValor(
    CHAVE_TOKEN_EXPIRA,
    new Date(Date.now() + (corpo.expires_in ?? 60 * 24 * 3600) * 1000).toISOString(),
  );
  return corpo.access_token as string;
}

interface MediaInstagram {
  id: string;
  caption?: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_url?: string;
  thumbnail_url?: string;
  permalink: string;
  timestamp: string;
}

/** Vídeo mostra a capa (`thumbnail_url`); álbum sem imagem própria fica de fora — não há o que exibir. */
export function urlDaImagem(media: MediaInstagram): string | null {
  if (media.media_type === "VIDEO") return media.thumbnail_url ?? null;
  return media.media_url ?? media.thumbnail_url ?? null;
}

/**
 * Busca os posts mais recentes e substitui o cache local.
 *
 * Não é a rota pública que chama o Instagram — é este job, uma vez por dia
 * (mais a chamada imediata ao conectar). A página de entrada só lê
 * `InstagramPost`, nunca o Instagram direto: o token nunca sai deste
 * servidor, e uma instabilidade do lado do Meta não trava a página de
 * ninguém, só deixa o cache um pouco mais velho.
 */
export async function sincronizarInstagram() {
  const contaId = await lerValor(CHAVE_CONTA_ID);
  if (!contaId) return { sincronizado: false, motivo: "não configurado" as const };

  try {
    const token = await renovarTokenSeNecessario();
    if (!token) return { sincronizado: false, motivo: "não configurado" as const };

    const campos = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
    const resposta = await fetch(
      `${GRAPH}/${contaId}/media?fields=${campos}&limit=${QTD_POSTS}&access_token=${encodeURIComponent(token)}`,
    );
    const corpo = await resposta.json().catch(() => null);
    if (!resposta.ok || !Array.isArray(corpo?.data)) {
      throw new Error(corpo?.error?.message || "O Instagram não respondeu com uma lista de posts.");
    }

    const posts: MediaInstagram[] = corpo.data;
    const comImagem = posts
      .map((p) => ({ post: p, imagemUrl: urlDaImagem(p) }))
      .filter((p): p is { post: MediaInstagram; imagemUrl: string } => Boolean(p.imagemUrl));

    await prisma.$transaction([
      prisma.instagramPost.deleteMany({ where: { id: { notIn: comImagem.map((p) => p.post.id) } } }),
      ...comImagem.map(({ post, imagemUrl }) =>
        prisma.instagramPost.upsert({
          where: { id: post.id },
          create: {
            id: post.id,
            imagemUrl,
            legenda: post.caption?.slice(0, 300) ?? null,
            permalink: post.permalink,
            publicadoEm: new Date(post.timestamp),
          },
          update: {
            imagemUrl,
            legenda: post.caption?.slice(0, 300) ?? null,
            permalink: post.permalink,
            publicadoEm: new Date(post.timestamp),
          },
        }),
      ),
    ]);

    await registrarSincronia({ status: "ok", em: new Date().toISOString(), mensagem: `${comImagem.length} post(s)` });
    return { sincronizado: true, posts: comImagem.length };
  } catch (erro) {
    await registrarSincronia({
      status: "erro",
      em: new Date().toISOString(),
      mensagem: erro instanceof Error ? erro.message : "Falha desconhecida.",
    });
    return { sincronizado: false, motivo: "erro" as const };
  }
}

/** Agenda a sincronização diária — mesmo padrão de `agendarCopiaDeOcupacao`. */
export function agendarSincronizacaoInstagram(fuso = process.env.TZ || "America/Fortaleza") {
  const agendar = () => {
    const espera = milissegundosAte(4, 0, fuso);
    const relogio = setTimeout(async () => {
      try {
        await sincronizarInstagram();
      } catch {
        // Erro já fica registrado em CHAVE_ULTIMA_SINCRONIA pelo try/catch
        // interno de sincronizarInstagram(); aqui só garante que o
        // agendamento de amanhã não para por causa de hoje.
      }
      agendar();
    }, espera);

    relogio.unref?.();
  };

  agendar();
}
