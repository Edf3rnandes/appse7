-- Atualização incremental: cancelamento com motivo, e controle de bolsistas.
--
-- Só use este arquivo se o Supabase JÁ tem o schema `hub` instalado (passo 1
-- de docs/colocar-no-ar.md já feito antes, com matrícula de verdade
-- cadastrada). Se ainda não instalou nada, não precisa deste arquivo: use
-- prisma/instalar-no-supabase.sql direto, ele já vem com tudo isto incluído.
--
-- Seguro rodar mais de uma vez: cada ALTER confere se a coluna já existe
-- antes de agir. Não apaga nada, não mexe em nenhuma linha existente — só
-- acrescenta colunas novas em hub.matriculas, todas com um padrão que não
-- muda o comportamento de quem já estava lá (bolsista começa `false` pra
-- todo mundo, as outras começam vazias).
--
-- No painel do Supabase: SQL Editor → New query → cole o arquivo inteiro →
-- Run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
     WHERE typname = 'MotivoCancelamento'
       AND typnamespace = 'hub'::regnamespace
  ) THEN
    CREATE TYPE "hub"."MotivoCancelamento" AS ENUM (
      'MUDOU_CIDADE', 'FINANCEIRO', 'INSATISFACAO',
      'HORARIO_INCOMPATIVEL', 'SAUDE_LESAO', 'OUTRA_ESCOLA', 'OUTRO'
    );
  END IF;
END $$;

ALTER TABLE "hub"."matriculas" ADD COLUMN IF NOT EXISTS "motivoCancelamento" "hub"."MotivoCancelamento";
ALTER TABLE "hub"."matriculas" ADD COLUMN IF NOT EXISTS "motivoCancelamentoDetalhe" TEXT;
ALTER TABLE "hub"."matriculas" ADD COLUMN IF NOT EXISTS "bolsista" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hub"."matriculas" ADD COLUMN IF NOT EXISTS "bolsaRevisarEm" DATE;

-- Para conferir depois:
--
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'hub' and table_name = 'matriculas'
--    and column_name in ('motivoCancelamento', 'motivoCancelamentoDetalhe', 'bolsista', 'bolsaRevisarEm')
--  order by column_name;
-- -- as quatro colunas devem aparecer.
