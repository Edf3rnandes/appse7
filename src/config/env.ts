import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // Postgres proprio do Hub (Supabase). Nunca o MySQL do Laravel.
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, "JWT_SECRET precisa de pelo menos 32 caracteres."),
  PORT: z.coerce.number().default(3400),

  // Client ID do projeto no Google Cloud (OAuth 2.0, tipo "Aplicativo Web").
  // O mesmo ID vale para o site e para o app dos professores — o servidor so
  // valida o id_token, nao guarda client secret nenhum.
  GOOGLE_CLIENT_ID: z.string().default(""),

  // MySQL do Laravel, SOMENTE LEITURA. Opcional de proposito: o Hub sobe sem
  // ele e as rotas que dependem do legado respondem 503 com mensagem clara,
  // em vez de derrubar o app inteiro.
  LEGACY_MYSQL_HOST: z.string().default(""),
  LEGACY_MYSQL_PORT: z.coerce.number().default(3306),
  LEGACY_MYSQL_USER: z.string().default(""),
  LEGACY_MYSQL_PASSWORD: z.string().default(""),
  LEGACY_MYSQL_DATABASE: z.string().default(""),

  // Contas que ganham ADMIN automaticamente no primeiro login com Google.
  // Serve para o bootstrap: sem isso nao existe ninguem para emitir o primeiro
  // convite. Lista separada por virgula.
  ADMIN_EMAILS: z.string().default(""),

  // Quantas tentativas de vinculo por CPF uma conta pode errar por hora antes
  // de ser barrada. Freio contra varredura de CPF por quem ja tem login.
  VINCULO_MAX_TENTATIVAS_HORA: z.coerce.number().default(5),
});

export const env = schema.parse(process.env);

export const legadoConfigurado =
  env.LEGACY_MYSQL_HOST !== "" && env.LEGACY_MYSQL_DATABASE !== "";

export const googleConfigurado = env.GOOGLE_CLIENT_ID !== "";

export const adminEmails = env.ADMIN_EMAILS.split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e !== "");
