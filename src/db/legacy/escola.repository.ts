import { readOnlyQuery } from "./pool.js";
import { somenteDigitos } from "../../lib/cpf.js";

// Consultas ao MySQL do sistema Laravel.
//
// IMPORTANTE — os nomes de tabela e coluna aqui NAO sao suposicao: foram
// tirados das migrations reais do repositorio se7volei (units, courses,
// students, customers, enrollments, plans, attendances, teachers e os pivots
// course_teacher e course_plan). O esboco anterior desta camada, no
// se7-inadimplencia, chutava `alunos`/`unidades` com `status = 'ativo'` — essas
// tabelas nao existem, e por isso a ponte nunca teria funcionado como estava.
//
// Duas particularidades do legado que valem para todas as consultas abaixo:
//   - Matricula ativa e `enrollments.status = 'CONFIRMED'`. Os outros valores
//     do enum sao CREATED, PAYMENT_PENDDING (com dois D mesmo) e CANCELED.
//   - As tabelas students/customers/enrollments tem coluna `deleted_at`, mas o
//     Laravel nunca usa SoftDeletes de fato (a trait esta importada e nao
//     aplicada). Filtramos por `deleted_at IS NULL` assim mesmo: custa nada e
//     ja fica correto no dia em que aquele bug for corrigido la.

export interface ResponsavelLegado {
  id: number;
  nome: string;
  email: string | null;
  telefone: string | null;
  cpf: string;
  asaasCustomer: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
}

const SQL_RESPONSAVEL_POR_CPF = `
  SELECT
    c.id                      AS id,
    c.name                    AS nome,
    c.email                   AS email,
    c.phone                   AS telefone,
    c.cpf                     AS cpf,
    c.asaas_customer          AS asaasCustomer,
    c.address_zipcode         AS cep,
    c.street_name             AS logradouro,
    c.address_number          AS numero,
    c.address_complement      AS complemento,
    c.neighborhood_name       AS bairro,
    c.city_name               AS cidade,
    c.state_name              AS estado
  FROM customers c
  WHERE REPLACE(REPLACE(REPLACE(c.cpf, '.', ''), '-', ''), ' ', '') = :cpf
    AND c.deleted_at IS NULL
  LIMIT 1
`;

export async function buscarResponsavelPorCpf(cpf: string): Promise<ResponsavelLegado | null> {
  const linhas = await readOnlyQuery<ResponsavelLegado>(SQL_RESPONSAVEL_POR_CPF, {
    cpf: somenteDigitos(cpf),
  });
  return linhas[0] ?? null;
}

export interface AlunoLegado {
  id: number;
  nome: string;
  nascimento: string | null;
  foto: string | null;
  matriculaId: number | null;
  matriculaStatus: string | null;
  expiraEm: string | null;
  turmaId: number | null;
  turmaNome: string | null;
  categoria: string | null;
  unidadeId: number | null;
  unidadeNome: string | null;
  planoId: number | null;
  planoNome: string | null;
}

// Alunos de um responsavel, com a matricula mais recente de cada um.
// O LEFT JOIN preserva o aluno cadastrado que ainda nao tem matricula —
// situacao comum no legado, onde o cadastro do aluno vem antes.
const SQL_ALUNOS_DO_RESPONSAVEL = `
  SELECT
    s.id            AS id,
    s.name          AS nome,
    s.birth_date    AS nascimento,
    s.photo         AS foto,
    e.id            AS matriculaId,
    e.status        AS matriculaStatus,
    e.expires_at    AS expiraEm,
    co.id           AS turmaId,
    co.name         AS turmaNome,
    co.category     AS categoria,
    un.id           AS unidadeId,
    un.name         AS unidadeNome,
    p.id            AS planoId,
    p.name          AS planoNome
  FROM students s
  LEFT JOIN enrollments e
    ON e.id = (
      SELECT e2.id
      FROM enrollments e2
      WHERE e2.student_id = s.id
        AND e2.deleted_at IS NULL
      ORDER BY FIELD(e2.status, 'CONFIRMED', 'PAYMENT_PENDDING', 'CREATED', 'CANCELED'),
               e2.created_at DESC
      LIMIT 1
    )
  LEFT JOIN courses co ON co.id = e.course_id
  LEFT JOIN units   un ON un.id = e.unit_id
  LEFT JOIN plans   p  ON p.id  = e.plan_id
  WHERE s.customer_id = :responsavelId
    AND s.deleted_at IS NULL
  ORDER BY s.name
`;

export async function listarAlunosDoResponsavel(responsavelId: number): Promise<AlunoLegado[]> {
  return readOnlyQuery<AlunoLegado>(SQL_ALUNOS_DO_RESPONSAVEL, { responsavelId });
}

// Confere se um aluno pertence mesmo ao responsavel logado. Toda rota que
// recebe um studentId vindo do cliente passa por aqui antes de devolver
// qualquer dado — e o que impede o IDOR que a API atual do Laravel tem.
const SQL_ALUNO_PERTENCE = `
  SELECT COUNT(*) AS total
  FROM students s
  WHERE s.id = :alunoId
    AND s.customer_id = :responsavelId
    AND s.deleted_at IS NULL
`;

export async function alunoPertenceAoResponsavel(
  alunoId: number,
  responsavelId: number,
): Promise<boolean> {
  const linhas = await readOnlyQuery<{ total: number }>(SQL_ALUNO_PERTENCE, {
    alunoId,
    responsavelId,
  });
  return (linhas[0]?.total ?? 0) > 0;
}

export interface PresencaLegado {
  data: string;
  presente: number;
  turmaNome: string | null;
  professorNome: string | null;
}

const SQL_PRESENCAS_DO_ALUNO = `
  SELECT
    a.attendance_date AS data,
    a.has_presence    AS presente,
    co.name           AS turmaNome,
    t.name            AS professorNome
  FROM attendances a
  LEFT JOIN courses  co ON co.id = a.course_id
  LEFT JOIN teachers t  ON t.id  = a.teacher_id
  WHERE a.student_id = :alunoId
    AND a.attendance_date >= :desde
  ORDER BY a.attendance_date DESC
  LIMIT 200
`;

export async function listarPresencasDoAluno(
  alunoId: number,
  desde: Date,
): Promise<PresencaLegado[]> {
  return readOnlyQuery<PresencaLegado>(SQL_PRESENCAS_DO_ALUNO, {
    alunoId,
    desde: desde.toISOString().slice(0, 19).replace("T", " "),
  });
}

export interface ProfessorLegado {
  id: number;
  nome: string;
  usuario: string;
  telefone: string | null;
  ativo: number;
}

const SQL_PROFESSOR_POR_ID = `
  SELECT id, name AS nome, username AS usuario, phone AS telefone, active AS ativo
  FROM teachers
  WHERE id = :id
  LIMIT 1
`;

export async function buscarProfessorPorId(id: number): Promise<ProfessorLegado | null> {
  const linhas = await readOnlyQuery<ProfessorLegado>(SQL_PROFESSOR_POR_ID, { id });
  return linhas[0] ?? null;
}

const SQL_PROFESSORES_ATIVOS = `
  SELECT id, name AS nome, username AS usuario, phone AS telefone, active AS ativo
  FROM teachers
  WHERE active = 1
  ORDER BY name
`;

export async function listarProfessoresAtivos(): Promise<ProfessorLegado[]> {
  return readOnlyQuery<ProfessorLegado>(SQL_PROFESSORES_ATIVOS);
}

export interface TurmaDoProfessor {
  id: number;
  nome: string;
  categoria: string | null;
  unidadeId: number;
  unidadeNome: string;
  matriculados: number;
  vagas: number;
}

// Turmas de um professor, com a ocupacao ja calculada. `amount_students` e a
// capacidade estimada da turma no legado; quando ela nao foi preenchida, vagas
// sai como 0 em vez de negativo.
const SQL_TURMAS_DO_PROFESSOR = `
  SELECT
    co.id   AS id,
    co.name AS nome,
    co.category AS categoria,
    un.id   AS unidadeId,
    un.name AS unidadeNome,
    COUNT(e.id) AS matriculados,
    GREATEST(COALESCE(co.amount_students, 0) - COUNT(e.id), 0) AS vagas
  FROM course_teacher ct
  JOIN courses co ON co.id = ct.course_id
  JOIN units   un ON un.id = co.unit_id
  LEFT JOIN enrollments e
    ON e.course_id = co.id
   AND e.status = 'CONFIRMED'
   AND e.deleted_at IS NULL
  WHERE ct.teacher_id = :professorId
    AND co.active = 1
  GROUP BY co.id, co.name, co.category, un.id, un.name, co.amount_students
  ORDER BY un.name, co.name
`;

export async function listarTurmasDoProfessor(professorId: number): Promise<TurmaDoProfessor[]> {
  return readOnlyQuery<TurmaDoProfessor>(SQL_TURMAS_DO_PROFESSOR, { professorId });
}

export interface OcupacaoUnidade {
  unidadeId: number;
  unidadeNome: string;
  turmas: number;
  matriculados: number;
  capacidade: number;
}

// Substitui o SQL chutado de alunos.repository.ts no se7-inadimplencia. E esta
// consulta que alimenta o snapshot diario de ocupacao por unidade.
const SQL_OCUPACAO_POR_UNIDADE = `
  SELECT
    un.id   AS unidadeId,
    un.name AS unidadeNome,
    (SELECT COUNT(*)
       FROM courses co
      WHERE co.unit_id = un.id AND co.active = 1) AS turmas,
    (SELECT COUNT(*)
       FROM enrollments e
       JOIN courses co ON co.id = e.course_id
      WHERE co.unit_id = un.id
        AND co.active = 1
        AND e.status = 'CONFIRMED'
        AND e.deleted_at IS NULL) AS matriculados,
    (SELECT COALESCE(SUM(co.amount_students), 0)
       FROM courses co
      WHERE co.unit_id = un.id AND co.active = 1) AS capacidade
  FROM units un
  WHERE un.active = 1
  ORDER BY un.name
`;

export async function obterOcupacaoPorUnidade(): Promise<OcupacaoUnidade[]> {
  return readOnlyQuery<OcupacaoUnidade>(SQL_OCUPACAO_POR_UNIDADE);
}

export interface AlunoDaTurma {
  id: number;
  nome: string;
  foto: string | null;
  responsavel: string | null;
}

// Alunos com matrícula confirmada numa turma, em ordem alfabética — a mesma
// ordem em que o professor faz a chamada.
//
// COLLATE utf8mb4_unicode_ci no ORDER BY: sem isso o MySQL ordena por bytes e
// nomes acentuados ("Ávila") caem depois de "Zuleide".
const SQL_ALUNOS_DA_TURMA = `
  SELECT
    s.id   AS id,
    s.name AS nome,
    s.photo AS foto,
    c.name AS responsavel
  FROM enrollments e
  JOIN students s  ON s.id = e.student_id
  LEFT JOIN customers c ON c.id = e.customer_id
  WHERE e.course_id = :turmaId
    AND e.status = 'CONFIRMED'
    AND e.deleted_at IS NULL
    AND s.deleted_at IS NULL
  ORDER BY s.name COLLATE utf8mb4_unicode_ci
`;

export async function listarAlunosDaTurma(turmaId: number): Promise<AlunoDaTurma[]> {
  return readOnlyQuery<AlunoDaTurma>(SQL_ALUNOS_DA_TURMA, { turmaId });
}

// O Laravel recusa uma segunda chamada no mesmo dia para a mesma turma. Saber
// disso ANTES de o professor preencher a lista inteira evita que ele perca o
// trabalho e receba a recusa só no envio.
const SQL_FREQUENCIA_DE_HOJE = `
  SELECT COUNT(*) AS total
  FROM attendances
  WHERE course_id = :turmaId
    AND DATE(attendance_date) = CURDATE()
`;

export async function frequenciaJaLancadaHoje(turmaId: number): Promise<boolean> {
  const linhas = await readOnlyQuery<{ total: number }>(SQL_FREQUENCIA_DE_HOJE, { turmaId });
  return (linhas[0]?.total ?? 0) > 0;
}

const SQL_PROFESSOR_DA_TURMA = `
  SELECT COUNT(*) AS total
  FROM course_teacher
  WHERE course_id = :turmaId AND teacher_id = :professorId
`;

export async function turmaPertenceAoProfessor(
  turmaId: number,
  professorId: number,
): Promise<boolean> {
  const linhas = await readOnlyQuery<{ total: number }>(SQL_PROFESSOR_DA_TURMA, {
    turmaId,
    professorId,
  });
  return (linhas[0]?.total ?? 0) > 0;
}

// O `secret` é o token que o Laravel espera no POST /api/attendances. Ele nunca
// sai do servidor: é lido aqui e usado na chamada de máquina para máquina.
const SQL_SECRET_DO_PROFESSOR = `
  SELECT secret FROM teachers WHERE id = :id AND active = 1 LIMIT 1
`;

export async function obterSecretDoProfessor(id: number): Promise<string | null> {
  const linhas = await readOnlyQuery<{ secret: string | null }>(SQL_SECRET_DO_PROFESSOR, { id });
  return linhas[0]?.secret ?? null;
}

// ---------------------------------------------------------------------------
// Painel do administrativo
// ---------------------------------------------------------------------------

export interface NumerosDaEscola {
  matriculasNoMes: number;
  alunos: number;
  turmas: number;
  planos: number;
  professores: number;
}

// Os mesmos cinco numeros do topo do dashboard do Laravel, para o Hub nao
// contar a escola de um jeito e o sistema atual de outro.
//
// Em 08/09/2026 o dashboard antigo mostrava 18 / 570 / 46 / 43 / 15. E o
// numero de conferencia no dia em que a credencial de leitura sair: se estas
// contas divergirem daquela tela, quem esta errado e esta consulta.
//
// `plans` nao entra filtrada porque a migration nao lhe da `active` nem
// `deleted_at` — se o painel antigo mostrar menos planos que este, e ai que a
// diferenca esta.
const SQL_NUMEROS_DA_ESCOLA = `
  SELECT
    (SELECT COUNT(*) FROM enrollments
      WHERE deleted_at IS NULL
        AND created_at >= :inicioDoMes
        AND created_at <  :inicioDoProximoMes)      AS matriculasNoMes,
    (SELECT COUNT(*) FROM students  WHERE deleted_at IS NULL) AS alunos,
    (SELECT COUNT(*) FROM courses   WHERE active = 1)         AS turmas,
    (SELECT COUNT(*) FROM plans)                              AS planos,
    (SELECT COUNT(*) FROM teachers  WHERE active = 1)         AS professores
`;

export async function obterNumerosDaEscola(
  inicioDoMes: string,
  inicioDoProximoMes: string,
): Promise<NumerosDaEscola> {
  const linhas = await readOnlyQuery<NumerosDaEscola>(SQL_NUMEROS_DA_ESCOLA, {
    inicioDoMes,
    inicioDoProximoMes,
  });
  return (
    linhas[0] ?? { matriculasNoMes: 0, alunos: 0, turmas: 0, planos: 0, professores: 0 }
  );
}

export interface MatriculaRecente {
  id: number;
  aluno: string;
  turma: string | null;
  unidade: string | null;
  plano: string | null;
  status: string;
  criadaEm: Date | string | null;
}

// Ultimas matriculas, na mesma leitura do painel antigo: o administrativo abre o
// sistema para ver o que entrou desde ontem, e principalmente o que entrou e
// ainda nao pagou.
const SQL_MATRICULAS_RECENTES = `
  SELECT
    e.id         AS id,
    s.name       AS aluno,
    co.name      AS turma,
    un.name      AS unidade,
    p.name       AS plano,
    e.status     AS status,
    e.created_at AS criadaEm
  FROM enrollments e
  JOIN students s ON s.id = e.student_id
  LEFT JOIN courses co ON co.id = e.course_id
  LEFT JOIN units   un ON un.id = e.unit_id
  LEFT JOIN plans   p  ON p.id  = e.plan_id
  WHERE e.deleted_at IS NULL
    AND s.deleted_at IS NULL
  ORDER BY e.created_at DESC
  LIMIT :limite
`;

export async function listarMatriculasRecentes(limite: number): Promise<MatriculaRecente[]> {
  return readOnlyQuery<MatriculaRecente>(SQL_MATRICULAS_RECENTES, { limite });
}
