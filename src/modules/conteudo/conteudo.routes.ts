import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TipoEvento } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { segundaDaSemana } from "../../lib/datas.js";

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
  linkCanva: z.string().url("Link do Canva inválido.").max(500).optional().or(z.literal("")),
  // null apaga a arte; ausente mantém a que já está lá.
  imagemBase64: imagemDataUrl.nullable().optional(),
  imagemNome: z.string().max(200).nullable().optional(),
  status: z.enum(STATUS).default("planejado"),
});

const eventoSchema = z.object({
  titulo: z.string().min(1, "Título é obrigatório.").max(200),
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

// Sem a arte: a listagem carrega dezenas de semanas e o data URL de cada uma
// deixaria a resposta na casa dos megabytes. Quem precisa da imagem pede a
// semana inteira em /conteudo/cronograma/:id.
const SEM_IMAGEM = {
  id: true, semana: true, tema: true, fundamentos: true, exerciciosSugeridos: true,
  observacoes: true, postagensPlanejadas: true, textoDivulgacao: true, linkCanva: true,
  imagemNome: true, status: true, criadoEm: true, atualizadoEm: true,
} as const;

/**
 * Quem alimenta o que o professor lê: cronograma das semanas e eventos do mês.
 * Só secretaria e admin escrevem — o professor tem só as rotas de leitura em
 * /professor/*.
 */
export async function conteudoRoutes(app: FastifyInstance) {
  const somenteEquipe = { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] };

  // ------------------------------------------------------- cronograma
  app.get("/conteudo/cronograma", somenteEquipe, async (request) => {
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(60).default(20) })
      .parse(request.query);

    return prisma.cronogramaSemana.findMany({
      orderBy: { semana: "desc" },
      take: limite,
      select: SEM_IMAGEM,
    });
  });

  // A semana completa, com a arte — é o que a tela de edição carrega.
  app.get("/conteudo/cronograma/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const semana = await prisma.cronogramaSemana.findUnique({ where: { id } });
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
        linkCanva: corpo.linkCanva ? corpo.linkCanva : null,
        status: corpo.status,
        // `undefined` preserva a arte que já está gravada; `null` apaga.
        ...(corpo.imagemBase64 === undefined
          ? {}
          : { imagemBase64: corpo.imagemBase64, imagemNome: corpo.imagemNome ?? null }),
      };

      const registro = await prisma.cronogramaSemana.upsert({
        where: { semana },
        create: { semana, ...dados },
        update: dados,
        select: SEM_IMAGEM,
      });

      return reply.code(200).send(registro);
    },
  );

  app.delete("/conteudo/cronograma/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.cronogramaSemana.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
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
