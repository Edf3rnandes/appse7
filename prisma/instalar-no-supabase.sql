-- ============================================================================
-- SE7 Hub — instalação no banco compartilhado com o se7-inadimplencia
--
-- COLE ESTE ARQUIVO INTEIRO no SQL Editor do Supabase, no projeto que o
-- se7-cobrancas (se7-inadimplencia) já usa em produção, e clique em Run.
-- Não precisa de terminal, nem da CLI, nem de expor a senha do banco.
--
-- O que ele faz, e só isso:
--   1. cria o schema `hub`, onde ficam as tabelas do Hub;
--   2. acrescenta a coluna `observacoes` em public.cronograma_semanas;
--   3. cria as tabelas do Hub dentro de `hub`.
--
-- Tudo é ADITIVO. Nenhum comando aqui altera, esvazia ou apaga qualquer coisa
-- que já exista: não há DROP, nem ALTER de coluna existente, nem DELETE.
-- As tabelas do se7-inadimplencia (cronograma_semanas, central_cards,
-- cobranca_registros, loja_*, usuarios, ...) continuam exatamente como estão.
--
-- Pode rodar duas vezes sem problema: tudo usa IF NOT EXISTS.
--
-- Como conferir que deu certo, depois do Run:
--   select table_schema, table_name from information_schema.tables
--   where table_schema in ('hub','public') order by 1, 2;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 e 2: schema do Hub e a coluna que o cronograma ganha
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS hub;

-- Observações do treino para o professor (maré, quadra, material). O
-- se7-inadimplencia não consulta esta coluna, então segue funcionando igual.
ALTER TABLE public.cronograma_semanas
  ADD COLUMN IF NOT EXISTS observacoes text;

-- ---------------------------------------------------------------------------
-- 3: tabelas do Hub, dentro do schema `hub`
-- ---------------------------------------------------------------------------

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "hub"."Provedor" AS ENUM ('GOOGLE', 'SENHA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "hub"."PapelNome" AS ENUM ('ADMIN', 'SECRETARIA', 'PROFESSOR', 'RESPONSAVEL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "hub"."TipoVinculo" AS ENUM ('RESPONSAVEL', 'PROFESSOR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "hub"."TipoEvento" AS ENUM ('TREINO_ESPECIAL', 'CAMPEONATO', 'FESTIVAL', 'REUNIAO', 'AVALIACAO', 'FERIADO', 'OUTRO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."usuarios" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ultimoLoginEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."identidades" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "provedor" "hub"."Provedor" NOT NULL,
    "provedorSub" TEXT NOT NULL,
    "senhaHash" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."papeis" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "nome" "hub"."PapelNome" NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "papeis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."vinculos" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "tipo" "hub"."TipoVinculo" NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "cpf" TEXT,
    "confirmadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vinculos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."tentativas_vinculo" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "cpfHash" TEXT NOT NULL,
    "sucesso" BOOLEAN NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tentativas_vinculo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."convites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "papel" "hub"."PapelNome" NOT NULL,
    "legacyId" INTEGER,
    "criadoPorId" TEXT,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "usadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "convites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."eventos" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descricao" TEXT,
    "tipo" "hub"."TipoEvento" NOT NULL DEFAULT 'OUTRO',
    "data" DATE NOT NULL,
    "dataFim" DATE,
    "horario" TEXT,
    "local" TEXT,
    "unidadeIdLegacy" INTEGER,
    "unidadeNome" TEXT,
    "publicado" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eventos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "hub"."configuracoes" (
    "chave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracoes_pkey" PRIMARY KEY ("chave")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "usuarios_email_key" ON "hub"."usuarios"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "identidades_usuarioId_idx" ON "hub"."identidades"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "identidades_provedor_provedorSub_key" ON "hub"."identidades"("provedor", "provedorSub");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "papeis_usuarioId_nome_key" ON "hub"."papeis"("usuarioId", "nome");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vinculos_usuarioId_idx" ON "hub"."vinculos"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "vinculos_tipo_legacyId_key" ON "hub"."vinculos"("tipo", "legacyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tentativas_vinculo_usuarioId_criadoEm_idx" ON "hub"."tentativas_vinculo"("usuarioId", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "convites_email_key" ON "hub"."convites"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "convites_email_idx" ON "hub"."convites"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "eventos_data_publicado_idx" ON "hub"."eventos"("data", "publicado");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "hub"."identidades" ADD CONSTRAINT "identidades_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "hub"."papeis" ADD CONSTRAINT "papeis_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "hub"."vinculos" ADD CONSTRAINT "vinculos_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "hub"."tentativas_vinculo" ADD CONSTRAINT "tentativas_vinculo_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

