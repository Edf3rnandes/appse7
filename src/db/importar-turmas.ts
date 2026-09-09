import { readFileSync } from "node:fs";
import { DiaDaSemana } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Importa unidades, turmas e horários do sistema atual.
 *
 * Lê prisma/dados/turmas.tsv, que é a exportação do painel do se7volei. A
 * primeira coluna é o id que a turma tem lá; ele é gravado em `legacyId` e é
 * o que torna esta importação repetível: rodar de novo atualiza a mesma linha
 * em vez de criar outra.
 *
 * A coluna "matriculados" NÃO vira dado. Aluno e matrícula são pessoas e
 * contratos, e serão importados a partir do banco, não de uma contagem. Mas
 * ela é impressa no fim como número de conferência: quando os alunos vierem,
 * a soma por turma tem de bater com esta.
 *
 * Rode com: npm run importar:turmas
 */

const ARQUIVO = "prisma/dados/turmas.tsv";

const DIAS: Record<string, DiaDaSemana> = {
  dom: DiaDaSemana.DOMINGO,
  seg: DiaDaSemana.SEGUNDA,
  ter: DiaDaSemana.TERCA,
  qua: DiaDaSemana.QUARTA,
  qui: DiaDaSemana.QUINTA,
  sex: DiaDaSemana.SEXTA,
  sab: DiaDaSemana.SABADO,
};

interface Linha {
  legacyId: number;
  nome: string;
  horario: string;
  categoria: string;
  unidade: string;
  matriculados: number;
  capacidade: number;
}

interface Bloco {
  dias: DiaDaSemana[];
  inicio: string;
  fim: string;
}

function semAcento(texto: string) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * "Seg/Qua 18:30 às 20:00 e Sex 18:00 às 21:00" -> dois blocos.
 *
 * O texto do sistema antigo é livre, e por isso varia: separador "às", "as"
 * ou "-", e alguns horários vêm com " e " emendando dois blocos diferentes
 * (o SE7+90 treina 1h30 na segunda e quarta e 2h na sexta). Um campo de texto
 * aceita tudo isso; a tabela de horários, não — e é justamente por isso que
 * ela existe.
 */
function lerHorario(texto: string): Bloco[] {
  return texto
    .split(/\s+e\s+/)
    .map((parte) => parte.trim())
    .filter(Boolean)
    .map((parte) => {
      const m = parte.match(
        /^([A-Za-zÀ-ú/]+)\s+(\d{1,2}:\d{2})\s*(?:às|as|a|-|–)\s*(\d{1,2}:\d{2})$/,
      );
      if (!m) throw new Error(`Horário não reconhecido: "${parte}"`);

      const dias = m[1].split("/").map((d) => {
        const chave = semAcento(d).slice(0, 3);
        const dia = DIAS[chave];
        if (!dia) throw new Error(`Dia da semana não reconhecido: "${d}"`);
        return dia;
      });

      return { dias, inicio: m[2].padStart(5, "0"), fim: m[3].padStart(5, "0") };
    });
}

function lerArquivo(): Linha[] {
  return readFileSync(ARQUIVO, "utf8")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [id, nome, horario, categoria, unidade, matriculados, capacidade] = l.split("\t");
      return {
        legacyId: Number(id),
        nome: nome.trim(),
        horario: horario.trim(),
        categoria: categoria.trim(),
        unidade: unidade.trim(),
        matriculados: Number(matriculados),
        capacidade: Number(capacidade),
      };
    });
}

async function main() {
  const linhas = lerArquivo();

  // Valida o arquivo inteiro ANTES de gravar qualquer coisa: um horário que o
  // parser não entende no meio da lista deixaria o banco pela metade.
  const horarios = new Map<number, Bloco[]>();
  for (const l of linhas) {
    try {
      horarios.set(l.legacyId, lerHorario(l.horario));
    } catch (erro) {
      throw new Error(`Turma ${l.legacyId} (${l.nome}): ${(erro as Error).message}`);
    }
  }

  const unidades = new Map<string, string>();
  for (const nome of [...new Set(linhas.map((l) => l.unidade))].sort()) {
    const existente = await prisma.unidade.findFirst({ where: { nome } });
    const salva = existente ?? (await prisma.unidade.create({ data: { nome } }));
    unidades.set(nome, salva.id);
  }

  const adotadas: string[] = [];
  let criadas = 0;
  let atualizadas = 0;

  for (const l of linhas) {
    const dados = {
      nome: l.nome,
      categoria: l.categoria,
      capacidade: l.capacidade,
      unidadeId: unidades.get(l.unidade)!,
    };

    let turma = await prisma.turma.findUnique({ where: { legacyId: l.legacyId } });

    // A turma pode já existir sem legacyId, criada pelo seed de demonstração
    // com o mesmo nome. Adotar em vez de duplicar: duas "BA TQ Adulto 2" na
    // lista da secretaria seriam pior do que qualquer coisa que a importação
    // resolva.
    if (!turma) {
      const homonima = await prisma.turma.findFirst({
        where: { nome: l.nome, legacyId: null },
      });
      if (homonima) {
        turma = await prisma.turma.update({
          where: { id: homonima.id },
          data: { ...dados, legacyId: l.legacyId },
        });
        adotadas.push(l.nome);
      }
    }

    if (turma) {
      await prisma.turma.update({ where: { id: turma.id }, data: dados });
      atualizadas++;
    } else {
      turma = await prisma.turma.create({ data: { ...dados, legacyId: l.legacyId } });
      criadas++;
    }

    // Horários são substituídos por inteiro: é a lista curta e completa da
    // turma, e um diff item a item só criaria chance de sobrar linha velha.
    await prisma.horarioTurma.deleteMany({ where: { turmaId: turma.id } });
    await prisma.horarioTurma.createMany({
      data: horarios.get(l.legacyId)!.flatMap((b) =>
        b.dias.map((dia) => ({ turmaId: turma!.id, dia, inicio: b.inicio, fim: b.fim })),
      ),
    });
  }

  console.log(`unidades: ${unidades.size}`);
  console.log(`turmas: ${criadas} criadas, ${atualizadas} atualizadas`);
  if (adotadas.length) {
    console.log(`adotadas do seed de demonstração: ${adotadas.join(", ")}`);
  }

  // Turmas que hoje estão acima da capacidade declarada. Não é erro da
  // importação: é assim no sistema atual. Vale saber porque a matrícula nova
  // recusa turma cheia, então estas não aceitam mais ninguém até a capacidade
  // ser corrigida ou alguém sair.
  const estouradas = linhas.filter((l) => l.matriculados > l.capacidade);
  if (estouradas.length) {
    console.log("\nAcima da capacidade hoje:");
    for (const l of estouradas) {
      console.log(`  ${l.nome} (${l.unidade}): ${l.matriculados} de ${l.capacidade}`);
    }
  }

  const total = linhas.reduce((s, l) => s + l.matriculados, 0);
  console.log(`\nConferência para quando os alunos vierem: ${total} matrículas no total.`);
}

main()
  .catch((erro) => {
    console.error(String(erro instanceof Error ? erro.message : erro));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
