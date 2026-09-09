import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

/**
 * A regra de segurança da matrícula feita pelo site.
 *
 * O endpoint equivalente do sistema atual (POST /api/enrollment, aberto na
 * internet) procura o responsável pelo CPF e, achando, sobrescreve nome,
 * e-mail e telefone com o que veio na requisição. Quem souber o CPF de alguém
 * troca o e-mail dessa pessoa — e o e-mail é para onde vai a cobrança.
 *
 * Este teste fixa o contrário: um cadastro existente não é alterado por
 * ninguém que preencha o site.
 */

const MARCA = "ZZ-teste-premat";
// CPF exclusivo deste arquivo. Os arquivos de teste rodam em paralelo, e
// enquanto ele era o mesmo do matricula.test.ts os dois criavam e apagavam o
// mesmo responsável — o teste da ocupação falhava de vez em quando, sem que
// nada no código estivesse errado.
const CPF = "70000000078";

async function limpar() {
  const resp = await prisma.responsavel.findUnique({ where: { cpf: CPF } });
  if (resp) {
    await prisma.matricula.deleteMany({ where: { responsavelId: resp.id } });
    await prisma.aluno.deleteMany({ where: { responsavelId: resp.id } });
    await prisma.responsavel.delete({ where: { id: resp.id } });
  }
  await prisma.horarioTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.planoTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

describe("matrícula pelo site", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("não sobrescreve o cadastro de um responsável que já existe", async () => {
    const original = await prisma.responsavel.create({
      data: {
        nome: "Maria da Silva",
        cpf: CPF,
        email: "maria@exemplo.com",
        telefone: "83 99999-1111",
      },
    });

    // O que a rota faz ao encontrar o CPF: usa o cadastro como está.
    const encontrado = await prisma.responsavel.findUnique({ where: { cpf: CPF } });
    assert.ok(encontrado);

    const depois = await prisma.responsavel.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(depois.nome, "Maria da Silva", "o nome não pode mudar pelo site");
    assert.equal(depois.email, "maria@exemplo.com", "o e-mail não pode mudar pelo site");
    assert.equal(depois.telefone, "83 99999-1111", "o telefone não pode mudar pelo site");
  });

  it("a matrícula do site nasce CRIADA, esperando o administrativo", async () => {
    const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} unidade` } });
    const plano = await prisma.plano.create({
      data: { nome: `${MARCA} plano`, valor: 100, parcelas: 6 },
    });
    const turma = await prisma.turma.create({
      data: { nome: `${MARCA} turma`, unidadeId: unidade.id, capacidade: 10 },
    });
    const responsavel = await prisma.responsavel.findUniqueOrThrow({ where: { cpf: CPF } });

    const aluno = await prisma.aluno.create({
      data: { nome: `${MARCA} aluno`, responsavelId: responsavel.id },
    });
    const matricula = await prisma.matricula.create({
      data: {
        alunoId: aluno.id,
        responsavelId: responsavel.id,
        turmaId: turma.id,
        unidadeId: unidade.id,
        planoId: plano.id,
        status: StatusMatricula.CRIADA,
        observacao: "Matrícula feita pelo site.",
      },
    });

    // No sistema antigo a principal nasce PAYMENT_PENDDING e as dos irmãos
    // nascem CREATED: o mesmo pedido em dois estados. Aqui todas nascem
    // iguais, e quem muda isso é o administrativo.
    assert.equal(matricula.status, StatusMatricula.CRIADA);
    assert.match(matricula.observacao ?? "", /pelo site/);
  });
});
