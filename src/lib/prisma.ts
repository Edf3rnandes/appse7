import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

// O schema.prisma declara `directUrl = env("DIRECT_URL")`, e o Prisma reclama
// se a variavel nao existir — mesmo que o Client nunca a use (ela e do CLI).
// Quando ela falta, apontamos para a mesma URL do banco: o Client fica
// satisfeito e uma tentativa de migracao pelo pooler falha de forma segura,
// em vez de rodar onde nao deve.
//
// Este arquivo importa env.js de proposito: garante que a checagem acima
// aconteca antes de o Client ser criado, sem depender da ordem dos imports
// em quem consome o prisma.
process.env.DIRECT_URL ||= env.DATABASE_URL;

export const prisma = new PrismaClient();
