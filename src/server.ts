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
import { cobrancaRoutes } from "./modules/financeiro/cobranca.routes.js";
import { sociosRoutes } from "./modules/socios/socios.routes.js";
import { agendarFechamento, preencherDiasEmFalta } from "./modules/socios/fechamento.js";
import {
  agendarCopiaDeOcupacao,
  copiarOcupacaoParaCobrancas,
} from "./modules/socios/ocupacao-cobrancas.js";
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

  // Limite global folgado, so para conter abuso grosseiro. As TRES portas de
  // entrada — login por senha, login pelo Google e vinculo por CPF — tem
  // limite proprio, bem mais apertado, declarado em cada uma delas.
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

  // Sem escopo de limite em volta: quem precisa dele sao as portas de entrada,
  // e elas o declaram uma a uma. O porque esta em authRoutes.
  await app.register(authRoutes);

  await app.register(portalRoutes);
  await app.register(professorRoutes);
  await app.register(conteudoRoutes);
  await app.register(cadastroRoutes);
  await app.register(cobrancaRoutes);
  await app.register(sociosRoutes);

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

  // Fechamento do dia: agenda o das 23:59 e preenche os dias que passaram sem
  // fechamento. O segundo cobre o caso normal de uma hospedagem que hiberna —
  // o serviço simplesmente nao estava de pe na hora — e tambem o primeiro dia
  // de vida do sistema, em que a serie inteira precisa nascer de algum lugar.
  //
  // Fora do await do listen de proposito: preencher dois meses de historico
  // nao pode atrasar o servidor a ficar de pe. Se falhar, o proximo restart
  // tenta de novo, e a rota de reprocessamento existe para o caso teimoso.
  agendarFechamento();
  preencherDiasEmFalta()
    .then((dias) => {
      if (dias.length) app.log.info({ dias: dias.length }, "fechamentos reconstruidos");
    })
    .catch((erro) => app.log.error({ erro }, "falha ao reconstruir fechamentos"));

  // Cópia da ocupação real das turmas para o se7-cobrancas — ver o cabeçalho
  // de ocupacao-cobrancas.ts. Sem efeito num Hub instalado sozinho, sem esse
  // vizinho ao lado. Roda uma vez agora (pra não esperar até 23:59 no
  // primeiro dia) e agenda a próxima pro mesmo horário do fechamento diário.
  agendarCopiaDeOcupacao();
  copiarOcupacaoParaCobrancas()
    .then((r) => {
      if (r.gravado) app.log.info({ turmas: r.turmas }, "ocupacao copiada para o se7-cobrancas");
    })
    .catch((erro) => app.log.error({ erro }, "falha ao copiar ocupacao para o se7-cobrancas"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
