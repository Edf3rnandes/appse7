import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  AsaasIndisponivelError,
  asaasConfigurado,
  listarFaturasDoCliente,
} from "../../services/asaas/asaas.client.js";
import { mascararCpf } from "../../lib/cpf.js";
import { tratadorDeErro } from "../../lib/erros.js";

const alunoParams = z.object({ id: z.string().uuid() });

// Todo dado do responsavel sai daqui a partir do `responsavelId` do TOKEN.
// Nenhuma rota deste arquivo aceita CPF ou id de responsavel como criterio de
// busca vindo do cliente — o id do aluno so entra depois de passar pela
// checagem de posse. E o que fecha o IDOR que a API do sistema antigo tem:
// la, /api/courses/{id}/students devolve nome e foto de aluno para qualquer um.
export async function portalRoutes(app: FastifyInstance) {
  app.setErrorHandler(
    tratadorDeErro((erro) =>
      erro instanceof AsaasIndisponivelError
        ? { status: 503, mensagem: "Financeiro indisponivel no momento." }
        : undefined,
    ),
  );

  app.get("/portal/alunos", { preHandler: [app.exigirResponsavel] }, async (request) => {
    const alunos = await prisma.aluno.findMany({
      where: { responsavelId: request.user.responsavelId!, arquivadoEm: null },
      orderBy: { nome: "asc" },
      include: {
        matriculas: {
          where: { arquivadoEm: null },
          // A matrícula que vale primeiro; entre as de mesmo status, a mais
          // recente. Sem esta ordem o portal mostraria uma matrícula
          // cancelada de 2024 no lugar da confirmada de agora.
          orderBy: [{ status: "asc" }, { criadoEm: "desc" }],
          take: 1,
          include: {
            turma: { select: { nome: true, categoria: true } },
            unidade: { select: { nome: true } },
            plano: { select: { nome: true } },
          },
        },
      },
    });

    return alunos.map((a) => {
      const m = a.matriculas[0];
      return {
        id: a.id,
        nome: a.nome,
        nascimento: a.nascimento,
        matricula: m
          ? {
              id: m.id,
              status: m.status,
              expiraEm: m.expiraEm,
              turma: m.turma.nome,
              categoria: m.turma.categoria,
              unidade: m.unidade.nome,
              plano: m.plano.nome,
            }
          : null,
      };
    });
  });

  app.get(
    "/portal/alunos/:id/frequencia",
    { preHandler: [app.exigirResponsavel] },
    async (request, reply) => {
      const { id } = alunoParams.parse(request.params);

      const aluno = await prisma.aluno.findFirst({
        where: { id, responsavelId: request.user.responsavelId!, arquivadoEm: null },
      });
      // 404 e nao 403: nao confirmamos nem que o aluno existe.
      if (!aluno) return reply.code(404).send({ message: "Aluno nao encontrado." });

      const desde = new Date();
      desde.setMonth(desde.getMonth() - 6);

      const registros = await prisma.presenca.findMany({
        where: { alunoId: id, data: { gte: desde } },
        orderBy: { data: "desc" },
        include: {
          turma: { select: { nome: true } },
          professor: { select: { nome: true } },
        },
      });

      const presentes = registros.filter((p) => p.presente).length;

      return {
        resumo: {
          aulas: registros.length,
          presencas: presentes,
          faltas: registros.length - presentes,
          percentual: registros.length > 0 ? Math.round((presentes / registros.length) * 100) : null,
        },
        registros: registros.map((p) => ({
          data: p.data,
          presente: p.presente,
          turma: p.turma.nome,
          professor: p.professor.nome,
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
    const responsavel = await prisma.responsavel.findUnique({
      where: { id: request.user.responsavelId! },
      select: { asaasCustomer: true },
    });

    if (!responsavel?.asaasCustomer) {
      return { faturas: [], aviso: "Cadastro ainda sem financeiro vinculado." };
    }

    const faturas = await listarFaturasDoCliente(responsavel.asaasCustomer);

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
    const c = await prisma.responsavel.findUnique({
      where: { id: request.user.responsavelId! },
    });

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

  // Ocupação por unidade: quantas vagas a escola ainda tem, por onde. A
  // capacidade agora é um inteiro na turma, então a conta sai direto — no
  // sistema antigo ela era texto e ninguém conseguia somar.
  app.get(
    "/escola/ocupacao",
    { preHandler: [app.exigirPapel("ADMIN", "SECRETARIA")] },
    async () => {
      const unidades = await prisma.unidade.findMany({
        where: { ativa: true },
        orderBy: { nome: "asc" },
        include: {
          turmas: {
            where: { ativa: true },
            select: {
              capacidade: true,
              _count: {
                select: {
                  matriculas: { where: { status: StatusMatricula.CONFIRMADA, arquivadoEm: null } },
                },
              },
            },
          },
        },
      });

      return unidades.map((u) => ({
        unidadeId: u.id,
        unidadeNome: u.nome,
        turmas: u.turmas.length,
        matriculados: u.turmas.reduce((soma, t) => soma + t._count.matriculas, 0),
        capacidade: u.turmas.reduce((soma, t) => soma + (t.capacidade ?? 0), 0),
      }));
    },
  );
}
