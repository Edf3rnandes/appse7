import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Acesso à tabela `public.cronograma_semanas` — que pertence ao
 * se7-inadimplencia, não ao Hub.
 *
 * Regras desta camada, mesmo espírito de src/db/legacy/:
 *
 *   1. A tabela NÃO é um modelo do Prisma daqui. Se fosse, `prisma db push`
 *      passaria a ter poder sobre ela, e um push distraído alteraria o schema
 *      do outro sistema. Como o Hub declara `schemas = ["hub"]`, o Prisma nem
 *      consegue enxergar `public` — a proteção é estrutural.
 *   2. Todo SQL fica neste arquivo. Nenhum outro módulo escreve nome de tabela
 *      do sistema vizinho.
 *   3. As colunas são as que já existem lá, com uma exceção documentada:
 *      `observacoes`, que o Hub acrescenta (ver prisma/compartilhado.sql).
 *
 * Assim o cronograma tem uma fonte da verdade só: a secretaria preenche pelo
 * Hub ou pelo painel antigo, e os dois leem a mesma linha.
 */

export class CronogramaIndisponivelError extends Error {
  constructor(causa?: string) {
    super(
      "A tabela compartilhada do cronograma não está acessível." +
        (causa ? ` (${causa})` : ""),
    );
  }
}

export interface SemanaCronograma {
  id: string;
  semana: Date;
  tema: string | null;
  fundamentos: string | null;
  exerciciosSugeridos: string | null;
  observacoes: string | null;
  postagensPlanejadas: string | null;
  textoDivulgacao: string | null;
  linkCanva: string | null;
  imagemBase64: string | null;
  imagemNome: string | null;
  status: string;
  criadoEm: Date;
  atualizadoEm: Date;
}

export type SemanaSemArte = Omit<SemanaCronograma, "imagemBase64">;

// Colunas sem a arte. A listagem carrega dezenas de semanas, e o data URL de
// cada uma deixaria a resposta na casa dos megabytes.
const COLUNAS_SEM_ARTE = Prisma.sql`
  id, semana, tema, fundamentos, "exerciciosSugeridos", observacoes,
  "postagensPlanejadas", "textoDivulgacao", "linkCanva", "imagemNome",
  status, "criadoEm", "atualizadoEm"
`;

/**
 * Data de calendário como texto "AAAA-MM-DD", sempre com cast explícito para
 * `date` no SQL.
 *
 * Passar um Date direto para uma coluna `date` faria o Postgres converter um
 * timestamp usando o fuso da sessão. Como as datas do Hub são meia-noite UTC e
 * o servidor roda em America/Fortaleza (UTC-3), a semana de segunda 07/09
 * viraria domingo 06/09 na gravação. Texto + `::date` não depende de fuso
 * nenhum.
 */
function iso(data: Date): string {
  return data.toISOString().slice(0, 10);
}

async function consultar<T>(sql: Prisma.Sql): Promise<T[]> {
  try {
    return await prisma.$queryRaw<T[]>(sql);
  } catch (erro) {
    // Banco sem a tabela (Hub apontando para um Postgres só dele) ou sem a
    // coluna `observacoes`. Falhar com mensagem clara é melhor do que devolver
    // um erro de driver cru para a tela.
    const mensagem = erro instanceof Error ? erro.message : "";
    if (/relation .* does not exist|column .* does not exist/i.test(mensagem)) {
      throw new CronogramaIndisponivelError(
        "rode prisma/compartilhado.sql no banco do se7-inadimplencia",
      );
    }
    throw erro;
  }
}

export async function listarSemanas(limite: number): Promise<SemanaSemArte[]> {
  return consultar<SemanaSemArte>(Prisma.sql`
    SELECT ${COLUNAS_SEM_ARTE}
    FROM public.cronograma_semanas
    ORDER BY semana DESC
    LIMIT ${limite}
  `);
}

export async function obterSemanaPorId(id: string): Promise<SemanaCronograma | null> {
  const linhas = await consultar<SemanaCronograma>(Prisma.sql`
    SELECT ${COLUNAS_SEM_ARTE}, "imagemBase64"
    FROM public.cronograma_semanas
    WHERE id = ${id}
    LIMIT 1
  `);
  return linhas[0] ?? null;
}

/** Semanas publicadas dentro de um intervalo, sem a arte (visão do mês). */
export async function listarPublicadasNoIntervalo(
  inicio: Date,
  fim: Date,
): Promise<SemanaSemArte[]> {
  return consultar<SemanaSemArte>(Prisma.sql`
    SELECT ${COLUNAS_SEM_ARTE}
    FROM public.cronograma_semanas
    WHERE status = 'publicado' AND semana BETWEEN ${iso(inicio)}::date AND ${iso(fim)}::date
    ORDER BY semana ASC
  `);
}

/** Semanas publicadas específicas, COM a arte (visão da semana do professor). */
export async function obterPublicadasComArte(semanas: Date[]): Promise<SemanaCronograma[]> {
  if (semanas.length === 0) return [];

  return consultar<SemanaCronograma>(Prisma.sql`
    SELECT ${COLUNAS_SEM_ARTE}, "imagemBase64"
    FROM public.cronograma_semanas
    WHERE status = 'publicado' AND semana IN (${Prisma.join(semanas.map((d) => Prisma.sql`${iso(d)}::date`))})
    ORDER BY semana ASC
  `);
}

export interface DadosSemana {
  tema: string | null;
  fundamentos: string | null;
  exerciciosSugeridos: string | null;
  observacoes: string | null;
  postagensPlanejadas: string | null;
  textoDivulgacao: string | null;
  linkCanva: string | null;
  status: string;
  // undefined preserva a arte gravada; null apaga; string substitui.
  imagemBase64?: string | null;
  imagemNome?: string | null;
}

/**
 * Upsert pela semana — a segunda-feira é a chave natural, e a tabela tem
 * UNIQUE nela, então salvar duas vezes a mesma semana corrige em vez de
 * duplicar.
 *
 * O id é gerado aqui porque a coluna do outro sistema não tem DEFAULT: lá quem
 * gera é o Prisma, na aplicação.
 */
export async function salvarSemana(
  semana: Date,
  dados: DadosSemana,
): Promise<SemanaSemArte> {
  const trocaArte = dados.imagemBase64 !== undefined;

  const linhas = await consultar<SemanaSemArte>(Prisma.sql`
    INSERT INTO public.cronograma_semanas (
      id, semana, tema, fundamentos, "exerciciosSugeridos", observacoes,
      "postagensPlanejadas", "textoDivulgacao", "linkCanva",
      "imagemBase64", "imagemNome", status, "criadoEm", "atualizadoEm"
    ) VALUES (
      ${crypto.randomUUID()}, ${iso(semana)}::date, ${dados.tema}, ${dados.fundamentos},
      ${dados.exerciciosSugeridos}, ${dados.observacoes},
      ${dados.postagensPlanejadas}, ${dados.textoDivulgacao}, ${dados.linkCanva},
      ${dados.imagemBase64 ?? null}, ${dados.imagemNome ?? null},
      ${dados.status}, now(), now()
    )
    ON CONFLICT (semana) DO UPDATE SET
      tema = EXCLUDED.tema,
      fundamentos = EXCLUDED.fundamentos,
      "exerciciosSugeridos" = EXCLUDED."exerciciosSugeridos",
      observacoes = EXCLUDED.observacoes,
      "postagensPlanejadas" = EXCLUDED."postagensPlanejadas",
      "textoDivulgacao" = EXCLUDED."textoDivulgacao",
      "linkCanva" = EXCLUDED."linkCanva",
      status = EXCLUDED.status,
      "imagemBase64" = CASE WHEN ${trocaArte} THEN EXCLUDED."imagemBase64"
                            ELSE public.cronograma_semanas."imagemBase64" END,
      "imagemNome"   = CASE WHEN ${trocaArte} THEN EXCLUDED."imagemNome"
                            ELSE public.cronograma_semanas."imagemNome" END,
      "atualizadoEm" = now()
    RETURNING ${COLUNAS_SEM_ARTE}
  `);

  return linhas[0]!;
}

export async function apagarSemana(id: string): Promise<void> {
  await consultar(Prisma.sql`DELETE FROM public.cronograma_semanas WHERE id = ${id}`);
}
