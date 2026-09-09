import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusOcorrencia, TipoEvento } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { hoje, primeiroDiaDoMes, segundaDaSemana } from "../../lib/datas.js";
import { LegadoIndisponivelError } from "../../db/legacy/pool.js";
import {
  listarMatriculasRecentes,
  obterNumerosDaEscola,
} from "../../db/legacy/escola.repository.js";
import { tratadorDeErro } from "../../lib/erros.js";
import {
  CronogramaIndisponivelError,
  apagarSemana,
  listarSemanas,
  obterPublicadasComArte,
  obterSemanaPorId,
  salvarSemana,
} from "../../db/compartilhado/cronograma.repository.js";

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

// A arte da semana chega como data URL. O navegador já reduz e recomprime
// antes de enviar; o limite aqui é a última barreira, para uma foto de celular
// crua não virar uma linha de 8 MB no Postgres.
const LIMITE_IMAGEM = 2_000_000;

const imagemDataUrl = z
  .string()
  .refine((v) => /^data:image\/(jpeg|png|webp);base64,/.test(v), "Formato de imagem não aceito.")
  .refine((v) => v.length <= LIMITE_IMAGEM, "A imagem ficou grande demais. Use uma menor.");

const STATUS = ["planejado", "pronto", "publicado"] as const;

const cronogramaSchema = z.object({
  semana: dataIso,
  tema: z.string().max(200).optional(),
  fundamentos: z.string().max(2000).optional(),
  exerciciosSugeridos: z.string().max(4000).optional(),
  observacoes: z.string().max(2000).optional(),
  postagensPlanejadas: z.string().max(2000).optional(),
  textoDivulgacao: z.string().max(4000).optional(),
  // null apaga a arte; ausente mantém a que já está lá.
  imagemBase64: imagemDataUrl.nullable().optional(),
  imagemNome: z.string().max(200).nullable().optional(),
  status: z.enum(STATUS).default("planejado"),
});

const eventoSchema = z.object({
  // required_error além do min(): campo ausente devolveria o "Required" cru do
  // Zod, e é essa mensagem que a secretaria lê na tela.
  titulo: z
    .string({ required_error: "Título é obrigatório." })
    .min(1, "Título é obrigatório.")
    .max(200),
  descricao: z.string().max(2000).optional(),
  tipo: z.nativeEnum(TipoEvento).default(TipoEvento.OUTRO),
  data: dataIso,
  dataFim: dataIso.optional(),
  horario: z.string().max(60).optional(),
  local: z.string().max(200).optional(),
  unidadeIdLegacy: z.number().int().positive().optional(),
  unidadeNome: z.string().max(120).optional(),
  publicado: z.boolean().default(false),
});

const idParams = z.object({ id: z.string().uuid() });

// Chaves permitidas, uma a uma. Uma tabela chave/valor sem lista fechada vira
// depósito de qualquer coisa que o cliente resolva mandar.
const CHAVE_CANVA = "cronograma.linkCanva";

const configSchema = z.object({
  // String vazia apaga o link — é como a secretaria "remove" o documento.
  linkCanva: z.union([z.string().url("Link do Canva inválido.").max(500), z.literal("")]),
});

/**
 * Quem alimenta o que o professor lê: cronograma das semanas e eventos do mês.
 * Só secretaria e admin escrevem — o professor tem só as rotas de leitura em
 * /professor/*.
 */
export async function conteudoRoutes(app: FastifyInstance) {
  const somenteEquipe = { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] };

  app.setErrorHandler(
    tratadorDeErro((erro) =>
      // O cronograma vive numa tabela do se7-inadimplencia. Se o Hub estiver
      // apontando para outro banco, a tela precisa dizer isso.
      erro instanceof CronogramaIndisponivelError
        ? { status: 503, mensagem: erro.message }
        : undefined,
    ),
  );

  // ------------------------------------------------------- painel
  //
  // A primeira tela de quem abre o sistema. Antes dela a secretaria caía num
  // formulário em branco de cronograma: tudo que o sistema sabe existia, mas
  // só para quem soubesse em qual aba clicar.
  //
  // Duas metades, de propósito:
  //
  //   - O que é do Hub (ocorrências, semana, eventos) responde sempre, porque
  //     mora no Postgres daqui.
  //   - O que é da escola (alunos, turmas, matrículas) vem do MySQL do
  //     Laravel, que pode não estar configurado. Nesse caso o bloco devolve
  //     `disponivel: false` e a tela mostra o motivo, em vez de a página
  //     inteira falhar por causa de uma metade.
  app.get("/conteudo/painel", somenteEquipe, async () => {
    const agora = hoje();
    const segunda = segundaDaSemana(agora);
    const mes = agora.getUTCMonth() + 1;
    const inicioDoMes = primeiroDiaDoMes(agora.getUTCFullYear(), mes);
    // Mês 13 vira janeiro do ano seguinte sozinho — o Date faz a virada, e
    // escrever o caso de dezembro à mão só criaria uma chance a mais de errar.
    const inicioDoProximoMes = primeiroDiaDoMes(agora.getUTCFullYear(), mes + 1);

    const [ocorrenciasAbertas, ocorrenciasRecentes, eventos, semanaAtual, escola] =
      await Promise.all([
        prisma.ocorrencia.count({ where: { status: StatusOcorrencia.ABERTA } }),
        prisma.ocorrencia.findMany({
          where: { status: StatusOcorrencia.ABERTA },
          orderBy: { criadoEm: "asc" },
          take: 5,
        }),
        prisma.evento.findMany({
          where: { data: { gte: agora }, publicado: true },
          orderBy: { data: "asc" },
          take: 5,
        }),
        // Só a semana corrente, e só se publicada: é exatamente o que o
        // professor está vendo no app dele neste momento.
        obterPublicadasComArte([segunda])
          .then((linhas) => (linhas[0] ? { semana: linhas[0].semana, tema: linhas[0].tema } : null))
          .catch(() => null),
        numerosDaEscola(inicioDoMes, inicioDoProximoMes),
      ]);

    return {
      hub: {
        ocorrenciasAbertas,
        ocorrenciasRecentes,
        eventos,
        semanaAtual,
        semanaDeReferencia: segunda,
      },
      escola,
    };
  });

  // ------------------------------------------------------- configuração
  //
  // O link do Canva é UM documento que rege todas as semanas, não um por
  // semana — por isso mora aqui, e não em cada linha do cronograma.
  app.get("/conteudo/config", somenteEquipe, async () => {
    const registro = await prisma.configuracao
      .findUnique({ where: { chave: CHAVE_CANVA } })
      .catch(() => null);

    return { linkCanva: registro?.valor ?? "" };
  });

  app.put("/conteudo/config", somenteEquipe, async (request) => {
    const { linkCanva } = configSchema.parse(request.body);

    if (linkCanva === "") {
      await prisma.configuracao.deleteMany({ where: { chave: CHAVE_CANVA } });
      return { linkCanva: "" };
    }

    const registro = await prisma.configuracao.upsert({
      where: { chave: CHAVE_CANVA },
      create: { chave: CHAVE_CANVA, valor: linkCanva },
      update: { valor: linkCanva },
    });

    return { linkCanva: registro.valor };
  });

  // ------------------------------------------------------- cronograma
  app.get("/conteudo/cronograma", somenteEquipe, async (request) => {
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(60).default(20) })
      .parse(request.query);

    return listarSemanas(limite);
  });

  // A semana completa, com a arte — é o que a tela de edição carrega.
  app.get("/conteudo/cronograma/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const semana = await obterSemanaPorId(id);
    if (!semana) return reply.code(404).send({ message: "Semana não encontrada." });
    return semana;
  });

  // Upsert pela semana: a segunda-feira é a chave natural, então salvar duas
  // vezes a mesma semana corrige em vez de duplicar.
  app.put(
    "/conteudo/cronograma",
    // O padrão do Fastify é 1 MB e não caberia a arte da semana. O limite maior
    // vale só para esta rota, não para o app inteiro.
    { ...somenteEquipe, bodyLimit: 6_000_000 },
    async (request, reply) => {
      const corpo = cronogramaSchema.parse(request.body);

      // Normaliza para a segunda-feira: se vier uma quarta, a semana é a mesma,
      // e sem isso viraria uma segunda linha para o mesmo período.
      const semana = segundaDaSemana(corpo.semana);

      const dados = {
        tema: corpo.tema ?? null,
        fundamentos: corpo.fundamentos ?? null,
        exerciciosSugeridos: corpo.exerciciosSugeridos ?? null,
        observacoes: corpo.observacoes ?? null,
        postagensPlanejadas: corpo.postagensPlanejadas ?? null,
        textoDivulgacao: corpo.textoDivulgacao ?? null,
        // Preservado como está: a coluna pertence à tabela do se7-inadimplencia
        // e pode ter valor por semana gravado por lá. O Hub não escreve mais
        // nela — o link agora é único, em hub.configuracoes.
        linkCanva: undefined,
        status: corpo.status,
        // `undefined` preserva a arte que já está gravada; `null` apaga.
        ...(corpo.imagemBase64 === undefined
          ? {}
          : { imagemBase64: corpo.imagemBase64, imagemNome: corpo.imagemNome ?? null }),
      };


      return reply.code(200).send(await salvarSemana(semana, dados));
    },
  );

  app.delete("/conteudo/cronograma/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await apagarSemana(id);
    return reply.code(204).send();
  });

  // ------------------------------------------------------- ocorrências
  app.get("/conteudo/ocorrencias", somenteEquipe, async (request) => {
    const { status } = z
      .object({ status: z.nativeEnum(StatusOcorrencia).optional() })
      .parse(request.query);

    return prisma.ocorrencia.findMany({
      where: status ? { status } : undefined,
      // Abertas primeiro, e as mais antigas no topo dentro delas: o que está
      // esperando há mais tempo é o que precisa de resposta.
      orderBy: [{ status: "asc" }, { criadoEm: "asc" }],
      take: 200,
    });
  });

  app.patch("/conteudo/ocorrencias/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { status, resposta } = z
      .object({
        status: z.nativeEnum(StatusOcorrencia),
        resposta: z.string().max(2000).optional(),
      })
      .parse(request.body);

    const existe = await prisma.ocorrencia.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Ocorrência não encontrada." });

    return prisma.ocorrencia.update({
      where: { id },
      data: {
        status,
        resposta: resposta ?? null,
        // Reabrir limpa o carimbo: senão a tela mostraria "resolvida em" numa
        // ocorrência que voltou a estar aberta.
        resolvidoPorId: status === StatusOcorrencia.RESOLVIDA ? request.user.sub : null,
        resolvidoEm: status === StatusOcorrencia.RESOLVIDA ? new Date() : null,
      },
    });
  });

  // ------------------------------------------------------- eventos
  app.get("/conteudo/eventos", somenteEquipe, async (request) => {
    const { desde } = z.object({ desde: dataIso.optional() }).parse(request.query);

    return prisma.evento.findMany({
      where: desde ? { data: { gte: desde } } : undefined,
      orderBy: { data: "asc" },
      take: 200,
    });
  });

  app.post("/conteudo/eventos", somenteEquipe, async (request, reply) => {
    const corpo = eventoSchema.parse(request.body);

    if (corpo.dataFim && corpo.dataFim < corpo.data) {
      return reply.code(400).send({ message: "A data final não pode ser antes da inicial." });
    }

    const evento = await prisma.evento.create({ data: montarEvento(corpo) });
    return reply.code(201).send(evento);
  });

  app.put("/conteudo/eventos/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const corpo = eventoSchema.parse(request.body);

    if (corpo.dataFim && corpo.dataFim < corpo.data) {
      return reply.code(400).send({ message: "A data final não pode ser antes da inicial." });
    }

    const existe = await prisma.evento.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Evento não encontrado." });

    return prisma.evento.update({ where: { id }, data: montarEvento(corpo) });
  });

  app.delete("/conteudo/eventos/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.evento.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });
}

function montarEvento(corpo: z.infer<typeof eventoSchema>) {
  return {
    titulo: corpo.titulo,
    descricao: corpo.descricao ?? null,
    tipo: corpo.tipo,
    data: corpo.data,
    dataFim: corpo.dataFim ?? null,
    horario: corpo.horario ?? null,
    local: corpo.local ?? null,
    unidadeIdLegacy: corpo.unidadeIdLegacy ?? null,
    unidadeNome: corpo.unidadeNome ?? null,
    publicado: corpo.publicado,
  };
}

/**
 * A metade do painel que vem do sistema atual.
 *
 * Falhar aqui não pode derrubar a tela: enquanto a credencial de leitura do
 * MySQL não sair, `disponivel: false` é a resposta correta e esperada, não um
 * erro. O mesmo vale para uma queda momentânea daquele banco — a secretaria
 * continua enxergando ocorrências e eventos.
 */
async function numerosDaEscola(inicioDoMes: Date, inicioDoProximoMes: Date) {
  const iso = (d: Date) => `${d.toISOString().slice(0, 10)} 00:00:00`;

  try {
    const [numeros, matriculas] = await Promise.all([
      obterNumerosDaEscola(iso(inicioDoMes), iso(inicioDoProximoMes)),
      listarMatriculasRecentes(20),
    ]);
    return { disponivel: true as const, numeros, matriculas };
  } catch (erro) {
    if (erro instanceof LegadoIndisponivelError) {
      return {
        disponivel: false as const,
        motivo:
          "Ainda sem acesso de leitura ao sistema atual. Os números da escola aparecem aqui assim que a credencial for liberada.",
      };
    }
    return {
      disponivel: false as const,
      motivo: "Não foi possível ler o sistema atual agora. Tente de novo em instantes.",
    };
  }
}
