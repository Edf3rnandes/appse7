import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fstatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env, googleConfigurado, legadoConfigurado } from "./config/env.js";
import authPlugin from "./plugins/auth.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { portalRoutes } from "./modules/escola/portal.routes.js";
import { encerrarPoolLegado } from "./db/legacy/pool.js";
import { prisma } from "./lib/prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: true, trustProxy: true });

  // Sem isto, todo `schema.parse()` que falha vira 500 generico em vez de 400
  // com a mensagem util. Mesma decisao ja tomada no se7-inadimplencia.
  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    if (err instanceof ZodError) {
      const mensagem = err.issues.map((i) => i.message).join("; ");
      return reply.code(400).send({ message: mensagem || "Dados invalidos." });
    }
    request.log.error(err);
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.code(statusCode).send({
      message: statusCode < 500 ? err.message : "Erro interno.",
    });
  });

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

  // Diz o que esta ligado sem exigir login — util no deploy para saber se o
  // servico subiu com as integracoes que voce esperava.
  app.get("/health", async () => ({
    ok: true,
    google: googleConfigurado,
    legado: legadoConfigurado,
  }));

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
