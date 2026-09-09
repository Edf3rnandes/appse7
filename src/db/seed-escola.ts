import { StatusMatricula } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Dados de demonstração: planos, professores e algumas famílias.
 *
 * Serve para o sistema ser navegável antes da importação dos alunos: dá para
 * sentar com a secretaria e com os professores, usar as telas de verdade e
 * ajustar o que estiver errado, sem esperar a virada.
 *
 * Unidades e turmas NÃO saem daqui — são as de verdade, e vêm de
 * `npm run importar:turmas`. Este seed roda depois e se apoia nelas.
 *
 * Os planos são inventados: os 43 planos reais virão com a importação, e até
 * lá dois planos ligados a todas as turmas bastam para exercitar a matrícula.
 *
 * Idempotente. NÃO roda sozinho em lugar nenhum: é `npm run seed:escola`.
 */

const PLANOS = [
  { nome: "Mensal", valor: 190, parcelas: 1 },
  { nome: "Semestral", valor: 990, parcelas: 6, descontoPercentual: 10 },
];

const PROFESSORES = [
  { nome: "Rafael Lima", email: "rafael@exemplo.com" },
  { nome: "Juliana Alves", email: "juliana@exemplo.com" },
];

const FAMILIAS = [
  {
    responsavel: { nome: "Marina Nóbrega", cpf: "52998224725", telefone: "83 99999-0001" },
    alunos: [{ nome: "Miguel Leuson de Souza Nóbrega", turma: "BA TQ Adulto 2 (Avançado)" }],
  },
  {
    responsavel: { nome: "Carla Gati", cpf: "16899535009", telefone: "83 99999-0002" },
    alunos: [{ nome: "Cecília Amorim Gati", turma: "BA TQ Adulto 2 (Avançado)" }],
  },
  {
    responsavel: { nome: "Paulo Honor", cpf: "11144477735", telefone: "83 99999-0003" },
    alunos: [
      { nome: "Beatriz Honor", turma: "BS TQ Kids" },
      { nome: "Rafaela Honor", turma: "BS TQ Kids" },
    ],
  },
];

async function main() {
  const turmas = await prisma.turma.findMany({ include: { unidade: true } });
  if (turmas.length === 0) {
    console.error("Nenhuma turma no banco. Rode antes: npm run importar:turmas");
    process.exit(1);
  }

  const planos = new Map<string, string>();
  for (const p of PLANOS) {
    const existente = await prisma.plano.findFirst({ where: { nome: p.nome } });
    const salvo = existente ?? (await prisma.plano.create({ data: p }));
    planos.set(p.nome, salvo.id);
  }

  // Todo plano vale para toda turma, só na demonstração: assim dá para
  // matricular em qualquer uma das 46 sem cadastrar 46 combinações à mão.
  for (const turma of turmas) {
    for (const planoId of planos.values()) {
      await prisma.planoTurma.upsert({
        where: { planoId_turmaId: { planoId, turmaId: turma.id } },
        create: { planoId, turmaId: turma.id },
        update: {},
      });
    }
  }

  const professores = new Map<string, string>();
  for (const p of PROFESSORES) {
    const salvo = await prisma.professor.upsert({
      where: { email: p.email },
      create: p,
      update: { nome: p.nome },
    });
    professores.set(p.nome, salvo.id);

    // Na demonstração cada professor pega as turmas de duas unidades, para o
    // app dele não abrir com as 46 de uma vez.
    const doProfessor = turmas.filter((t) =>
      ["Bancários", "Bessa"].includes(t.unidade.nome),
    );
    for (const turma of doProfessor) {
      await prisma.professorTurma.upsert({
        where: { professorId_turmaId: { professorId: salvo.id, turmaId: turma.id } },
        create: { professorId: salvo.id, turmaId: turma.id },
        update: {},
      });
    }
  }

  for (const familia of FAMILIAS) {
    const responsavel = await prisma.responsavel.upsert({
      where: { cpf: familia.responsavel.cpf },
      create: familia.responsavel,
      update: {},
    });

    for (const a of familia.alunos) {
      const turma = turmas.find((t) => t.nome === a.turma);
      if (!turma) {
        console.warn(`turma "${a.turma}" não existe; ${a.nome} ficou sem matrícula.`);
        continue;
      }

      const existente = await prisma.aluno.findFirst({
        where: { nome: a.nome, responsavelId: responsavel.id },
      });
      const aluno =
        existente ??
        (await prisma.aluno.create({ data: { nome: a.nome, responsavelId: responsavel.id } }));

      const jaTem = await prisma.matricula.findFirst({
        where: { alunoId: aluno.id, turmaId: turma.id, arquivadoEm: null },
      });
      if (jaTem) continue;

      await prisma.matricula.create({
        data: {
          alunoId: aluno.id,
          responsavelId: responsavel.id,
          turmaId: turma.id,
          unidadeId: turma.unidadeId,
          planoId: planos.get("Semestral")!,
          status: StatusMatricula.CONFIRMADA,
        },
      });
    }
  }

  console.log("demonstração pronta:", {
    turmas: turmas.length,
    planos: planos.size,
    professores: professores.size,
    responsaveis: await prisma.responsavel.count(),
    alunos: await prisma.aluno.count(),
    matriculas: await prisma.matricula.count(),
  });
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
