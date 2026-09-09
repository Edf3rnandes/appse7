import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fstatic from "@fastify/static";
import Fastify from "fastify";
import { env, googleConfigurado, legadoConfigurado } from "./config/env.js";
import authPlugin from "./plugins/auth.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { portalRoutes } from "./modules/escola/portal.routes.js";
import { professorRoutes } from "./modules/escola/professor.routes.js";
import { conteudoRoutes } from "./modules/conteudo/conteudo.routes.js";
import { cadastroRoutes } from "./modules/escola/cadastro.routes.js";
import { publicoRoutes } from "./modules/publico/matricula.routes.js";
import { encerrarPoolLegado } from "./db/legacy/pool.js";
import { prisma } from "./lib/prisma.js";
import { tratadorDeErro } from "./lib/erros.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true, trustProxy: true });

  // Sem isto, todo `schema.parse()` que falha vira 500 generico em vez de 400
  // com a mensagem util.
  app.setErrorHandler(tratadorDeErro());

  await app.register(cors, { origin: true });

  // Limite global folgado, so para conter abuso grosseiro. As rotas de auth
  // (login e vinculo por CPF) tem limite proprio, bem mais apertado, definido
  // dentro do escopo em authRoutes.
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });

  await app.register(authPlugin);

  // O portal e o app do professor sao paginas estaticas servidas pelo proprio
  // Hub — sem build, sem framework. Cache desligado enquanto o front esta em
  // desenvolvimento ativo: o navegador nao pode servir versao antiga a cada
  // ajuste.
  await app.register(fstatic, {
    root: path.join(__dirname, "..", "public"),
    cacheControl: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  });

  await app.register(async (escopo) => {
    await escopo.register(rateLimit, { max: 20, timeWindow: "1 minute" });
    await escopo.register(authRoutes);
  });

  await app.register(portalRoutes);
  await app.register(professorRoutes);
  await app.register(conteudoRoutes);
  await app.register(cadastroRoutes);

  // Aberto na internet, com limite próprio — ver o cabeçalho do módulo.
  await app.register(publicoRoutes);

  // Diz o que esta ligado sem exigir login — e o que se olha depois de um
  // deploy para saber se as integracoes subiram como esperado.
  //
  // `banco` e `cronogramaCompartilhado` custam uma consulta cada, mas sao
  // exatamente o que falta descobrir num primeiro deploy: se a DATABASE_URL
  // esta certa, e se ela aponta mesmo para o Postgres onde o se7-inadimplencia
  // guarda o cronograma. Descobrir isso pela tela de login quebrando seria bem
  // pior. Sao booleanos de configuracao, nao expoem dado nenhum, e a rota
  // continua sob o limite global de requisicoes.
  app.get("/health", async () => {
    const banco = await prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch(() => false);

    const cronogramaCompartilhado = banco
      ? await prisma
          .$queryRaw`SELECT 1 FROM public.cronograma_semanas LIMIT 1`
          .then(() => true)
          .catch(() => false)
      : false;

    return {
      ok: true,
      banco,
      cronogramaCompartilhado,
      google: googleConfigurado,
      // A escola mora neste banco. A ponte com o MySQL do Laravel serve
      // agora só à importação única — por isso ela aparece aqui como um
      // recurso de migração, não como algo de que a aplicação dependa.
      importacaoLegadoPronta: legadoConfigurado,
    };
  });

  const encerrar = async () => {
    await app.close();
    await encerrarPoolLegado();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", encerrar);
  process.on("SIGINT", encerrar);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
