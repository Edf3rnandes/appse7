/* SE7 Hub — utilidades compartilhadas pelo portal e pelo app do professor. */

export const Sessao = {
  get token() { return localStorage.getItem("se7_token"); },
  set token(v) { v ? localStorage.setItem("se7_token", v) : localStorage.removeItem("se7_token"); },
  get usuario() {
    try { return JSON.parse(localStorage.getItem("se7_usuario") || "null"); }
    catch { return null; }
  },
  set usuario(v) {
    v ? localStorage.setItem("se7_usuario", JSON.stringify(v))
      : localStorage.removeItem("se7_usuario");
  },
  limpar() { this.token = null; this.usuario = null; },
};

export class ErroApi extends Error {
  constructor(mensagem, status, codigo) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

export async function api(caminho, opcoes = {}) {
  // Content-Type só quando existe corpo: o Fastify recusa com
  // "Body cannot be empty when content-type is set to 'application/json'"
  // uma requisição que declara JSON e não manda nada. Era o que quebrava
  // todos os botões de apagar — cronograma, eventos e convites.
  const resposta = await fetch(caminho, {
    ...opcoes,
    headers: {
      ...(opcoes.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(Sessao.token ? { Authorization: `Bearer ${Sessao.token}` } : {}),
      ...(opcoes.headers || {}),
    },
  });

  const corpo = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    // 401 significa token expirado ou inválido: derruba a sessão local para a
    // pessoa não ficar presa numa tela que nunca carrega.
    if (resposta.status === 401) Sessao.limpar();
    throw new ErroApi(corpo.message || "Não foi possível concluir.", resposta.status, corpo.codigo);
  }

  return corpo;
}

export const fmt = {
  moeda: (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
  // As datas do Asaas e do MySQL vêm como "AAAA-MM-DD" ou "AAAA-MM-DD hh:mm:ss".
  // Montamos a data pelos componentes para não escorregar um dia por fuso.
  data(valor) {
    if (!valor) return "—";
    const [ano, mes, dia] = String(valor).slice(0, 10).split("-").map(Number);
    if (!ano || !mes || !dia) return "—";
    return new Date(ano, mes - 1, dia).toLocaleDateString("pt-BR");
  },
  mesAno(ano, mes) {
    return new Date(ano, mes - 1, 1)
      .toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  },
  // "seg, 09/09" — o professor se orienta pelo dia da semana, não pela data.
  diaCurto(valor) {
    if (!valor) return "—";
    const [ano, mes, dia] = String(valor).slice(0, 10).split("-").map(Number);
    if (!ano) return "—";
    const d = new Date(ano, mes - 1, dia);
    const semana = d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
    return `${semana}, ${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}`;
  },
  hojeIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },
  cpf(valor) {
    const d = String(valor).replace(/\D/g, "").slice(0, 11);
    return d
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
  },
};

export function escapar(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}

/** Carrega o Google Identity Services e desenha o botão de entrar. */
export async function iniciarGoogle(alvo, aoEntrar, aoFalhar) {
  let cfg;
  try {
    cfg = await (await fetch("/auth/config")).json();
  } catch {
    return aoFalhar("Não foi possível falar com o servidor. Tente novamente em instantes.");
  }

  if (!cfg.google || !cfg.clientId) {
    return aoFalhar("O login com Google ainda não foi configurado neste servidor.");
  }

  await new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("script"));
    document.head.appendChild(s);
  }).catch(() => aoFalhar("Não foi possível carregar o login do Google."));

  if (!window.google?.accounts?.id) return;

  window.google.accounts.id.initialize({
    client_id: cfg.clientId,
    callback: (resposta) => aoEntrar(resposta.credential),
  });

  window.google.accounts.id.renderButton(alvo, {
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
    size: "large",
    shape: "pill",
    text: "signin_with",
    locale: "pt-BR",
    width: 280,
  });
}

/**
 * Reduz e recomprime a arte da semana no navegador, antes de enviar.
 *
 * A imagem é gravada como data URL na própria linha do cronograma (é ~1 por
 * semana, não justifica bucket). Uma foto crua de celular passa de 5 MB e
 * viraria uma linha gigante no banco e uma tela lenta no celular do professor.
 * 1400px no maior lado e JPEG 0.82 deixam a arte legível em qualquer aparelho
 * e o arquivo bem abaixo do limite do servidor.
 */
export async function prepararImagem(arquivo, ladoMaximo = 1400, qualidade = 0.82) {
  if (!arquivo.type.startsWith("image/")) {
    throw new Error("O arquivo precisa ser uma imagem.");
  }

  const bitmap = await createImageBitmap(arquivo);
  const escala = Math.min(1, ladoMaximo / Math.max(bitmap.width, bitmap.height));
  const largura = Math.round(bitmap.width * escala);
  const altura = Math.round(bitmap.height * escala);

  const tela = document.createElement("canvas");
  tela.width = largura;
  tela.height = altura;

  const ctx = tela.getContext("2d");
  // PNG com transparência ficaria com fundo preto ao virar JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, largura, altura);
  ctx.drawImage(bitmap, 0, 0, largura, altura);
  bitmap.close?.();

  return {
    dataUrl: tela.toDataURL("image/jpeg", qualidade),
    nome: arquivo.name,
    largura,
    altura,
  };
}

/**
 * Links para as outras áreas a que a pessoa tem acesso.
 *
 * Sem isso cada página é um beco sem saída: um administrador que abre a área
 * do professor por engano lê "peça um convite à secretaria" — sendo ele a
 * secretaria — e não tem como chegar onde queria a não ser digitando a URL.
 *
 * `eu` é a resposta de /auth/eu.
 */
export function areasDisponiveis(eu, atual) {
  const papeis = eu?.papeis || [];
  const areas = [];

  if (papeis.includes("ADMIN") || papeis.includes("SECRETARIA")) {
    areas.push({ chave: "secretaria", nome: "Secretaria", href: "/secretaria.html" });
  }
  if (eu?.professorId != null) {
    areas.push({ chave: "professor", nome: "Professor", href: "/professor.html" });
  }
  if (eu?.responsavelId != null) {
    areas.push({ chave: "portal", nome: "Portal", href: "/" });
  }

  return areas.filter((a) => a.chave !== atual);
}

export function pintarNavegacao(alvo, eu, atual) {
  if (!alvo) return;
  const areas = areasDisponiveis(eu, atual);
  alvo.innerHTML = areas
    .map((a) => `<a class="link-area" href="${a.href}">${a.nome}</a>`)
    .join("");
  alvo.hidden = areas.length === 0;
}
