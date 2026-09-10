import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DiaDaSemana, StatusMatricula } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import {
  copiarOcupacaoParaCobrancas,
  formatarDiasDeTreino,
  ocupacaoReal,
  tabelaDeSnapshotsExiste,
} from "../src/modules/socios/ocupacao-cobrancas.js";

/**
 * A cópia da ocupação real para o se7-cobrancas.
 *
 * Não é uma consulta ao vivo entre os dois bancos — é literalmente uma cópia,
 * de propósito (ver o cabeçalho de ocupacao-cobrancas.ts). Os testes daqui
 * não escrevem em `public.turma_snapshots`: um Hub instalado sozinho, sem o
 * se7-cobrancas ao lado — o caso normal, e o único que `docs/colocar-no-ar.md`
 * promete — nem tem essa tabela, e é exatamente essa ausência que o teste de
 * segurança confirma. Escrever de verdade nela foi conferido à mão contra um
 * Postgres com as duas tabelas presentes: os números batem, e a leitura do
 * se7-cobrancas (`unidadesAlunos.service.ts`, sem nenhuma mudança) enxerga a
 * cópia como se fosse a planilha de sempre.
 */

describe("formatarDiasDeTreino", () => {
  it("ordena de segunda a domingo, não na ordem em que os horários vieram", () => {
    assert.equal(
      formatarDiasDeTreino([{ dia: DiaDaSemana.SEXTA }, { dia: DiaDaSemana.SEGUNDA }]),
      "Seg - Sex",
    );
  });

  it("não repete um dia com dois horários (manhã e noite, por exemplo)", () => {
    assert.equal(
      formatarDiasDeTreino([{ dia: DiaDaSemana.TERCA }, { dia: DiaDaSemana.TERCA }]),
      "Ter",
    );
  });

  it("turma sem horário cadastrado vira string vazia, não erro", () => {
    assert.equal(formatarDiasDeTreino([]), "");
  });
});

const MARCA = "ZZ-teste-ocupacao";

async function limpar() {
  await prisma.matricula.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.horarioTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.planoTurma.deleteMany({ where: { turma: { nome: { contains: MARCA } } } });
  await prisma.turma.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.plano.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.responsavel.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.aluno.deleteMany({ where: { nome: { contains: MARCA } } });
  await prisma.unidade.deleteMany({ where: { nome: { contains: MARCA } } });
}

describe("ocupacaoReal", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("conta matriculado ativo, ignora turma inativa, e usa o nome da unidade como chave", async () => {
    const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} Bessa` } });
    const plano = await prisma.plano.create({
      data: { nome: `${MARCA} Mensal`, valor: 100, parcelas: 1 },
    });
    const responsavel = await prisma.responsavel.create({
      data: { nome: `${MARCA} Resp`, cpf: "11111111111" },
    });
    const aluno = await prisma.aluno.create({
      data: { nome: `${MARCA} Aluno`, responsavelId: responsavel.id },
    });

    const turma = await prisma.turma.create({
      data: {
        nome: `${MARCA} Turma Cheia`,
        unidadeId: unidade.id,
        capacidade: 20,
        horarios: {
          create: [
            { dia: DiaDaSemana.QUINTA, inicio: "18:00", fim: "19:00" },
            { dia: DiaDaSemana.SEGUNDA, inicio: "18:00", fim: "19:00" },
          ],
        },
      },
    });
    await prisma.matricula.create({
      data: {
        alunoId: aluno.id,
        responsavelId: responsavel.id,
        turmaId: turma.id,
        unidadeId: unidade.id,
        planoId: plano.id,
        status: StatusMatricula.CONFIRMADA,
      },
    });

    // Turma inativa: não pode aparecer na cópia — não é vaga que o
    // se7-cobrancas deveria oferecer.
    await prisma.turma.create({
      data: { nome: `${MARCA} Turma Desativada`, unidadeId: unidade.id, capacidade: 10, ativa: false },
    });

    const linhas = await ocupacaoReal();
    const doTeste = linhas.filter((l) => l.turma.startsWith(MARCA));

    assert.equal(doTeste.length, 1, "só a turma ativa deveria aparecer");
    const [linha] = doTeste;
    assert.equal(linha.turma, `${MARCA} Turma Cheia`);
    assert.equal(linha.unidadeNome, `${MARCA} Bessa`);
    // O se7-cobrancas nunca teve o id real da unidade — usa o nome como
    // chave, e é isso que a cópia tem que preservar.
    assert.equal(linha.unidadeIdLegacy, `${MARCA} Bessa`);
    assert.equal(linha.matriculados, 1);
    assert.equal(linha.vagas, 20);
    assert.equal(linha.diasDeTreino, "Seg - Qui");
  });

  it("turma sem capacidade cadastrada vira vagas: 0, não null nem erro", async () => {
    const unidade = await prisma.unidade.create({ data: { nome: `${MARCA} SemCap` } });
    await prisma.turma.create({
      data: { nome: `${MARCA} Sem Capacidade`, unidadeId: unidade.id },
    });

    const linhas = await ocupacaoReal();
    const linha = linhas.find((l) => l.turma === `${MARCA} Sem Capacidade`);

    assert.ok(linha);
    assert.equal(linha.vagas, 0);
    assert.equal(linha.matriculados, 0);
  });
});

describe("copiarOcupacaoParaCobrancas", () => {
  it("num Hub instalado sozinho (sem a tabela do se7-cobrancas), não escreve nada e não falha", async () => {
    const existe = await tabelaDeSnapshotsExiste();
    // Este é o caso normal — o único que docs/colocar-no-ar.md promete. Se o
    // ambiente deste teste por acaso tiver o se7-cobrancas instalado ao lado
    // (não é o caso de CI nem de uma instalação nova), o teste não teria como
    // provar a ausência sem escrever na tabela de um sistema vizinho — e por
    // isso ele só afirma a parte que é sempre verdade nesse caso.
    if (existe) {
      return;
    }

    const resultado = await copiarOcupacaoParaCobrancas();
    assert.deepEqual(resultado, { gravado: false, turmas: 0 });
  });
});
