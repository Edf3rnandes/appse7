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

/**
 * Desenha a tela de entrada: botão do Google e, atrás dele, a entrada por
 * e-mail e senha.
 *
 * A senha não é o caminho de ninguém no dia a dia — é a porta de serviço da
 * administração, para o sistema não ficar inacessível quando o Google não
 * está disponível (projeto ainda não criado, domínio novo sem origem
 * autorizada, ou uma queda no dia do treino). Por isso ela aparece expandida
 * só quando o Google não está configurado; havendo Google, fica recolhida
 * atrás de um link discreto.
 *
 * `aoEntrar` recebe a resposta pronta de /auth/*: { token, usuario }.
 */
export async function montarLogin(alvo, aoEntrar, aoFalhar) {
  let cfg;
  try {
    cfg = await (await fetch("/auth/config")).json();
  } catch {
    return aoFalhar("Não foi possível falar com o servidor. Tente novamente em instantes.");
  }

  const temGoogle = Boolean(cfg.google && cfg.clientId);

  if (cfg.senha) desenharFormularioDeSenha(alvo, aoEntrar, aoFalhar, temGoogle);

  if (!temGoogle) {
    // Sem Google e sem senha não há como entrar, e aí sim é um erro. Com senha
    // disponível, dizer "o Google não está configurado" seria assustar a
    // pessoa com um detalhe de servidor diante de uma tela que funciona.
    if (!cfg.senha) {
      return aoFalhar("Nenhuma forma de entrada foi configurada neste servidor.");
    }
    return;
  }

  await iniciarGoogle(alvo, cfg, aoEntrar, aoFalhar);
}

function desenharFormularioDeSenha(alvo, aoEntrar, aoFalhar, recolhido) {
  const caixa = document.createElement("div");
  caixa.className = "entrada-senha";
  caixa.innerHTML = `
    <button class="botao fantasma alternar" type="button" hidden>Entrar com e-mail e senha</button>
    <form class="pilha formulario" style="gap:14px">
      <div class="campo">
        <label class="rotulo" for="loginEmail">E-mail</label>
        <input id="loginEmail" name="email" type="email" autocomplete="username" required>
      </div>
      <div class="campo">
        <label class="rotulo" for="loginSenha">Senha</label>
        <input id="loginSenha" name="senha" type="password" autocomplete="current-password" required>
      </div>
      <button class="botao" type="submit">Entrar</button>
    </form>`;

  const alternar = caixa.querySelector(".alternar");
  const formulario = caixa.querySelector(".formulario");

  if (recolhido) {
    alternar.hidden = false;
    formulario.hidden = true;
    alternar.addEventListener("click", () => {
      formulario.hidden = false;
      alternar.hidden = true;
      caixa.querySelector("#loginEmail").focus();
    });
  }

  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = formulario.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.textContent = "Entrando…";

    try {
      const r = await api("/auth/senha", {
        method: "POST",
        body: JSON.stringify({
          email: caixa.querySelector("#loginEmail").value,
          senha: caixa.querySelector("#loginSenha").value,
        }),
      });
      aoEntrar(r);
    } catch (e) {
      aoFalhar(e.message);
      botao.disabled = false;
      botao.textContent = "Entrar";
    }
  });

  alvo.insertAdjacentElement("afterend", caixa);
}

async function iniciarGoogle(alvo, cfg, aoEntrar, aoFalhar) {
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
    callback: async (resposta) => {
      try {
        aoEntrar(
          await api("/auth/google", {
            method: "POST",
            body: JSON.stringify({ idToken: resposta.credential }),
          }),
        );
      } catch (e) {
        aoFalhar(e.message);
      }
    },
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

/**
 * Grade de calendário de um mês, com os eventos marcados nos dias.
 *
 * Uma lista responde "o que tem este mês?"; a grade responde "que dia da
 * semana isso cai?" e "tem alguma coisa perto do treino de quarta?" — que é
 * como professor e secretaria realmente pensam a agenda.
 *
 * `eventos` precisa de { data, dataFim?, titulo, tipo }. Devolve HTML.
 */
export function gradeDoMes(ano, mes, eventos, { hojeIso = null } = {}) {
  const primeiro = new Date(ano, mes - 1, 1);
  const diasNoMes = new Date(ano, mes, 0).getDate();
  // getDay: 0 = domingo. A grade começa no domingo, como todo calendário
  // impresso que a escola usa.
  const vazioAntes = primeiro.getDay();

  const doDia = new Map();
  for (const ev of eventos) {
    const inicio = String(ev.data).slice(0, 10);
    const fim = String(ev.dataFim || ev.data).slice(0, 10);
    for (let d = 1; d <= diasNoMes; d++) {
      const iso = `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      // Evento de vários dias aparece em cada dia do intervalo.
      if (iso >= inicio && iso <= fim) {
        if (!doDia.has(d)) doDia.set(d, []);
        doDia.get(d).push(ev);
      }
    }
  }

  const celulas = [];
  for (let i = 0; i < vazioAntes; i++) celulas.push(`<div class="dia-vazio"></div>`);

  for (let d = 1; d <= diasNoMes; d++) {
    const iso = `${ano}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const doHoje = hojeIso === iso;
    const lista = doDia.get(d) || [];
    celulas.push(`
      <div class="dia-grade${doHoje ? " hoje" : ""}${lista.length ? " com-evento" : ""}">
        <span class="numero">${d}</span>
        ${lista.map((ev) => `<span class="marca" title="${escapar(ev.titulo)}">${escapar(ev.titulo)}</span>`).join("")}
      </div>`);
  }

  // Completa a última semana: sem estas células o fundo da grade aparece como
  // um bloco cinza solto depois do último dia.
  while (celulas.length % 7 !== 0) {
    celulas.push(`<div class="dia-vazio"></div>`);
  }

  const cabecalho = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"]
    .map((d) => `<div class="dia-cabecalho">${d}</div>`)
    .join("");

  return `<div class="calendario">${cabecalho}${celulas.join("")}</div>`;
}

/**
 * Transforma a foto da conta Google em imagem própria do sistema.
 *
 * Copia, não aponta. Guardar a URL do Google parece mais barato e é pior: ela
 * deixa de existir quando a pessoa troca ou remove a foto, e aí a chamada
 * mostra um quadrado quebrado. Pior ainda, a lista da turma passaria a
 * depender de o celular do professor alcançar o Google — na beira da praia,
 * com sinal ruim, é justamente quando ele precisa da lista.
 *
 * O download acontece no navegador de quem está logado, que é quem já tem
 * essa imagem carregada na tela. Se o Google recusar a leitura pelo canvas
 * (é uma imagem de outro domínio), devolvemos null e a tela oferece escolher
 * um arquivo — em vez de deixar um erro sem explicação.
 */
export async function fotoDaContaGoogle(url, ladoMaximo = 400, qualidade = 0.78) {
  if (!url) return null;

  // `s400-c` pede ao Google a versão de 400px já recortada em quadrado. Sem
  // isso vem a original, que pode ter 2000px e um enquadramento largo.
  const nitida = url.replace(/=s\d+(-c)?$/, "") + "=s400-c";

  const imagem = await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = nitida;
  });
  if (!imagem) return null;

  const lado = Math.min(ladoMaximo, imagem.width, imagem.height) || ladoMaximo;
  const tela = document.createElement("canvas");
  tela.width = lado;
  tela.height = lado;

  const ctx = tela.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, lado, lado);
  // Recorte quadrado a partir do centro: fotos de perfil variam de proporção,
  // e o retrato do sistema é redondo.
  const corte = Math.min(imagem.width, imagem.height);
  ctx.drawImage(
    imagem,
    (imagem.width - corte) / 2, (imagem.height - corte) / 2, corte, corte,
    0, 0, lado, lado,
  );

  try {
    return tela.toDataURL("image/jpeg", qualidade);
  } catch {
    // Canvas contaminado: o Google não liberou a leitura desta imagem.
    return null;
  }
}
