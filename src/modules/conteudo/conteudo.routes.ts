import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TipoEvento } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { segundaDaSemana } from "../../lib/datas.js";

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

const semanaSchema = z.object({
  semana: dataIso,
  tema: z.string().max(200).optional(),
  fundamentos: z.string().max(2000).optional(),
  exercicios: z.string().max(4000).optional(),
  observacoes: z.string().max(2000).optional(),
  publicado: z.boolean().default(false),
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

/**
 * Quem alimenta o que o professor lê: programação da semana e eventos do mês.
 * Só secretaria e admin escrevem — o professor tem só as rotas de leitura em
 * /professor/*.
 */
export async function conteudoRoutes(app: FastifyInstance) {
  const somenteEquipe = { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] };

  // ------------------------------------------------------- programação
  app.get("/conteudo/semanas", somenteEquipe, async (request) => {
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(60).default(12) })
      .parse(request.query);

    return prisma.programacaoSemana.findMany({ orderBy: { semana: "desc" }, take: limite });
  });

  // Upsert pela semana: a segunda-feira é a chave natural, então salvar duas
  // vezes a mesma semana corrige em vez de duplicar.
  app.put("/conteudo/semanas", somenteEquipe, async (request, reply) => {
    const corpo = semanaSchema.parse(request.body);

    // Normaliza para a segunda-feira: se alguém mandar uma quarta, a semana é
    // a mesma, e sem isso viraria uma segunda linha para o mesmo período.
    const semana = segundaDaSemana(corpo.semana);
    const dados = {
      tema: corpo.tema ?? null,
      fundamentos: corpo.fundamentos ?? null,
      exercicios: corpo.exercicios ?? null,
      observacoes: corpo.observacoes ?? null,
      publicado: corpo.publicado,
    };

    const registro = await prisma.programacaoSemana.upsert({
      where: { semana },
      create: { semana, ...dados },
      update: dados,
    });

    return reply.code(200).send(registro);
  });

  app.delete("/conteudo/semanas/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.programacaoSemana.delete({ where: { id } }).catch(() => null);
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

    const evento = await prisma.evento.create({
      data: {
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
      },
    });

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

    return prisma.evento.update({
      where: { id },
      data: {
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
      },
    });
  });

  app.delete("/conteudo/eventos/:id", somenteEquipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.evento.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });
}
