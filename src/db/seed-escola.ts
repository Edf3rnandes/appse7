import { StatusMatricula } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Dados de demonstração: planos, professores e algumas famílias.
 *
 * Serve para o sistema ser navegável antes da importação dos alunos: dá para
 * sentar com o administrativo e com os professores, usar as telas de verdade e
 * ajustar o que estiver errado, sem esperar a virada.
 *
 * Unidades e turmas NÃO saem daqui — são as de verdade, e vêm de
 * `npm run importar:turmas`. Este seed roda depois e se apoia nelas.
 *
 * Planos também não saem daqui — são os 43 de verdade, de
 * `npm run importar:planos`. Este seed escolhe, para cada matrícula, um plano
 * que valha para aquela turma.
 *
 * Idempotente. NÃO roda sozinho em lugar nenhum: é `npm run seed:escola`.
 */

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
  const turmas = await prisma.turma.findMany({
    include: { unidade: true, planos: { include: { plano: true } } },
  });
  if (turmas.length === 0) {
    console.error("Nenhuma turma no banco. Rode antes: npm run importar:turmas");
    process.exit(1);
  }

  const semPlano = turmas.filter((t) => t.planos.length === 0);
  if (semPlano.length === turmas.length) {
    console.error("Nenhuma turma tem plano. Rode antes: npm run importar:planos");
    process.exit(1);
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

      // Um plano que valha para ESTA turma. Preferimos o semestral, que é o
      // mais comum na escola; se a turma não tiver, o primeiro que houver.
      const plano =
        turma.planos.find((p) => p.plano.nome.startsWith("Semestral")) ?? turma.planos[0];
      if (!plano) {
        console.warn(`turma "${turma.nome}" está sem plano; ${a.nome} ficou sem matrícula.`);
        continue;
      }

      await prisma.matricula.create({
        data: {
          alunoId: aluno.id,
          responsavelId: responsavel.id,
          turmaId: turma.id,
          unidadeId: turma.unidadeId,
          planoId: plano.planoId,
          status: StatusMatricula.CONFIRMADA,
        },
      });
    }
  }

  console.log("demonstração pronta:", {
    turmas: turmas.length,
    planos: await prisma.plano.count(),
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
