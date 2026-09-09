import { DiaDaSemana, StatusMatricula } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Dados de demonstração da escola.
 *
 * Serve para o sistema ser navegável antes da importação: dá para sentar com
 * a secretaria e com os professores, usar as telas de verdade e ajustar o que
 * estiver errado, sem esperar a virada.
 *
 * Idempotente pelo nome de cada registro — rodar duas vezes não duplica.
 * NÃO roda sozinho em lugar nenhum: é `npm run seed:escola`, à mão.
 */

// Unidades e turmas com os nomes que a escola usa de verdade, tirados do
// painel atual: "BA TQ Adulto 2 (Avançado)" é Bancários, terça e quinta.
const UNIDADES = [
  { nome: "Bancários", endereco: "Av. Governador Flávio Ribeiro Coutinho" },
  { nome: "Bessa", endereco: "Av. Gov. Ademar Veloso da Silveira" },
];

const PLANOS = [
  { nome: "Mensal (Bancários T/Q)", valor: 190, parcelas: 1 },
  { nome: "Semestral (Bancários T/Q)", valor: 990, parcelas: 6, descontoPercentual: 10 },
  { nome: "Mensal (Bessa T/Q)", valor: 190, parcelas: 1 },
  { nome: "Semestral (Bessa T/Q)", valor: 990, parcelas: 6, descontoPercentual: 10 },
];

const PROFESSORES = [
  { nome: "Rafael Lima", email: "rafael@exemplo.com" },
  { nome: "Juliana Alves", email: "juliana@exemplo.com" },
];

const TURMAS = [
  {
    nome: "BA TQ Adulto 2 (Avançado)",
    unidade: "Bancários",
    categoria: "Adulto",
    capacidade: 16,
    dias: [DiaDaSemana.TERCA, DiaDaSemana.QUINTA],
    inicio: "19:00",
    fim: "20:30",
  },
  {
    nome: "BA TQ Adulto 1",
    unidade: "Bancários",
    categoria: "Adulto",
    capacidade: 16,
    dias: [DiaDaSemana.TERCA, DiaDaSemana.QUINTA],
    inicio: "17:30",
    fim: "19:00",
  },
  {
    nome: "BS TQ Kids",
    unidade: "Bessa",
    categoria: "Kids",
    capacidade: 12,
    dias: [DiaDaSemana.TERCA, DiaDaSemana.QUINTA],
    inicio: "08:00",
    fim: "09:00",
  },
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
  const unidades = new Map<string, string>();
  for (const u of UNIDADES) {
    const existente = await prisma.unidade.findFirst({ where: { nome: u.nome } });
    const salva = existente ?? (await prisma.unidade.create({ data: u }));
    unidades.set(u.nome, salva.id);
  }

  const planos = new Map<string, string>();
  for (const p of PLANOS) {
    const existente = await prisma.plano.findFirst({ where: { nome: p.nome } });
    const salvo = existente ?? (await prisma.plano.create({ data: p }));
    planos.set(p.nome, salvo.id);
  }

  const professores = new Map<string, string>();
  for (const p of PROFESSORES) {
    const salvo = await prisma.professor.upsert({
      where: { email: p.email },
      create: p,
      update: { nome: p.nome },
    });
    professores.set(p.nome, salvo.id);
  }

  const turmas = new Map<string, string>();
  for (const t of TURMAS) {
    const existente = await prisma.turma.findFirst({ where: { nome: t.nome } });
    if (existente) {
      turmas.set(t.nome, existente.id);
      continue;
    }

    const criada = await prisma.turma.create({
      data: {
        nome: t.nome,
        categoria: t.categoria,
        capacidade: t.capacidade,
        unidadeId: unidades.get(t.unidade)!,
        horarios: { create: t.dias.map((dia) => ({ dia, inicio: t.inicio, fim: t.fim })) },
        professores: {
          create: [...professores.values()].map((professorId) => ({ professorId })),
        },
        planos: {
          create: [...planos.entries()]
            .filter(([nome]) => nome.includes(t.unidade))
            .map(([, planoId]) => ({ planoId })),
        },
      },
    });
    turmas.set(t.nome, criada.id);
  }

  for (const familia of FAMILIAS) {
    const responsavel = await prisma.responsavel.upsert({
      where: { cpf: familia.responsavel.cpf },
      create: familia.responsavel,
      update: {},
    });

    for (const a of familia.alunos) {
      const existente = await prisma.aluno.findFirst({
        where: { nome: a.nome, responsavelId: responsavel.id },
      });
      const aluno =
        existente ??
        (await prisma.aluno.create({ data: { nome: a.nome, responsavelId: responsavel.id } }));

      const turmaId = turmas.get(a.turma)!;
      const turma = await prisma.turma.findUniqueOrThrow({ where: { id: turmaId } });

      const jaTem = await prisma.matricula.findFirst({
        where: { alunoId: aluno.id, turmaId, arquivadoEm: null },
      });
      if (jaTem) continue;

      const planoDaUnidade = [...planos.entries()].find(([nome]) =>
        nome.startsWith("Semestral") && nome.includes(a.turma.startsWith("BA") ? "Bancários" : "Bessa"),
      );

      await prisma.matricula.create({
        data: {
          alunoId: aluno.id,
          responsavelId: responsavel.id,
          turmaId,
          unidadeId: turma.unidadeId,
          planoId: planoDaUnidade![1],
          status: StatusMatricula.CONFIRMADA,
        },
      });
    }
  }

  const contagem = {
    unidades: await prisma.unidade.count(),
    turmas: await prisma.turma.count(),
    planos: await prisma.plano.count(),
    professores: await prisma.professor.count(),
    responsaveis: await prisma.responsavel.count(),
    alunos: await prisma.aluno.count(),
    matriculas: await prisma.matricula.count(),
  };
  console.log("escola de demonstração pronta:", contagem);
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
