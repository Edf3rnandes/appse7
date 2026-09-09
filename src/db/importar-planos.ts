import { readFileSync } from "node:fs";
import { DiaDaSemana } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Importa os planos e liga cada um às turmas a que ele se aplica.
 *
 * A ligação não é palpite: o nome do plano carrega a unidade e o padrão de
 * dias. "Semestral (Bessa S/Q/S)" é Bessa, segunda/quarta/sexta — e casa com
 * as turmas de Bessa que treinam nesses três dias. No sistema antigo essa
 * informação existia só dentro do nome, como texto; o pivô `course_plan`
 * precisava ser preenchido à mão, turma por turma.
 *
 * O que a regra usa, e por quê:
 *   - unidade: o nome cita uma das seis. Plano sem unidade no nome ("Sábado")
 *     vale para qualquer uma — e só existe uma turma de sábado.
 *   - dias: T/Q, S/Q, S/Q/S, Q/S, ou por extenso.
 *   - família: "Base ..." só casa com turma de base; "SE7 +90" só com as
 *     turmas SE7+90; os demais, só com turma comum. Sem isso o plano de
 *     Ter/Qui de Bessa cairia também na turma de base, que custa outro valor.
 *   - numeral: "SQS II" e "SQS III" distinguem as três turmas de base de Cabo
 *     Branco, que treinam nos mesmos dias por preços diferentes.
 *
 * O que a regra NÃO faz é inventar: plano que não casa com turma nenhuma e
 * turma que fica sem plano são impressos no fim, para conferência. Turma sem
 * plano não aceita matrícula, então essa lista tem de sair vazia.
 *
 * Rode depois de `npm run importar:turmas`:  npm run importar:planos
 */

const ARQUIVO = "prisma/dados/planos.tsv";

const UNIDADES = ["Alagoa Grande", "Altiplano", "Areia", "Bancários", "Bessa", "Cabo Branco"];

const D = DiaDaSemana;

// Ordem importa: "S/Q/S" precisa ser testado antes de "S/Q", senão o prefixo
// casa primeiro e o plano de três dias vira um de dois.
const PADROES_DE_DIA: [RegExp, DiaDaSemana[]][] = [
  [/Seg\/Qua\/Sex|S\/Q\/S|SQS/i, [D.SEGUNDA, D.QUARTA, D.SEXTA]],
  [/Ter\/Qui|T\/Q/i, [D.TERCA, D.QUINTA]],
  [/Qua\/Sex|Q\/S(?!\/)/i, [D.QUARTA, D.SEXTA]],
  [/Seg\/Qua|S\/Q(?!\/)/i, [D.SEGUNDA, D.QUARTA]],
  [/Sábado|Sabadão|Sab\b/i, [D.SABADO]],
];

type Familia = "BASE" | "SE7+90" | "COMUM";

interface LinhaPlano {
  legacyId: number;
  nome: string;
  valor: number;
  parcelas: number;
}

function familiaDoNome(nome: string): Familia {
  if (/SE7\s*\+\s*90/i.test(nome)) return "SE7+90";
  if (/\bBase\b/i.test(nome)) return "BASE";
  return "COMUM";
}

function numeralDoNome(nome: string): string | null {
  if (/\bIII\b/.test(nome)) return "III";
  if (/\bII\b/.test(nome)) return "II";
  return null;
}

function unidadeDoNome(nome: string): string | null {
  return UNIDADES.find((u) => nome.includes(u)) ?? null;
}

function diasDoNome(nome: string): DiaDaSemana[] | null {
  for (const [padrao, dias] of PADROES_DE_DIA) {
    if (padrao.test(nome)) return dias;
  }
  return null;
}

function mesmoConjunto(a: DiaDaSemana[], b: DiaDaSemana[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function lerArquivo(): LinhaPlano[] {
  return readFileSync(ARQUIVO, "utf8")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [id, nome, valor, parcelas] = l.split("\t");
      return {
        legacyId: Number(id),
        nome: nome.trim(),
        valor: Number(valor),
        parcelas: Number(parcelas),
      };
    });
}

async function main() {
  const linhas = lerArquivo();

  const turmas = await prisma.turma.findMany({
    include: { unidade: true, horarios: true },
  });
  if (turmas.length === 0) {
    throw new Error("Nenhuma turma no banco. Rode antes: npm run importar:turmas");
  }

  // O perfil de cada turma, calculado uma vez.
  const perfilTurma = turmas.map((t) => ({
    turma: t,
    unidade: t.unidade.nome,
    dias: [...new Set(t.horarios.map((h) => h.dia))],
    familia: familiaDoNome(t.nome),
    numeral: numeralDoNome(t.nome),
  }));

  let criados = 0;
  let atualizados = 0;
  const semTurma: string[] = [];
  const ligacoes: string[] = [];

  for (const l of linhas) {
    const dados = { nome: l.nome, valor: l.valor, parcelas: l.parcelas };

    let plano = await prisma.plano.findUnique({ where: { legacyId: l.legacyId } });
    if (!plano) {
      const homonimo = await prisma.plano.findFirst({ where: { nome: l.nome, legacyId: null } });
      plano = homonimo
        ? await prisma.plano.update({ where: { id: homonimo.id }, data: { ...dados, legacyId: l.legacyId } })
        : null;
    }

    if (plano) {
      plano = await prisma.plano.update({ where: { id: plano.id }, data: dados });
      atualizados++;
    } else {
      plano = await prisma.plano.create({ data: { ...dados, legacyId: l.legacyId } });
      criados++;
    }

    const unidade = unidadeDoNome(l.nome);
    const dias = diasDoNome(l.nome);
    const familia = familiaDoNome(l.nome);
    const numeral = numeralDoNome(l.nome);

    const casam = perfilTurma.filter(
      (p) =>
        (unidade === null || p.unidade === unidade) &&
        (dias === null || mesmoConjunto(p.dias, dias)) &&
        p.familia === familia &&
        p.numeral === numeral,
    );

    await prisma.planoTurma.deleteMany({ where: { planoId: plano.id } });
    if (casam.length === 0) {
      semTurma.push(`#${l.legacyId} ${l.nome}`);
      continue;
    }

    await prisma.planoTurma.createMany({
      data: casam.map((p) => ({ planoId: plano!.id, turmaId: p.turma.id })),
    });
    ligacoes.push(`  ${l.nome} → ${casam.map((p) => p.turma.nome).join(", ")}`);
  }

  console.log(`planos: ${criados} criados, ${atualizados} atualizados\n`);
  console.log("Ligações plano → turmas:");
  console.log(ligacoes.join("\n"));

  if (semTurma.length) {
    console.log("\nPlanos que não casaram com turma nenhuma:");
    for (const p of semTurma) console.log(`  ${p}`);
  }

  // Esta é a lista que precisa sair vazia: turma sem plano não aceita
  // matrícula, e o erro só apareceria no balcão.
  const orfas = await prisma.turma.findMany({
    where: { planos: { none: {} } },
    include: { unidade: true },
    orderBy: { nome: "asc" },
  });
  if (orfas.length) {
    console.log("\nTURMAS SEM PLANO (não aceitam matrícula):");
    for (const t of orfas) console.log(`  ${t.nome} (${t.unidade.nome})`);
  } else {
    console.log("\nTodas as 46 turmas têm plano.");
  }
}

main()
  .catch((erro) => {
    console.error(String(erro instanceof Error ? erro.message : erro));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
