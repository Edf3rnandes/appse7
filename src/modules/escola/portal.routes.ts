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
import { lerConfig } from "../conteudo/conteudo.routes.js";

const alunoParams = z.object({ id: z.string().uuid() });

// Mesmo limite e mesma checagem das outras imagens do sistema.
const LIMITE_IMAGEM = 1_500_000;

const imagemDataUrl = z
  .string()
  .refine((v) => /^data:image\/(jpeg|png|webp);base64,/.test(v), "Formato de imagem não aceito.")
  .refine((v) => v.length <= LIMITE_IMAGEM, "A imagem ficou grande demais. Use uma menor.");

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
      // `select` em vez de `include`: a foto grande não tem o que fazer numa
      // lista, e o responsável costuma abrir isto na rede móvel.
      select: {
        id: true,
        nome: true,
        nascimento: true,
        fotoMiniatura: true,
        matriculas: {
          where: { arquivadoEm: null },
          // A matrícula que vale primeiro; entre as de mesmo status, a mais
          // recente. Sem esta ordem o portal mostraria uma matrícula
          // cancelada de 2024 no lugar da confirmada de agora.
          orderBy: [{ status: "asc" }, { criadoEm: "desc" }],
          take: 1,
          select: {
            id: true,
            status: true,
            expiraEm: true,
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
        fotoMiniatura: a.fotoMiniatura,
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

  /**
   * O responsável manda a foto do próprio filho.
   *
   * É o que resolve as fotos de verdade. O administrativo não tem foto de 570
   * alunos e não vai fotografar um por um na quadra; o pai tem dezenas no
   * celular e leva quinze segundos para escolher uma. Espalhar o trabalho por
   * quem já tem o material é a diferença entre a chamada com rosto existir e
   * não existir.
   *
   * A posse é conferida aqui, como em toda rota deste arquivo: o id do aluno
   * vem do navegador e não vale nada até casar com o vínculo do token.
   */
  app.put(
    "/portal/alunos/:id/foto",
    { preHandler: [app.exigirResponsavel] },
    async (request, reply) => {
      const { id } = alunoParams.parse(request.params);
      const { foto, miniatura } = z
        .object({ foto: imagemDataUrl, miniatura: imagemDataUrl })
        .parse(request.body);

      const aluno = await prisma.aluno.findFirst({
        where: { id, responsavelId: request.user.responsavelId!, arquivadoEm: null },
        select: { id: true },
      });
      // 404 e não 403: não confirmamos nem que o aluno existe.
      if (!aluno) return reply.code(404).send({ message: "Aluno nao encontrado." });

      await prisma.aluno.update({
        where: { id },
        data: { foto, fotoMiniatura: miniatura },
      });

      return { fotoMiniatura: miniatura };
    },
  );

  app.delete(
    "/portal/alunos/:id/foto",
    { preHandler: [app.exigirResponsavel] },
    async (request, reply) => {
      const { id } = alunoParams.parse(request.params);

      const aluno = await prisma.aluno.findFirst({
        where: { id, responsavelId: request.user.responsavelId!, arquivadoEm: null },
        select: { id: true },
      });
      if (!aluno) return reply.code(404).send({ message: "Aluno nao encontrado." });

      await prisma.aluno.update({ where: { id }, data: { foto: null, fotoMiniatura: null } });
      return reply.code(204).send();
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
      // Bolsista nunca chega a ter cliente no Asaas — não existe cobrança
      // pra criar cliente nenhum. Sem isso, a aba de Faturas de uma família
      // bolsista mostra o mesmo aviso genérico de "financeiro não
      // vinculado", que parece cadastro incompleto, não uma escolha.
      const matriculas = await prisma.matricula.findMany({
        where: {
          responsavelId: request.user.responsavelId!,
          arquivadoEm: null,
          status: { not: StatusMatricula.CANCELADA },
        },
        select: { bolsista: true },
      });
      const soBolsista = matriculas.length > 0 && matriculas.every((m) => m.bolsista);

      return {
        faturas: [],
        aviso: soBolsista
          ? "Aluno bolsista — não há cobrança de mensalidade."
          : "Cadastro ainda sem financeiro vinculado.",
      };
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

  /**
   * O responsável corrige o próprio endereço.
   *
   * Existe pelo mesmo motivo da foto: o administrativo não vai digitar o endereço
   * de 570 famílias, e a base que vem do Laravel tem essas colunas quase todas
   * vazias — nenhuma tela de lá as preenchia. Quem sabe o endereço é quem mora
   * nele, e para ele é um formulário de trinta segundos.
   *
   * Mexe SÓ no endereço. Nome, CPF, e-mail e telefone são o que identifica a
   * pessoa e para onde vai a cobrança; mudar isso é decisão do administrativo, não
   * de quem está logado.
   */
  app.put("/portal/endereco", { preHandler: [app.exigirResponsavel] }, async (request) => {
    const dados = z
      .object({
        cep: z
          .string()
          .transform((v) => v.replace(/\D/g, ""))
          .refine((v) => v.length === 8, "CEP precisa ter 8 dígitos."),
        logradouro: z.string().min(3, "Informe a rua.").max(200),
        numero: z.string().min(1, "Informe o número.").max(20),
        complemento: z.string().max(120).optional().or(z.literal("")),
        bairro: z.string().min(2, "Informe o bairro.").max(120),
        cidade: z.string().min(2, "Informe a cidade.").max(120),
        estado: z
          .string()
          .transform((v) => v.trim().toUpperCase())
          .refine((v) => /^[A-Z]{2}$/.test(v), "Estado em duas letras, como PB."),
      })
      .parse(request.body);

    await prisma.responsavel.update({
      where: { id: request.user.responsavelId! },
      data: { ...dados, complemento: dados.complemento || null },
    });

    return { ...dados, completo: true };
  });

  /**
   * O contrato que a família assinou na matrícula — pra poder reler quando
   * quiser, não só no minuto de assinar. Mesmo texto que a Diretoria edita em
   * Administrativo → Configurações → Cobrança, sem cadastro nenhum aqui: é
   * um documento da escola, não um por família.
   */
  app.get("/portal/contrato", { preHandler: [app.exigirResponsavel] }, async () => {
    const config = await lerConfig();
    return { texto: config.contratoTexto, linkTermos: config.linkTermos };
  });

  // Ocupação por unidade: quantas vagas a escola ainda tem, por onde. A
  // capacidade agora é um inteiro na turma, então a conta sai direto — no
  // sistema antigo ela era texto e ninguém conseguia somar.
  app.get(
    "/escola/ocupacao",
    { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] },
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
