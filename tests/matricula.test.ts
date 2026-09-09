import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DiaDaSemana, StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

/**
 * Regras de matrícula que o sistema antigo não tinha.
 *
 * Duas delas existem por causa de defeitos concretos do se7volei:
 *   - a capacidade da turma era `text` e nunca conferida, então turma lotada
 *     só aparecia quando o professor reclamava em quadra;
 *   - a mesma dupla aluno/turma podia ser matriculada de novo, e a segunda
 *     linha virava cobrança duplicada.
 *
 * Precisa de um Postgres com o schema do Hub. Rode com:
 *   DATABASE_URL=... JWT_SECRET=... npm test
 */

const MARCA = "ZZ-teste-matricula";

async function limpar() {
  await prisma.presenca.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.horarioTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

async function cenario(capacidade: number) {
  const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
  const plano = await prisma.plano.create({ data: { nome: `${MARCA} plano`, valor: 100 } });
  const turma = await prisma.turma.create({
    data: {
      nome: `${MARCA} turma`,
      unidadeId: unidade.id,
      capacidade,
      horarios: { create: [{ dia: DiaDaSemana.TERCA, inicio: "19:00", fim: "20:30" }] },
    },
  });
  // CPF é único, então o responsável é um só para os três cenários — criar
  // outro a cada teste esbarraria na própria restrição que queremos ter.
  const responsavel = await prisma.responsavel.upsert({
    where: { cpf: "39053344705" },
    create: { nome: `${MARCA} responsavel`, cpf: "39053344705" },
    update: {},
  });
  return { unidade, plano, turma, responsavel };
}

function matricular(
  ctx: Awaited<ReturnType<typeof cenario>>,
  alunoId: string,
  status = StatusMatricula.CONFIRMADA,
) {
  return prisma.matricula.create({
    data: {
      alunoId,
      responsavelId: ctx.responsavel.id,
      turmaId: ctx.turma.id,
      unidadeId: ctx.unidade.id,
      planoId: ctx.plano.id,
      status,
    },
  });
}

describe("matrícula", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("conta a ocupação da turma pelas matrículas confirmadas", async () => {
    const ctx = await cenario(2);

    const a1 = await prisma.aluno.create({
      data: { nome: `${MARCA} aluno 1`, responsavelId: ctx.responsavel.id },
    });
    const a2 = await prisma.aluno.create({
      data: { nome: `${MARCA} aluno 2`, responsavelId: ctx.responsavel.id },
    });

    await matricular(ctx, a1.id);
    await matricular(ctx, a2.id, StatusMatricula.CANCELADA);

    const confirmadas = await prisma.matricula.count({
      where: { turmaId: ctx.turma.id, status: StatusMatricula.CONFIRMADA, arquivadoEm: null },
    });

    // A cancelada não ocupa vaga — no sistema antigo ela sumia do banco, aqui
    // ela fica no histórico sem contar para a lotação.
    assert.equal(confirmadas, 1);
  });

  it("arquivar não apaga: a linha continua legível", async () => {
    const ctx = await cenario(5);
    const aluno = await prisma.aluno.create({
      data: { nome: `${MARCA} aluno arquivado`, responsavelId: ctx.responsavel.id },
    });
    const m = await matricular(ctx, aluno.id);

    await prisma.matricula.update({ where: { id: m.id }, data: { arquivadoEm: new Date() } });
    await prisma.aluno.update({ where: { id: aluno.id }, data: { arquivadoEm: new Date() } });

    const aindaLa = await prisma.matricula.findUnique({
      where: { id: m.id },
      include: { aluno: true },
    });

    assert.ok(aindaLa, "a matrícula não pode sumir do banco");
    assert.equal(aindaLa.aluno.nome, `${MARCA} aluno arquivado`);
    assert.ok(aindaLa.arquivadoEm);
  });

  // O plano família: um responsável paga por dois ou três filhos, e uma das
  // matrículas carrega a cobrança. No sistema antigo isso era a coluna
  // `category` com 'parent'/'child' — a mesma coluna que em `courses` guarda
  // Kids/Teens/Adulto.
  it("a primeira matrícula do responsável nasce principal, as seguintes vinculadas", async () => {
    const ctx = await cenario(10);

    // O responsável é o mesmo dos outros testes (o CPF é único), e as
    // matrículas que eles criaram continuam ativas. A regra que estamos
    // testando pergunta "já existe principal para este responsável?", então
    // ela precisa começar de zero — senão o teste mediria a ordem em que os
    // testes rodam, não a regra.
    await prisma.matricula.deleteMany({ where: { responsavelId: ctx.responsavel.id } });

    const primeiro = await prisma.aluno.create({
      data: { nome: `${MARCA} irmão 1`, responsavelId: ctx.responsavel.id },
    });
    const segundo = await prisma.aluno.create({
      data: { nome: `${MARCA} irmão 2`, responsavelId: ctx.responsavel.id },
    });

    // A regra mora na rota; aqui reproduzimos a decisão que ela toma, que é
    // "já existe principal ativa para este responsável?".
    const decidir = async () =>
      (await prisma.matricula.count({
        where: {
          responsavelId: ctx.responsavel.id,
          principal: true,
          arquivadoEm: null,
          status: { not: StatusMatricula.CANCELADA },
        },
      })) === 0;

    const m1 = await prisma.matricula.create({
      data: {
        alunoId: primeiro.id, responsavelId: ctx.responsavel.id, turmaId: ctx.turma.id,
        unidadeId: ctx.unidade.id, planoId: ctx.plano.id,
        status: StatusMatricula.CONFIRMADA, principal: await decidir(),
      },
    });
    const m2 = await prisma.matricula.create({
      data: {
        alunoId: segundo.id, responsavelId: ctx.responsavel.id, turmaId: ctx.turma.id,
        unidadeId: ctx.unidade.id, planoId: ctx.plano.id,
        status: StatusMatricula.CONFIRMADA, principal: await decidir(),
      },
    });

    assert.equal(m1.principal, true, "a primeira deveria ser a principal");
    assert.equal(m2.principal, false, "a segunda deveria nascer vinculada");

    // E a família de uma traz a outra — é o "Matrículas Vinculadas" da tela.
    const familia = await prisma.matricula.findMany({
      where: { responsavelId: ctx.responsavel.id, id: { not: m2.id }, arquivadoEm: null },
    });
    assert.ok(familia.some((f) => f.id === m1.id));
  });

  it("uma chamada por aluno por dia: reenviar corrige em vez de duplicar", async () => {
    const ctx = await cenario(5);
    const professor = await prisma.professor.create({ data: { nome: `${MARCA} professor` } });
    const aluno = await prisma.aluno.create({
      data: { nome: `${MARCA} aluno presenca`, responsavelId: ctx.responsavel.id },
    });
    await matricular(ctx, aluno.id);

    const data = new Date("2026-09-08T00:00:00.000Z");
    const chave = { turmaId_alunoId_data: { turmaId: ctx.turma.id, alunoId: aluno.id, data } };

    await prisma.presenca.upsert({
      where: chave,
      create: { turmaId: ctx.turma.id, alunoId: aluno.id, professorId: professor.id, data, presente: false },
      update: { presente: false },
    });
    await prisma.presenca.upsert({
      where: chave,
      create: { turmaId: ctx.turma.id, alunoId: aluno.id, professorId: professor.id, data, presente: true },
      update: { presente: true },
    });

    const linhas = await prisma.presenca.findMany({
      where: { turmaId: ctx.turma.id, alunoId: aluno.id, data },
    });

    assert.equal(linhas.length, 1, "o reenvio não pode criar uma segunda linha");
    assert.equal(linhas[0].presente, true, "o reenvio deveria ter corrigido a falta");

    await prisma.presenca.deleteMany({ where: { turmaId: ctx.turma.id } });
    await prisma.professor.deleteMany({ where: { nome: { contains: MARCA } } });
  });
});
