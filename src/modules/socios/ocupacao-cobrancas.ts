import { randomUUID } from "node:crypto";
import { DiaDaSemana } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { milissegundosAte } from "./fechamento.js";
import { ativaEm, ultimosMeses, type MatriculaParaConta } from "./socios.routes.js";

/**
 * Cópia da ocupação real das turmas para o se7-cobrancas.
 *
 * O se7-cobrancas (o outro sistema, hoje publicado como serviço `se7-cobrancas`
 * no Render, dividindo este mesmo Postgres) tem uma tela de ocupação por
 * unidade que nunca teve acesso a aluno de verdade: o acesso de leitura ao
 * MySQL do Laravel nunca foi liberado pra ele, então a tabela que a alimenta
 * (`turma_snapshots`, schema `public`) sempre foi preenchida à mão — alguém
 * digitando matriculados/vagas por turma numa planilha todo mês e importando.
 *
 * O Hub já tem esse número de verdade (é o mesmo cálculo de `/socios/turmas`).
 * Esta cópia substitui a digitação: todo dia, grava no `turma_snapshots` do
 * se7-cobrancas exatamente o que uma pessoa digitaria, na mesma forma.
 *
 * De propósito, NÃO é uma consulta ao vivo entre os dois bancos — o
 * `unidadesAlunos.service.ts` de lá continua lendo só a própria tabela, sem
 * saber que a origem mudou de dedo humano para este job. Uma emenda relacional
 * entre dois sistemas que evoluem em repositórios separados quebraria no dia
 * em que um dos dois mudasse uma coluna; uma cópia gravada não.
 *
 * Duas granularidades na mesma passada:
 *   - DIARIO, pela leitura mais fina possível — todo dia um retrato de hoje;
 *   - MENSAL, a mesma granularidade da planilha que foi importada antes disto
 *     existir. É o que a tela usa quando não pede um período (o padrão da
 *     rota /unidades-alunos/resumo é MENSAL) — sem isto a série pararia no
 *     último mês importado à mão e pareceria congelada.
 *
 * Escrito para não derrubar nada num Hub instalado sem o se7-cobrancas ao
 * lado (ver `docs/colocar-no-ar.md`): confere se a tabela existe antes de
 * tentar gravar, do mesmo jeito que o `/health` confere `cronograma_semanas`.
 */

const DIA_ABREV: Record<DiaDaSemana, string> = {
  DOMINGO: "Dom",
  SEGUNDA: "Seg",
  TERCA: "Ter",
  QUARTA: "Qua",
  QUINTA: "Qui",
  SEXTA: "Sex",
  SABADO: "Sáb",
};

// Segunda a domingo, a mesma ordem que a planilha da secretaria usa —
// "Seg - Qua - Sex", nunca "Sex - Seg - Qua".
const ORDEM_DIA: DiaDaSemana[] = [
  DiaDaSemana.SEGUNDA,
  DiaDaSemana.TERCA,
  DiaDaSemana.QUARTA,
  DiaDaSemana.QUINTA,
  DiaDaSemana.SEXTA,
  DiaDaSemana.SABADO,
  DiaDaSemana.DOMINGO,
];

/** "Seg - Qua - Sex", na mesma forma da planilha que alimentava a tabela à mão. */
export function formatarDiasDeTreino(horarios: { dia: DiaDaSemana }[]): string {
  const presentes = new Set(horarios.map((h) => h.dia));
  return ORDEM_DIA.filter((d) => presentes.has(d))
    .map((d) => DIA_ABREV[d])
    .join(" - ");
}

export interface LinhaOcupacao {
  unidadeIdLegacy: string;
  unidadeNome: string;
  turma: string;
  diasDeTreino: string;
  matriculados: number;
  vagas: number;
}

/** A ocupação real de cada turma ativa, na forma que `turma_snapshots` espera. */
export async function ocupacaoReal(): Promise<LinhaOcupacao[]> {
  // Mesmo mês corrente que /socios/turmas usa para decidir quem está ativo —
  // é o mesmo número, então tem que nascer da mesma régua.
  const mesCorrente = ultimosMeses(1)[0];

  const turmas = await prisma.turma.findMany({
    where: { ativa: true },
    orderBy: [{ unidade: { nome: "asc" } }, { nome: "asc" }],
    select: {
      nome: true,
      capacidade: true,
      unidade: { select: { nome: true } },
      horarios: { select: { dia: true } },
      matriculas: {
        select: {
          status: true,
          criadoEm: true,
          canceladaEm: true,
          arquivadoEm: true,
          expiraEm: true,
          atualizadoEm: true,
        },
      },
    },
  });

  return turmas.map((t) => {
    // ativaEm() só olha status/datas — unidade e plano ficam vazios porque
    // esta conta não precisa de receita, só de contagem.
    const matriculas = t.matriculas.map((m) => ({
      ...m,
      unidade: { id: "", nome: "" },
      plano: { valor: 0 },
    })) as unknown as MatriculaParaConta[];

    const ativas = matriculas.filter((m) => ativaEm(m, mesCorrente.fim, mesCorrente.inicio));

    return {
      // O se7-cobrancas usa o NOME da unidade como chave — nunca teve o id
      // real do Laravel, e não é este job que vai inventar um.
      unidadeIdLegacy: t.unidade.nome,
      unidadeNome: t.unidade.nome,
      turma: t.nome,
      diasDeTreino: formatarDiasDeTreino(t.horarios),
      matriculados: ativas.length,
      vagas: t.capacidade ?? 0,
    };
  });
}

export async function tabelaDeSnapshotsExiste(): Promise<boolean> {
  const linhas = await prisma.$queryRaw<
    { existe: boolean }[]
  >`SELECT to_regclass('public.turma_snapshots') IS NOT NULL AS existe`;
  return linhas[0]?.existe ?? false;
}

/**
 * Grava a ocupação de hoje em `public.turma_snapshots`, nos dois períodos.
 *
 * Sem efeito (e sem erro) num Hub instalado sozinho, sem o se7-cobrancas ao
 * lado — a tabela simplesmente não existe, e a função devolve `gravado: false`
 * em vez de derrubar o job noturno por causa de um vizinho que não está lá.
 */
export async function copiarOcupacaoParaCobrancas() {
  if (!(await tabelaDeSnapshotsExiste())) {
    return { gravado: false, turmas: 0 };
  }

  const linhas = await ocupacaoReal();
  const agora = new Date();

  for (const periodo of ["DIARIO", "MENSAL"] as const) {
    for (const l of linhas) {
      await prisma.$executeRaw`
        INSERT INTO public.turma_snapshots
          (id, "unidadeIdLegacy", "unidadeNome", turma, "diasDeTreino", matriculados, vagas, periodo, "capturadoEm")
        VALUES (
          ${randomUUID()}, ${l.unidadeIdLegacy}, ${l.unidadeNome}, ${l.turma}, ${l.diasDeTreino},
          ${l.matriculados}, ${l.vagas}, ${periodo}::public."PeriodoSnapshot", ${agora}
        )
      `;
    }
  }

  return { gravado: true, turmas: linhas.length };
}

/** Agenda a cópia para as 23:59 do fuso da escola — mesmo horário do fechamento diário. */
export function agendarCopiaDeOcupacao(fuso = process.env.TZ || "America/Fortaleza") {
  const agendar = () => {
    const espera = milissegundosAte(23, 59, fuso);
    const relogio = setTimeout(async () => {
      try {
        await copiarOcupacaoParaCobrancas();
      } catch {
        // Uma cópia que falha não pode derrubar o servidor nem impedir o
        // fechamento diário de acontecer. Ela tenta de novo amanhã; enquanto
        // isso, a série no se7-cobrancas só fica um dia sem atualizar.
      }
      agendar();
    }, espera);

    relogio.unref?.();
  };

  agendar();
}
