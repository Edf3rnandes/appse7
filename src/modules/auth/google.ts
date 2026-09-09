import { OAuth2Client } from "google-auth-library";
import { env, googleConfigurado } from "../../config/env.js";

export class GoogleNaoConfiguradoError extends Error {
  constructor() {
    super("Login com Google nao configurado (GOOGLE_CLIENT_ID).");
  }
}

export class TokenGoogleInvalidoError extends Error {}

export interface PerfilGoogle {
  sub: string;
  email: string;
  nome: string;
  avatarUrl: string | null;
}

let client: OAuth2Client | null = null;

function obterClient(): OAuth2Client {
  if (!googleConfigurado) throw new GoogleNaoConfiguradoError();
  if (!client) client = new OAuth2Client(env.GOOGLE_CLIENT_ID);
  return client;
}

// O front (site, painel ou app do professor) faz o Sign-In do Google e manda so
// o id_token para ca. Quem valida assinatura, emissor, audiencia e validade e a
// biblioteca oficial — o servidor nao guarda client secret nem faz redirect.
export async function verificarIdToken(idToken: string): Promise<PerfilGoogle> {
  const ticket = await obterClient()
    .verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID })
    .catch(() => {
      throw new TokenGoogleInvalidoError("Token do Google invalido ou expirado.");
    });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new TokenGoogleInvalidoError("Token do Google sem identificacao de conta.");
  }

  // Conta Google sem email verificado nao entra: e o unico dado que liga a
  // pessoa ao convite do administrativo.
  if (payload.email_verified === false) {
    throw new TokenGoogleInvalidoError("A conta Google precisa ter o email verificado.");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    nome: payload.name?.trim() || payload.email.split("@")[0],
    avatarUrl: payload.picture ?? null,
  };
}
