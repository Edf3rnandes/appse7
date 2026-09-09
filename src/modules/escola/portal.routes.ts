import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LegadoIndisponivelError } from "../../db/legacy/pool.js";
import {
  alunoPertenceAoResponsavel,
  listarAlunosDoResponsavel,
  listarPresencasDoAluno,
  listarProfessoresAtivos,
  obterOcupacaoPorUnidade,
} from "../../db/legacy/escola.repository.js";
import { readOnlyQuery } from "../../db/legacy/pool.js";
import { AsaasIndisponivelError, asaasConfigurado, listarFaturasDoCliente } from "../../services/asaas/asaas.client.js";
import { mascararCpf } from "../../lib/cpf.js";
import { tratadorDeErro } from "../../lib/erros.js";

const alunoParams = z.object({ id: z.coerce.number().int().positive() });

// Todo dado do responsavel sai daqui a partir do `responsavelId` do TOKEN.
// Nenhuma rota deste arquivo aceita CPF, customer_id ou student_id como
// criterio de busca vindo do cliente — student_id so entra depois de passar
// pela checagem de posse. E o que fecha o IDOR que a API atual tem.
export async function portalRoutes(app: FastifyInstance) {
  app.setErrorHandler(
    tratadorDeErro((erro) => {
      // O legado e o Asaas são dependências externas: quando caem, o portal
      // responde 503 com texto entendível em vez de 500 genérico.
      if (erro instanceof LegadoIndisponivelError) {
        return { status: 503, mensagem: "Cadastro indisponivel no momento." };
      }
      if (erro instanceof AsaasIndisponivelError) {
        return { status: 503, mensagem: "Financeiro indisponivel no momento." };
      }
      return undefined;
    }),
  );

  app.get("/portal/alunos", { preHandler: [app.exigirResponsavel] }, async (request) => {
    const alunos = await listarAlunosDoResponsavel(request.user.responsavelId!);
    return alunos.map((a) => ({
      id: a.id,
      nome: a.nome,
      nascimento: a.nascimento,
      matricula: a.matriculaId
        ? {
            id: a.matriculaId,
            status: a.matriculaStatus,
            expiraEm: a.expiraEm,
            turma: a.turmaNome,
            categoria: a.categoria,
            unidade: a.unidadeNome,
            plano: a.planoNome,
          }
        : null,
    }));
  });

  app.get(
    "/portal/alunos/:id/frequencia",
    { preHandler: [app.exigirResponsavel] },
    async (request, reply) => {
      const { id } = alunoParams.parse(request.params);

      const pertence = await alunoPertenceAoResponsavel(id, request.user.responsavelId!);
      if (!pertence) {
        // 404 e nao 403: nao confirmamos nem que o aluno existe.
        return reply.code(404).send({ message: "Aluno nao encontrado." });
      }

      const desde = new Date();
      desde.setMonth(desde.getMonth() - 6);

      const presencas = await listarPresencasDoAluno(id, desde);
      const total = presencas.length;
      const presentes = presencas.filter((p) => Number(p.presente) === 1).length;

      return {
        resumo: {
          aulas: total,
          presencas: presentes,
          faltas: total - presentes,
          percentual: total > 0 ? Math.round((presentes / total) * 100) : null,
        },
        registros: presencas.map((p) => ({
          data: p.data,
          presente: Number(p.presente) === 1,
          turma: p.turmaNome,
          professor: p.professorNome,
        })),
      };
    },
  );

  app.get("/portal/faturas", { preHandler: [app.exigirResponsavel] }, async (request, reply) => {
    if (!asaasConfigurado) {
      return reply.code(503).send({ message: "Financeiro nao configurado." });
    }

    // O id do cliente no Asaas e resolvido aqui, no servidor, pelo vinculo do
    // token — nunca aceito como parametro.
    const linhas = await readOnlyQuery<{ asaasCustomer: string | null }>(
      `SELECT asaas_customer AS asaasCustomer FROM customers WHERE id = :id LIMIT 1`,
      { id: request.user.responsavelId! },
    );

    const asaasCustomer = linhas[0]?.asaasCustomer;
    if (!asaasCustomer) {
      return { faturas: [], aviso: "Cadastro ainda sem financeiro vinculado." };
    }

    const faturas = await listarFaturasDoCliente(asaasCustomer);

    return {
      faturas: faturas.map((f) => ({
        id: f.id,
        status: f.status,
        valor: f.value,
        vencimento: f.dueDate,
        descricao: f.description,
        pagoEm: f.paymentDate,
        // Links de 2a via vem prontos do Asaas; nao montamos URL na mao.
        linkFatura: f.invoiceUrl,
        linkBoleto: f.bankSlipUrl,
      })),
    };
  });

  app.get("/portal/perfil", { preHandler: [app.exigirResponsavel] }, async (request) => {
    const linhas = await readOnlyQuery<{
      id: number;
      nome: string;
      email: string | null;
      telefone: string | null;
      cpf: string;
      cep: string | null;
      logradouro: string | null;
      numero: string | null;
      complemento: string | null;
      bairro: string | null;
      cidade: string | null;
      estado: string | null;
    }>(
      `SELECT id, name AS nome, email, phone AS telefone, cpf,
              address_zipcode AS cep, street_name AS logradouro,
              address_number AS numero, address_complement AS complemento,
              neighborhood_name AS bairro, city_name AS cidade, state_name AS estado
         FROM customers WHERE id = :id LIMIT 1`,
      { id: request.user.responsavelId! },
    );

    const c = linhas[0];
    if (!c) return { encontrado: false };

    return {
      encontrado: true,
      nome: c.nome,
      email: c.email,
      telefone: c.telefone,
      // O CPF volta mascarado: o portal nao precisa do numero inteiro para
      // nada, e ele ja e o segredo que faz o vinculo.
      cpf: mascararCpf(c.cpf),
      endereco: {
        cep: c.cep,
        logradouro: c.logradouro,
        numero: c.numero,
        complemento: c.complemento,
        bairro: c.bairro,
        cidade: c.cidade,
        estado: c.estado,
        completo: Boolean(c.cep && c.logradouro && c.numero && c.bairro && c.cidade),
      },
    };
  });

  // Alimenta o campo de professor no convite: sem isso a secretaria teria de
  // saber de cabeça o id do professor no sistema antigo.
  app.get(
    "/escola/professores",
    { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] },
    async () => listarProfessoresAtivos(),
  );

  app.get(
    "/escola/ocupacao",
    { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] },
    async () => obterOcupacaoPorUnidade(),
  );
}
