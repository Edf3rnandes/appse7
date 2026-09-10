import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // Postgres do Hub (Supabase), compartilhado com o se7-inadimplencia.
  // Nunca o MySQL do Laravel.
  DATABASE_URL: z.string().min(1),

  // Opcional de proposito. O Prisma Client so usa `url` em tempo de execucao;
  // `directUrl` existe para o CLI (db push, migrate). Como o servico em
  // producao nao roda migracao — as tabelas do Hub sao criadas por
  // prisma/instalar-no-supabase.sql —, exigir esta variavel so criaria um
  // obstaculo: o proprio se7-cobrancas nao a tem configurada.
  //
  // Preencha apenas para rodar mudanca de schema, e ai com a conexao direta
  // (porta 5432): pelo pooler de transacao (6543) elas nao passam.
  DIRECT_URL: z.string().default(""),

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

  // API do proprio Laravel, usada so para GRAVAR frequencia.
  //
  // A ponte com o MySQL e e continua somente leitura. Para o lancamento de
  // frequencia funcionar de verdade hoje, ele precisa cair onde os relatorios
  // da escola leem — a tabela `attendances` do Laravel. Em vez de abrir a
  // conexao para escrita, o Hub chama o endpoint que o proprio Laravel ja
  // expoe (POST /api/attendances), com o token do professor. Assim a regra
  // "so SELECT no legado" continua valendo e a checagem de frequencia
  // duplicada do Laravel continua sendo a unica fonte da verdade.
  // Ex.: https://sistema.se7volei.com.br

  // Contas que ganham ADMIN automaticamente no primeiro login com Google.
  // Serve para o bootstrap: sem isso nao existe ninguem para emitir o primeiro
  // convite. Lista separada por virgula.
  ADMIN_EMAILS: z.string().default(""),
  SOCIO_EMAILS: z.string().default(""),

  // Quantas tentativas de vinculo por CPF uma conta pode errar por hora antes
  // de ser barrada. Freio contra varredura de CPF por quem ja tem login.
  VINCULO_MAX_TENTATIVAS_HORA: z.coerce.number().default(5),
});

export const env = schema.parse(process.env);

export const legadoConfigurado =
  env.LEGACY_MYSQL_HOST !== "" && env.LEGACY_MYSQL_DATABASE !== "";

export const googleConfigurado = env.GOOGLE_CLIENT_ID !== "";


const listaDeEmails = (bruto: string) =>
  bruto
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");

export const adminEmails = listaDeEmails(env.ADMIN_EMAILS);

/**
 * Os donos. Papel separado de ADMIN de propósito, e nao derivado dele: ADMIN e
 * quem administra a escola, SOCIO e quem ve o resultado dela. Somar os dois
 * automaticamente daria acesso ao painel financeiro a qualquer pessoa que a
 * escola precise tornar administradora um dia.
 *
 * Existe como variavel porque o primeiro socio nao tem quem o convide: so
 * socio convida socio, e sem esta linha a area nasceria inalcancavel.
 */
export const socioEmails = listaDeEmails(env.SOCIO_EMAILS);
