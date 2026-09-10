-- ===========================================================================
-- SE7 Hub — instalação no Supabase
--
-- Cole ISTO INTEIRO no SQL Editor do Supabase (o mesmo projeto do
-- se7-inadimplencia) e clique em Run. Uma coisa só, sem passo anterior, e
-- funciona tanto na primeira vez quanto para reinstalar.
--
-- O QUE ELE FAZ
--   1. Confere se há cadastro de verdade no schema `hub` — e PARA se houver.
--   2. Cria o schema `hub` e as 25 tabelas do sistema.
--   3. Acrescenta a coluna `observacoes` em public.cronograma_semanas.
--
-- SOBRE O PASSO 1, QUE É O QUE IMPORTA
-- Este arquivo contém um `DROP SCHEMA hub CASCADE`, para poder ser colado por
-- cima de uma instalação anterior sem parar com "already exists". Um DROP num
-- arquivo pronto para colar é uma armadilha — a não ser que ele se recuse a
-- rodar quando houver o que perder. É o que a conferência faz: se houver
-- QUALQUER aluno ou matrícula, o script para com uma mensagem e não apaga nada.
--
-- Assim a decisão de apagar deixa de depender de alguém lembrar de ler um
-- comentário antes de clicar em Run.
--
-- O QUE ELE NÃO TOCA
--   Nada fora do schema `hub`. As tabelas do se7-inadimplencia
--   (cronograma_semanas, central_cards, cobranca_registros, loja_*, usuarios,
--   ...) vivem em `public` e seguem exatamente como estão. A única alteração
--   ali é a coluna `observacoes`, aditiva, que aquele sistema não consulta.
--
-- COMO CONFERIR DEPOIS
--   select table_schema, count(*) from information_schema.tables
--    where table_schema in ('hub','public') group by 1;
--   -- hub deve ter 25; public, o mesmo número de antes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Confere e apaga — nesta ordem, e só se for seguro.
-- ---------------------------------------------------------------------------
DO $reinstalar$
DECLARE
  qtd_alunos     bigint := 0;
  qtd_matriculas bigint := 0;
BEGIN
  -- `to_regclass` devolve NULL quando a tabela não existe, o que evita ter de
  -- adivinhar em que estado o schema está: primeira instalação e reinstalação
  -- passam pelo mesmo caminho.
  IF to_regclass('hub.alunos') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM hub.alunos' INTO qtd_alunos;
  END IF;

  IF to_regclass('hub.matriculas') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM hub.matriculas' INTO qtd_matriculas;
  END IF;

  IF qtd_alunos > 0 OR qtd_matriculas > 0 THEN
    RAISE EXCEPTION
      'NAO APAGUEI NADA. O schema hub tem % aluno(s) e % matricula(s) cadastrados. Isso e cadastro de verdade, e apagar nao tem volta. Fale com quem cuida do sistema antes de seguir.',
      qtd_alunos, qtd_matriculas;
  END IF;

  DROP SCHEMA IF EXISTS "hub" CASCADE;
  RAISE NOTICE 'Schema hub apagado (estava sem alunos e sem matriculas). Recriando...';
END
$reinstalar$;

-- ---------------------------------------------------------------------------
-- 2. Daqui para baixo é idêntico a instalar-no-supabase.sql.
-- ---------------------------------------------------------------------------

-- Observações do treino para o professor (maré, quadra, material). Aditiva: o
-- se7-inadimplencia não consulta esta coluna e segue funcionando igual.
ALTER TABLE public.cronograma_semanas
  ADD COLUMN IF NOT EXISTS observacoes text;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "hub";

-- CreateEnum
CREATE TYPE "hub"."Provedor" AS ENUM ('GOOGLE', 'SENHA');

-- CreateEnum
CREATE TYPE "hub"."PapelNome" AS ENUM ('SOCIO', 'ADMIN', 'ADMINISTRATIVO', 'PROFESSOR', 'RESPONSAVEL');

-- CreateEnum
CREATE TYPE "hub"."TipoVinculo" AS ENUM ('RESPONSAVEL', 'PROFESSOR');

-- CreateEnum
CREATE TYPE "hub"."TipoEvento" AS ENUM ('TREINO_ESPECIAL', 'CAMPEONATO', 'FESTIVAL', 'REUNIAO', 'AVALIACAO', 'FERIADO', 'OUTRO');

-- CreateEnum
CREATE TYPE "hub"."TipoOcorrencia" AS ENUM ('TURMA_ERRADA', 'ALUNO_FALTANDO', 'REGISTRO_TREINO', 'OUTRO');

-- CreateEnum
CREATE TYPE "hub"."StatusOcorrencia" AS ENUM ('ABERTA', 'RESOLVIDA');

-- CreateEnum
CREATE TYPE "hub"."DiaDaSemana" AS ENUM ('DOMINGO', 'SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO');

-- CreateEnum
CREATE TYPE "hub"."StatusMatricula" AS ENUM ('CRIADA', 'PAGAMENTO_PENDENTE', 'CONFIRMADA', 'CANCELADA');

CREATE TYPE "hub"."SlotPaginaImagem" AS ENUM ('CARROSSEL', 'SOBRE_NOS', 'HORARIOS', 'VALORES');

-- CreateTable
CREATE TABLE "hub"."usuarios" (
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
CREATE TABLE "hub"."identidades" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "provedor" "hub"."Provedor" NOT NULL,
    "provedorSub" TEXT NOT NULL,
    "senhaHash" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."papeis" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "nome" "hub"."PapelNome" NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "papeis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."vinculos" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "tipo" "hub"."TipoVinculo" NOT NULL,
    "professorId" TEXT,
    "responsavelId" TEXT,
    "cpf" TEXT,
    "confirmadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vinculos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."tentativas_vinculo" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "cpfHash" TEXT NOT NULL,
    "sucesso" BOOLEAN NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tentativas_vinculo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."convites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "papel" "hub"."PapelNome" NOT NULL,
    "professorId" TEXT,
    "criadoPorId" TEXT,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "usadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "convites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."eventos" (
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
CREATE TABLE "hub"."configuracoes" (
    "chave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracoes_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "hub"."ocorrencias" (
    "id" TEXT NOT NULL,
    "tipo" "hub"."TipoOcorrencia" NOT NULL,
    "status" "hub"."StatusOcorrencia" NOT NULL DEFAULT 'ABERTA',
    "professorId" TEXT NOT NULL,
    "professorNome" TEXT NOT NULL,
    "turmaId" TEXT,
    "turmaNome" TEXT,
    "alunoNome" TEXT,
    "descricao" TEXT NOT NULL,
    "resposta" TEXT,
    "resolvidoPorId" TEXT,
    "resolvidoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ocorrencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."unidades" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "endereco" TEXT,
    "fotoBase64" TEXT,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."turmas" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nome" TEXT NOT NULL,
    "categoria" TEXT,
    "descricao" TEXT,
    "link" TEXT,
    "capacidade" INTEGER,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "aceitaNovasMatriculas" BOOLEAN NOT NULL DEFAULT true,
    "unidadeId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turmas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."horarios_turma" (
    "id" TEXT NOT NULL,
    "turmaId" TEXT NOT NULL,
    "dia" "hub"."DiaDaSemana" NOT NULL,
    "inicio" TEXT NOT NULL,
    "fim" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "horarios_turma_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."professores" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nome" TEXT NOT NULL,
    "email" TEXT,
    "telefone" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "professores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."professor_turma" (
    "professorId" TEXT NOT NULL,
    "turmaId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professor_turma_pkey" PRIMARY KEY ("professorId","turmaId")
);

-- CreateTable
CREATE TABLE "hub"."planos" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nome" TEXT NOT NULL,
    "descricao" TEXT,
    "valor" DECIMAL(10,2) NOT NULL,
    "parcelas" INTEGER NOT NULL DEFAULT 1,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "multiplasMatriculas" BOOLEAN NOT NULL DEFAULT false,
    "descontoPercentual" INTEGER NOT NULL DEFAULT 0,
    "descontoAteDias" INTEGER NOT NULL DEFAULT 0,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."plano_turma" (
    "planoId" TEXT NOT NULL,
    "turmaId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plano_turma_pkey" PRIMARY KEY ("planoId","turmaId")
);

-- CreateTable
CREATE TABLE "hub"."responsaveis" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nome" TEXT NOT NULL,
    "email" TEXT,
    "telefone" TEXT,
    "cpf" TEXT NOT NULL,
    "cep" TEXT,
    "logradouro" TEXT,
    "numero" TEXT,
    "complemento" TEXT,
    "bairro" TEXT,
    "cidade" TEXT,
    "estado" TEXT,
    "asaasCustomer" TEXT,
    "arquivadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "responsaveis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."alunos" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nome" TEXT NOT NULL,
    "foto" TEXT,
    "fotoMiniatura" TEXT,
    "nascimento" DATE,
    "observacao" TEXT,
    "responsavelId" TEXT,
    "arquivadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alunos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."matriculas" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "status" "hub"."StatusMatricula" NOT NULL DEFAULT 'CRIADA',
    "alunoId" TEXT NOT NULL,
    "responsavelId" TEXT NOT NULL,
    "turmaId" TEXT NOT NULL,
    "unidadeId" TEXT NOT NULL,
    "planoId" TEXT NOT NULL,
    "observacao" TEXT,
    "expiraEm" DATE,
    "principal" BOOLEAN NOT NULL DEFAULT true,
    "asaasReferencia" TEXT,
    "asaasPagamento" TEXT,
    "linkPagamento" TEXT,
    "asaasPayload" JSONB,
    "canceladaEm" TIMESTAMP(3),
    "arquivadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matriculas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."presencas" (
    "id" TEXT NOT NULL,
    "turmaId" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "data" DATE NOT NULL,
    "presente" BOOLEAN NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "presencas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."socios" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "participacao" DECIMAL(6,3) NOT NULL,
    "email" TEXT,
    "telefone" TEXT,
    "entrouEm" DATE,
    "arquivadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "socios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."fechamentos_diarios" (
    "id" TEXT NOT NULL,
    "data" DATE NOT NULL,
    "ativos" INTEGER NOT NULL,
    "entradas" INTEGER NOT NULL,
    "saidas" INTEGER NOT NULL,
    "receitaPrevista" DECIMAL(12,2) NOT NULL,
    "vagasOciosas" INTEGER NOT NULL,
    "origem" TEXT NOT NULL DEFAULT 'AUTOMATICO',
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fechamentos_diarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."galeria_fotos" (
    "id" TEXT NOT NULL,
    "imagemBase64" TEXT NOT NULL,
    "imagemNome" TEXT,
    "legenda" TEXT,
    "linkInstagram" TEXT,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "galeria_fotos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "galeria_fotos_ativa_ordem_idx" ON "hub"."galeria_fotos"("ativa", "ordem");

-- CreateTable
CREATE TABLE "hub"."instagram_posts" (
    "id" TEXT NOT NULL,
    "imagemUrl" TEXT NOT NULL,
    "legenda" TEXT,
    "permalink" TEXT NOT NULL,
    "publicadoEm" TIMESTAMP(3),
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instagram_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_posts_publicadoEm_idx" ON "hub"."instagram_posts"("publicadoEm");

-- CreateTable
CREATE TABLE "hub"."pagina_imagens" (
    "id" TEXT NOT NULL,
    "slot" "hub"."SlotPaginaImagem" NOT NULL,
    "imagemBase64" TEXT NOT NULL,
    "legenda" TEXT,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pagina_imagens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pagina_imagens_slot_ativa_ordem_idx" ON "hub"."pagina_imagens"("slot", "ativa", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "hub"."usuarios"("email");

-- CreateIndex
CREATE INDEX "identidades_usuarioId_idx" ON "hub"."identidades"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "identidades_provedor_provedorSub_key" ON "hub"."identidades"("provedor", "provedorSub");

-- CreateIndex
CREATE UNIQUE INDEX "papeis_usuarioId_nome_key" ON "hub"."papeis"("usuarioId", "nome");

-- CreateIndex
CREATE INDEX "vinculos_usuarioId_idx" ON "hub"."vinculos"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "vinculos_professorId_key" ON "hub"."vinculos"("professorId");

-- CreateIndex
CREATE UNIQUE INDEX "vinculos_responsavelId_key" ON "hub"."vinculos"("responsavelId");

-- CreateIndex
CREATE INDEX "tentativas_vinculo_usuarioId_criadoEm_idx" ON "hub"."tentativas_vinculo"("usuarioId", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "convites_email_key" ON "hub"."convites"("email");

-- CreateIndex
CREATE INDEX "convites_email_idx" ON "hub"."convites"("email");

-- CreateIndex
CREATE INDEX "eventos_data_publicado_idx" ON "hub"."eventos"("data", "publicado");

-- CreateIndex
CREATE INDEX "ocorrencias_status_criadoEm_idx" ON "hub"."ocorrencias"("status", "criadoEm");

-- CreateIndex
CREATE INDEX "ocorrencias_professorId_criadoEm_idx" ON "hub"."ocorrencias"("professorId", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "unidades_legacyId_key" ON "hub"."unidades"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "turmas_legacyId_key" ON "hub"."turmas"("legacyId");

-- CreateIndex
CREATE INDEX "turmas_unidadeId_ativa_idx" ON "hub"."turmas"("unidadeId", "ativa");

-- CreateIndex
CREATE INDEX "horarios_turma_turmaId_idx" ON "hub"."horarios_turma"("turmaId");

-- CreateIndex
CREATE UNIQUE INDEX "professores_legacyId_key" ON "hub"."professores"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "professores_email_key" ON "hub"."professores"("email");

-- CreateIndex
CREATE UNIQUE INDEX "planos_legacyId_key" ON "hub"."planos"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "responsaveis_legacyId_key" ON "hub"."responsaveis"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "responsaveis_cpf_key" ON "hub"."responsaveis"("cpf");

-- CreateIndex
CREATE INDEX "responsaveis_nome_idx" ON "hub"."responsaveis"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "alunos_legacyId_key" ON "hub"."alunos"("legacyId");

-- CreateIndex
CREATE INDEX "alunos_nome_idx" ON "hub"."alunos"("nome");

-- CreateIndex
CREATE INDEX "alunos_responsavelId_idx" ON "hub"."alunos"("responsavelId");

-- CreateIndex
CREATE UNIQUE INDEX "matriculas_legacyId_key" ON "hub"."matriculas"("legacyId");

-- CreateIndex
CREATE INDEX "matriculas_status_criadoEm_idx" ON "hub"."matriculas"("status", "criadoEm");

-- CreateIndex
CREATE INDEX "matriculas_turmaId_status_idx" ON "hub"."matriculas"("turmaId", "status");

-- CreateIndex
CREATE INDEX "matriculas_alunoId_idx" ON "hub"."matriculas"("alunoId");

-- CreateIndex
CREATE INDEX "presencas_turmaId_data_idx" ON "hub"."presencas"("turmaId", "data");

-- CreateIndex
CREATE INDEX "presencas_alunoId_data_idx" ON "hub"."presencas"("alunoId", "data");

-- CreateIndex
CREATE UNIQUE INDEX "presencas_turmaId_alunoId_data_key" ON "hub"."presencas"("turmaId", "alunoId", "data");

-- CreateIndex
CREATE UNIQUE INDEX "fechamentos_diarios_data_key" ON "hub"."fechamentos_diarios"("data");

-- CreateIndex
CREATE INDEX "fechamentos_diarios_data_idx" ON "hub"."fechamentos_diarios"("data");

-- AddForeignKey
ALTER TABLE "hub"."identidades" ADD CONSTRAINT "identidades_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."papeis" ADD CONSTRAINT "papeis_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."vinculos" ADD CONSTRAINT "vinculos_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."vinculos" ADD CONSTRAINT "vinculos_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "hub"."professores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."vinculos" ADD CONSTRAINT "vinculos_responsavelId_fkey" FOREIGN KEY ("responsavelId") REFERENCES "hub"."responsaveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."tentativas_vinculo" ADD CONSTRAINT "tentativas_vinculo_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "hub"."usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."ocorrencias" ADD CONSTRAINT "ocorrencias_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "hub"."professores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."ocorrencias" ADD CONSTRAINT "ocorrencias_turmaId_fkey" FOREIGN KEY ("turmaId") REFERENCES "hub"."turmas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."turmas" ADD CONSTRAINT "turmas_unidadeId_fkey" FOREIGN KEY ("unidadeId") REFERENCES "hub"."unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."horarios_turma" ADD CONSTRAINT "horarios_turma_turmaId_fkey" FOREIGN KEY ("turmaId") REFERENCES "hub"."turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."professor_turma" ADD CONSTRAINT "professor_turma_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "hub"."professores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."professor_turma" ADD CONSTRAINT "professor_turma_turmaId_fkey" FOREIGN KEY ("turmaId") REFERENCES "hub"."turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."plano_turma" ADD CONSTRAINT "plano_turma_planoId_fkey" FOREIGN KEY ("planoId") REFERENCES "hub"."planos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."plano_turma" ADD CONSTRAINT "plano_turma_turmaId_fkey" FOREIGN KEY ("turmaId") REFERENCES "hub"."turmas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."alunos" ADD CONSTRAINT "alunos_responsavelId_fkey" FOREIGN KEY ("responsavelId") REFERENCES "hub"."responsaveis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."matriculas" ADD CONSTRAINT "matriculas_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "hub"."alunos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."matriculas" ADD CONSTRAINT "matriculas_responsavelId_fkey" FOREIGN KEY ("responsavelId") REFERENCES "hub"."responsaveis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."matriculas" ADD CONSTRAINT "matriculas_turmaId_fkey" FOREIGN KEY ("turmaId") REFERENCES "hub"."turmas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."matriculas" ADD CONSTRAINT "matriculas_unidadeId_fkey" FOREIGN KEY ("unidadeId") REFERENCES "hub"."unidades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."matriculas" ADD CONSTRAINT "matriculas_planoId_fkey" FOREIGN KEY ("planoId") REFERENCES "hub"."planos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."presencas" ADD CONSTRAINT "presencas_turmaId_fkey" FOREIGN KEY ("turmaId") REFERENCES "hub"."turmas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."presencas" ADD CONSTRAINT "presencas_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "hub"."alunos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."presencas" ADD CONSTRAINT "presencas_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "hub"."professores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

