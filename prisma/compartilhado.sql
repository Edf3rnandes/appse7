-- Ajuste único no banco do se7-inadimplencia para o Hub compartilhar o
-- cronograma. Rode com a DIRECT_URL (porta 5432), não pelo pooler.
--
-- Duas coisas apenas, as duas aditivas — nada existente é alterado ou apagado:

-- 1. O schema onde as tabelas do Hub vão viver, separado de `public`.
CREATE SCHEMA IF NOT EXISTS hub;

-- 2. A coluna que o Hub acrescenta ao cronograma: observações do treino para o
--    professor (maré, quadra, material). O se7-inadimplencia não a consulta,
--    então continua funcionando exatamente como antes.
ALTER TABLE public.cronograma_semanas
  ADD COLUMN IF NOT EXISTS observacoes text;

-- Depois disto, `npx prisma db push` cria as tabelas do Hub dentro de `hub`.
-- Ele não enxerga `public` (ver `schemas = ["hub"]` no schema.prisma), então
-- não tem como tocar nas tabelas do se7-inadimplencia.
