import { readFile } from "node:fs/promises";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { somenteDigitos } from "../lib/cpf.js";
import { data, decimal, inteiro, lerDump, texto, type LinhaDump } from "./dump/ler-dump.js";

/**
 * Importa a escola a partir de um dump do MySQL.
 *
 *   npm run importar:dump -- caminho/para/se7volei-dados.sql
 *
 * O dump é gerado assim, no servidor do se7volei:
 *
 *   mysqldump --no-create-info --complete-insert nome_do_banco \
 *     units courses course_schedules plans course_plan teachers course_teacher \
 *     customers students enrollments attendances > se7volei-dados.sql
 *
 * POR QUE POR ARQUIVO, E NÃO PELA CONEXÃO
 * A ponte em src/db/legacy/ lê o MySQL direto e continua lá. Mas ela exige
 * credencial de produção, rede aberta até o banco e alguém de plantão nos dois
 * lados na hora da virada. Um arquivo não exige nada disso — e era esse
 * combinado que estava travando a importação há semanas.
 *
 * REPETÍVEL POR CONSTRUÇÃO
 * Tudo é casado por `legacyId`, o id que a linha tem no MySQL. Rodar de novo
 * ATUALIZA o que já veio, em vez de duplicar. Isso é o que permite importar
 * hoje para conferir, deixar a escola rodando mais duas semanas no sistema
 * antigo, e importar de novo na virada.
 *
 * O QUE ELE NUNCA FAZ
 * Não apaga nada. Um aluno que existe aqui e não está no dump fica como está —
 * pode ter entrado pelo site depois do dump ser gerado. A conferência do fim
 * mostra essas diferenças em vez de resolvê-las sozinho.
 */

const TABELAS = [
  "units",
  "courses",
  "course_schedules",
  "plans",
  "course_plan",
  "teachers",
  "course_teacher",
  "customers",
  "students",
  "enrollments",
  "attendances",
];

/**
 * O de-para do status.
 *
 * `PAYMENT_PENDDING` tem dois D no banco de produção desde 2023. O erro é do
 * original e não vem junto: aqui ele vira o nome certo, em português.
 */
const STATUS: Record<string, StatusMatricula> = {
  CONFIRMED: StatusMatricula.CONFIRMADA,
  PAYMENT_PENDDING: StatusMatricula.PAGAMENTO_PENDENTE,
  PAYMENT_PENDING: StatusMatricula.PAGAMENTO_PENDENTE,
  CREATED: StatusMatricula.CRIADA,
  CANCELED: StatusMatricula.CANCELADA,
  CANCELLED: StatusMatricula.CANCELADA,
};

interface Relatorio {
  lidos: Record<string, number>;
  criados: Record<string, number>;
  atualizados: Record<string, number>;
  ignorados: string[];
}

const conta = (r: Record<string, number>, chave: string) => (r[chave] = (r[chave] ?? 0) + 1);

export async function importarDump(caminho: string): Promise<Relatorio> {
  const bruto = await readFile(caminho, "utf8");
  const tabelas = lerDump(bruto, TABELAS);

  const relatorio: Relatorio = { lidos: {}, criados: {}, atualizados: {}, ignorados: [] };
  for (const [nome, linhas] of tabelas) relatorio.lidos[nome] = linhas.length;

  // ------------------------------------------------------------- unidades
  //
  // Unidades e turmas já foram importadas das planilhas que você mandou, com o
  // mesmo `legacyId`. Aqui elas são reconciliadas, não recriadas: o dump pode
  // trazer uma unidade nova, ou um nome corrigido.
  const unidadePorLegacy = new Map<number, string>();
  for (const u of tabelas.get("units") ?? []) {
    const id = inteiro(u.id);
    const nome = texto(u.name);
    if (id === null || !nome) continue;

    const existente = await prisma.unidade.findUnique({ where: { legacyId: id } });
    if (existente) {
      unidadePorLegacy.set(id, existente.id);
      conta(relatorio.atualizados, "unidades");
    } else {
      const criada = await prisma.unidade.create({
        data: { legacyId: id, nome, endereco: texto(u.address) },
      });
      unidadePorLegacy.set(id, criada.id);
      conta(relatorio.criados, "unidades");
    }
  }

  // ---------------------------------------------------------------- turmas
  const turmaPorLegacy = new Map<number, string>();
  for (const c of tabelas.get("courses") ?? []) {
    const id = inteiro(c.id);
    const nome = texto(c.name);
    if (id === null || !nome) continue;

    const existente = await prisma.turma.findUnique({ where: { legacyId: id } });
    if (existente) {
      turmaPorLegacy.set(id, existente.id);
      conta(relatorio.atualizados, "turmas");
      continue;
    }

    const unidadeId = unidadePorLegacy.get(inteiro(c.unit_id) ?? -1);
    if (!unidadeId) {
      relatorio.ignorados.push(`Turma ${id} (${nome}): unidade ${c.unit_id} não veio no dump.`);
      continue;
    }

    const criada = await prisma.turma.create({
      data: {
        legacyId: id,
        nome,
        categoria: texto(c.category),
        // `amount_students` é text no original. Aqui vira número, e o que não
        // for número vira ausência de capacidade em vez de zero — zero diria
        // "turma sem vaga", que é o oposto de "não sabemos".
        capacidade: inteiro(c.amount_students),
        unidadeId,
      },
    });
    turmaPorLegacy.set(id, criada.id);
    conta(relatorio.criados, "turmas");
  }

  // ---------------------------------------------------------------- planos
  const planoPorLegacy = new Map<number, string>();
  for (const p of tabelas.get("plans") ?? []) {
    const id = inteiro(p.id);
    const nome = texto(p.name);
    if (id === null || !nome) continue;

    const existente = await prisma.plano.findUnique({ where: { legacyId: id } });
    if (existente) {
      planoPorLegacy.set(id, existente.id);
      conta(relatorio.atualizados, "planos");
      continue;
    }

    const criado = await prisma.plano.create({
      data: {
        legacyId: id,
        nome,
        valor: decimal(p.amount) ?? 0,
        parcelas: inteiro(p.installments) ?? 1,
      },
    });
    planoPorLegacy.set(id, criado.id);
    conta(relatorio.criados, "planos");
  }

  // ----------------------------------------------------------- professores
  const professorPorLegacy = new Map<number, string>();
  for (const t of tabelas.get("teachers") ?? []) {
    const id = inteiro(t.id);
    const nome = texto(t.name);
    if (id === null || !nome) continue;

    // `teachers.password` é MD5 sem sal no original. Não vem: professor entra
    // pelo Google ou por convite, e não existe senha nesta tabela.
    const existente = await prisma.professor.findUnique({ where: { legacyId: id } });
    if (existente) {
      professorPorLegacy.set(id, existente.id);
      conta(relatorio.atualizados, "professores");
    } else {
      const criado = await prisma.professor.create({
        data: {
          legacyId: id,
          nome,
          telefone: texto(t.phone),
          ativo: inteiro(t.active) !== 0,
        },
      });
      professorPorLegacy.set(id, criado.id);
      conta(relatorio.criados, "professores");
    }
  }

  // ---------------------------------------------------------- responsáveis
  //
  // O CPF é único aqui. No MySQL não era — e é onde mora a maior parte da
  // sujeira que vamos encontrar: duas linhas com o mesmo CPF são a mesma
  // pessoa cadastrada duas vezes. A segunda não é criada; ela aponta para a
  // primeira, e a conferência do fim lista o caso.
  const responsavelPorLegacy = new Map<number, string>();
  const responsavelPorCpf = new Map<string, string>();

  for (const c of tabelas.get("customers") ?? []) {
    const id = inteiro(c.id);
    const nome = texto(c.name);
    if (id === null || !nome) continue;

    const cpf = somenteDigitos(texto(c.cpf) ?? "");

    const existente = await prisma.responsavel.findUnique({ where: { legacyId: id } });
    if (existente) {
      responsavelPorLegacy.set(id, existente.id);
      if (existente.cpf) responsavelPorCpf.set(existente.cpf, existente.id);
      conta(relatorio.atualizados, "responsaveis");
      continue;
    }

    // Sem CPF não dá para criar: a coluna é obrigatória e única aqui, de
    // propósito — é o CPF que liga a família à conta do portal. Inventar um
    // valor tornaria o vínculo impossível depois.
    if (cpf.length !== 11) {
      relatorio.ignorados.push(
        `Responsável ${id} (${nome}): CPF ausente ou incompleto ("${texto(c.cpf) ?? ""}").`,
      );
      continue;
    }

    const jaTemOCpf =
      responsavelPorCpf.get(cpf) ??
      (await prisma.responsavel.findUnique({ where: { cpf } }))?.id;

    if (jaTemOCpf) {
      responsavelPorLegacy.set(id, jaTemOCpf);
      responsavelPorCpf.set(cpf, jaTemOCpf);
      relatorio.ignorados.push(
        `Responsável ${id} (${nome}): CPF ${cpf} já pertence a outro cadastro. ` +
          `As matrículas dele foram para o cadastro que já existia.`,
      );
      continue;
    }

    const criado = await prisma.responsavel.create({
      data: {
        legacyId: id,
        nome,
        cpf,
        email: texto(c.email),
        telefone: texto(c.phone),
        asaasCustomer: texto(c.asaas_customer),
        cep: somenteDigitos(texto(c.address_zipcode) ?? "") || null,
        logradouro: texto(c.street_name),
        // NOT NULL sem default no original, numa tabela que já tinha linhas.
        // Aqui é opcional, como o resto do endereço.
        numero: texto(c.address_number),
        complemento: texto(c.address_complement),
        bairro: texto(c.neighborhood_name),
        cidade: texto(c.city_name),
        estado: texto(c.state_name)?.slice(0, 2).toUpperCase() ?? null,
      },
    });
    responsavelPorLegacy.set(id, criado.id);
    responsavelPorCpf.set(cpf, criado.id);
    conta(relatorio.criados, "responsaveis");
  }

  // ---------------------------------------------------------------- alunos
  const alunoPorLegacy = new Map<number, string>();
  for (const s of tabelas.get("students") ?? []) {
    const id = inteiro(s.id);
    const nome = texto(s.name);
    if (id === null || !nome) continue;

    const existente = await prisma.aluno.findUnique({ where: { legacyId: id } });
    if (existente) {
      alunoPorLegacy.set(id, existente.id);
      conta(relatorio.atualizados, "alunos");
      continue;
    }

    // `students.customer_id` era um integer solto, sem chave estrangeira: dava
    // para gravar aluno apontando para responsável que não existe. Aqui a
    // relação é real, então o aluno órfão não entra — ele é listado.
    const responsavelId = responsavelPorLegacy.get(inteiro(s.customer_id) ?? -1);
    if (!responsavelId) {
      relatorio.ignorados.push(
        `Aluno ${id} (${nome}): responsável ${s.customer_id} não existe no dump.`,
      );
      continue;
    }

    const criado = await prisma.aluno.create({
      data: {
        legacyId: id,
        nome,
        nascimento: data(s.birth_date),
        responsavelId,
      },
    });
    alunoPorLegacy.set(id, criado.id);
    conta(relatorio.criados, "alunos");
  }

  // ------------------------------------------------------------ matrículas
  const matriculaPorLegacy = new Map<number, string>();
  for (const e of tabelas.get("enrollments") ?? []) {
    const id = inteiro(e.id);
    if (id === null) continue;

    const existente = await prisma.matricula.findUnique({ where: { legacyId: id } });
    if (existente) {
      matriculaPorLegacy.set(id, existente.id);
      conta(relatorio.atualizados, "matriculas");
      continue;
    }

    const alunoId = alunoPorLegacy.get(inteiro(e.student_id) ?? -1);
    const turmaId = turmaPorLegacy.get(inteiro(e.course_id) ?? -1);
    const planoId = planoPorLegacy.get(inteiro(e.plan_id) ?? -1);

    if (!alunoId || !turmaId) {
      relatorio.ignorados.push(
        `Matrícula ${id}: ${!alunoId ? `aluno ${e.student_id}` : `turma ${e.course_id}`} não encontrado.`,
      );
      continue;
    }
    if (!planoId) {
      relatorio.ignorados.push(`Matrícula ${id}: plano ${e.plan_id} não encontrado.`);
      continue;
    }

    // O aluno adulto é responsável por si e pode estar sem responsavelId no
    // cadastro; a matrícula, não — ela precisa de quem paga. Quando o aluno
    // não tem, usamos o `customer_id` da própria matrícula do dump.
    const aluno = await prisma.aluno.findUniqueOrThrow({
      where: { id: alunoId },
      select: { responsavelId: true },
    });
    const responsavelId =
      aluno.responsavelId ?? responsavelPorLegacy.get(inteiro(e.customer_id) ?? -1);

    if (!responsavelId) {
      relatorio.ignorados.push(
        `Matrícula ${id}: não foi possível dizer quem é o responsável financeiro.`,
      );
      continue;
    }
    const turma = await prisma.turma.findUniqueOrThrow({
      where: { id: turmaId },
      select: { unidadeId: true },
    });

    const statusBruto = (texto(e.status) ?? "").toUpperCase();
    const status = STATUS[statusBruto];
    if (!status) {
      relatorio.ignorados.push(`Matrícula ${id}: status "${statusBruto}" desconhecido.`);
      continue;
    }

    const criada = await prisma.matricula.create({
      data: {
        legacyId: id,
        alunoId,
        responsavelId,
        turmaId,
        unidadeId: turma.unidadeId,
        planoId,
        status,
        expiraEm: data(e.expires_at),
        // `category` guarda 'parent'/'child' no original — a mesma coluna que
        // em `courses` guarda Kids/Teens/Adulto. Duas coisas sem relação no
        // mesmo nome; aqui viram um booleano com nome próprio.
        principal: (texto(e.category) ?? "parent").toLowerCase() !== "child",
        criadoEm: data(e.created_at) ?? new Date(),
        // O Laravel importava SoftDeletes e nunca aplicava: cancelar apagava a
        // linha. Quando a data existe, ela vem; quando não, o status já diz.
        canceladaEm: status === StatusMatricula.CANCELADA ? data(e.updated_at) : null,
      },
    });
    matriculaPorLegacy.set(id, criada.id);
    conta(relatorio.criados, "matriculas");
  }

  // --------------------------------------------------------------- chamada
  //
  // No original só a presença virava linha: a falta era a ausência de registro.
  // Aqui a falta é uma linha com `presente: false`, o que é o que permite
  // dizer percentual de presença. O que vier do dump é o que der para saber.
  await importarPresencas(
    tabelas.get("attendances") ?? [],
    alunoPorLegacy,
    turmaPorLegacy,
    professorPorLegacy,
    relatorio,
  );

  return relatorio;
}

async function importarPresencas(
  linhas: LinhaDump[],
  alunoPorLegacy: Map<number, string>,
  turmaPorLegacy: Map<number, string>,
  professorPorLegacy: Map<number, string>,
  relatorio: Relatorio,
) {
  // Um professor qualquer, para o caso de a chamada não dizer quem fez. A
  // coluna é obrigatória aqui, e perder a frequência inteira de um aluno por
  // causa de um professor não informado seria pior do que atribuí-la.
  const primeiroProfessor = [...professorPorLegacy.values()][0];

  for (const a of linhas) {
    const alunoId = alunoPorLegacy.get(inteiro(a.student_id) ?? -1);
    const turmaId = turmaPorLegacy.get(inteiro(a.course_id) ?? -1);
    const quando = data(a.attendance_date);
    const professorId = professorPorLegacy.get(inteiro(a.teacher_id) ?? -1) ?? primeiroProfessor;

    if (!alunoId || !turmaId || !quando || !professorId) continue;

    try {
      const presente = inteiro(a.has_presence) !== 0;

      // Consulta antes do upsert só para o relatório saber o que dizer. O
      // upsert sozinho não conta qual dos dois caminhos tomou, e "3 novos" na
      // segunda rodada faria o relatório mentir justamente sobre a coisa que
      // ele existe para provar: que rodar de novo não duplica.
      const jaExistia = await prisma.presenca.findUnique({
        where: { turmaId_alunoId_data: { turmaId, alunoId, data: quando } },
        select: { id: true },
      });

      await prisma.presenca.upsert({
        where: { turmaId_alunoId_data: { turmaId, alunoId, data: quando } },
        create: { turmaId, alunoId, professorId, data: quando, presente },
        update: { presente },
      });
      conta(jaExistia ? relatorio.atualizados : relatorio.criados, "presencas");
    } catch {
      relatorio.ignorados.push(`Chamada de ${a.attendance_date}: não foi possível gravar.`);
    }
  }
}

/** Como o relatório aparece no terminal. */
export function escreverRelatorio(r: Relatorio) {
  const linha = (rotulo: string, valor: string | number) =>
    console.log(`  ${rotulo.padEnd(16)} ${valor}`);

  console.log("\nLIDO DO DUMP");
  for (const [tabela, n] of Object.entries(r.lidos)) linha(tabela, n);

  console.log("\nGRAVADO");
  const chaves = new Set([...Object.keys(r.criados), ...Object.keys(r.atualizados)]);
  for (const c of chaves) {
    linha(c, `${r.criados[c] ?? 0} novos, ${r.atualizados[c] ?? 0} já existiam`);
  }

  if (r.ignorados.length) {
    console.log(`\nNÃO ENTRARAM (${r.ignorados.length})`);
    // Todos, não uma amostra: cada linha aqui é uma pessoa que ficou de fora, e
    // esconder o resto atrás de "e mais 40" é como o dado some.
    for (const i of r.ignorados) console.log(`  - ${i}`);
  } else {
    console.log("\nNÃO ENTRARAM\n  nada — o dump entrou inteiro.");
  }
}

// Rodado direto pela linha de comando.
if (process.argv[1] && process.argv[1].endsWith("importar-dump.ts")) {
  const caminho = process.argv[2];

  if (!caminho) {
    console.error(
      "Informe o arquivo:\n" +
        "  npm run importar:dump -- caminho/para/se7volei-dados.sql\n",
    );
    process.exit(1);
  }

  importarDump(caminho)
    .then(async (r) => {
      escreverRelatorio(r);
      await prisma.$disconnect();
    })
    .catch(async (erro) => {
      console.error("\nA importação parou:", (erro as Error).message);
      await prisma.$disconnect();
      process.exit(1);
    });
}
