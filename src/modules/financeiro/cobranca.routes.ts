import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { tratadorDeErro } from "../../lib/erros.js";
import { lerConfig } from "../conteudo/conteudo.routes.js";
import {
  AsaasIndisponivelError,
  asaasConfigurado,
  criarCliente,
  criarCobranca,
  listarCobrancasDaMatricula,
  listarVencidas,
} from "../../services/asaas/asaas.client.js";

/**
 * Cobrança no Asaas.
 *
 * TUDO aqui nasce desligado. A chave `asaas.emissaoAtiva` começa em falso e só
 * o ADMIN a liga, porque enquanto o Laravel continuar no ar dois sistemas
 * emitindo na mesma conta geram duas cobranças para o mesmo pai — e quem
 * recebe não tem como saber qual pagar.
 *
 * Ler é diferente de emitir. Consultar faturas e vencidas é inofensivo e
 * depende só da chave de API; por isso a tela de cobranças vencidas funciona
 * antes da virada, mostrando o que o sistema atual já cobrou. O que a chave
 * governa é a criação.
 */

export class EmissaoDesligadaError extends Error {
  constructor() {
    super(
      "A emissão de cobrança pelo sistema novo está desligada. " +
        "Enquanto os dois sistemas estiverem no ar, quem emite é o atual.",
    );
  }
}

const idParams = z.object({ id: z.string().uuid() });

/**
 * O vencimento da próxima cobrança: o dia configurado, no mês que vem.
 *
 * As condições dos planos dizem "DATA DE VENCIMENTO: Dia 10". Se hoje já
 * passou do dia 10, cobrar no dia 10 deste mês seria emitir algo já vencido.
 */
function proximoVencimento(dia: number): string {
  const hoje = new Date();
  const alvo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), dia));

  if (alvo <= hoje) alvo.setUTCMonth(alvo.getUTCMonth() + 1);
  return alvo.toISOString().slice(0, 10);
}

export async function cobrancaRoutes(app: FastifyInstance) {
  const equipe = { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] };

  app.setErrorHandler(
    tratadorDeErro((erro) => {
      if (erro instanceof EmissaoDesligadaError) return { status: 409, mensagem: erro.message };
      if (erro instanceof AsaasIndisponivelError) return { status: 503, mensagem: erro.message };
      return undefined;
    }),
  );

  /** O estado da integração, para a tela saber o que mostrar e o que esconder. */
  app.get("/financeiro/estado", equipe, async () => {
    const config = await lerConfig();
    return {
      chaveConfigurada: asaasConfigurado,
      emissaoAtiva: config.emissaoAtiva,
      diaVencimento: config.diaVencimento,
      taxaMatricula: config.taxaMatricula,
    };
  });

  /**
   * Emite uma cobrança para a matrícula.
   *
   * Dois guardas antes de tocar no Asaas, porque cobrança duplicada é dinheiro
   * cobrado duas vezes de uma família:
   *
   *   1. A emissão precisa estar ligada.
   *   2. A matrícula não pode já ter cobrança do mesmo tipo em aberto. O
   *      `externalReference` que gravamos na cobrança é o que permite
   *      perguntar isso ao Asaas antes de criar outra.
   */
  app.post("/financeiro/matriculas/:id/cobranca", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { tipo, valor, vencimento } = z
      .object({
        tipo: z.enum(["TAXA", "MENSALIDADE"]),
        // Vazios usam o valor do plano e o dia configurado. Informar serve
        // para os casos combinados no balcão — desconto, entrada diferente.
        valor: z.number().positive().optional(),
        vencimento: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
          .optional(),
      })
      .parse(request.body);

    const config = await lerConfig();
    if (!config.emissaoAtiva) throw new EmissaoDesligadaError();

    const matricula = await prisma.matricula.findUnique({
      where: { id },
      include: {
        aluno: { select: { nome: true } },
        responsavel: true,
        turma: { select: { nome: true } },
        plano: { select: { nome: true, valor: true, descontoPercentual: true } },
      },
    });
    if (!matricula) return reply.code(404).send({ message: "Matrícula não encontrada." });
    if (matricula.status === StatusMatricula.CANCELADA) {
      return reply.code(409).send({ message: "Matrícula cancelada não recebe cobrança." });
    }

    // Cobrança em aberto do mesmo tipo já existe? O Asaas é a fonte da
    // verdade aqui, não o nosso banco: uma cobrança criada e não gravada por
    // uma falha de rede continuaria valendo para a família.
    const jaExistem = await listarCobrancasDaMatricula(id);
    const emAberto = jaExistem.find(
      (c) =>
        ["PENDING", "OVERDUE", "AWAITING_RISK_ANALYSIS"].includes(c.status) &&
        (c.description ?? "").startsWith(tipo === "TAXA" ? "Taxa" : "Mensalidade"),
    );
    if (emAberto) {
      return reply.code(409).send({
        message: `Já existe uma cobrança de ${tipo === "TAXA" ? "taxa" : "mensalidade"} em aberto, com vencimento em ${emAberto.dueDate}.`,
        cobranca: emAberto,
      });
    }

    // O responsável precisa existir no Asaas. Criamos na primeira cobrança e
    // guardamos o id — não a cada emissão.
    let clienteAsaas = matricula.responsavel.asaasCustomer;
    if (!clienteAsaas) {
      const criado = await criarCliente({
        nome: matricula.responsavel.nome,
        cpf: matricula.responsavel.cpf,
        email: matricula.responsavel.email,
        telefone: matricula.responsavel.telefone,
      });
      clienteAsaas = criado.id;
      await prisma.responsavel.update({
        where: { id: matricula.responsavelId },
        data: { asaasCustomer: clienteAsaas },
      });
    }

    const ehTaxa = tipo === "TAXA";
    const cobranca = await criarCobranca({
      clienteAsaas,
      valor: valor ?? (ehTaxa ? config.taxaMatricula : Number(matricula.plano.valor)),
      vencimento: vencimento ?? proximoVencimento(config.diaVencimento),
      descricao: ehTaxa
        ? `Taxa de matrícula — ${matricula.aluno.nome} — ${matricula.turma.nome}`
        : `Mensalidade — ${matricula.aluno.nome} — ${matricula.turma.nome} — ${matricula.plano.nome}`,
      referencia: id,
      // O desconto até o vencimento é o que as condições do plano prometem, e
      // vale para a mensalidade; a taxa de matrícula não tem desconto.
      descontoPercentual: ehTaxa ? undefined : matricula.plano.descontoPercentual,
    });

    await prisma.matricula.update({
      where: { id },
      data: {
        asaasPagamento: cobranca.id,
        linkPagamento: cobranca.invoiceUrl,
        // Emitida a cobrança, a matrícula deixa de ser "criada" e passa a
        // esperar o pagamento — que é o que o administrativo vê na tela.
        ...(matricula.status === StatusMatricula.CRIADA
          ? { status: StatusMatricula.PAGAMENTO_PENDENTE }
          : {}),
      },
    });

    request.log.info({ matricula: id, tipo }, "cobrança emitida no Asaas");

    return reply.code(201).send(cobranca);
  });

  app.get("/financeiro/matriculas/:id/cobrancas", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    return { cobrancas: await listarCobrancasDaMatricula(id) };
  });

  /**
   * Cobranças vencidas — a tela de Financeiro.
   *
   * Só lê, então funciona antes da virada: mostra o que o sistema atual já
   * cobrou, porque a conta do Asaas é a mesma. Cruzamos com o cadastro daqui
   * pelo `externalReference` quando a cobrança saiu do Hub, e pelo id do
   * cliente quando ela veio do Laravel.
   */
  app.get("/financeiro/vencidas", equipe, async () => {
    const vencidas = await listarVencidas();

    const responsaveis = await prisma.responsavel.findMany({
      where: { asaasCustomer: { in: vencidas.map((c) => c.customer) } },
      select: { id: true, nome: true, telefone: true, asaasCustomer: true },
    });

    const porCliente = new Map(responsaveis.map((r) => [r.asaasCustomer!, r]));
    const hoje = new Date();

    return {
      total: vencidas.length,
      soma: vencidas.reduce((s, c) => s + c.value, 0),
      itens: vencidas.map((c) => {
        const responsavel = porCliente.get(c.customer) ?? null;
        return {
          id: c.id,
          valor: c.value,
          vencimento: c.dueDate,
          descricao: c.description,
          link: c.invoiceUrl,
          diasVencida: Math.round(
            (hoje.getTime() - new Date(`${c.dueDate}T00:00:00Z`).getTime()) / 86400000,
          ),
          // Nem toda cobrança vencida tem responsável no Hub ainda: as do
          // Laravel só terão depois da importação dos alunos.
          responsavel: responsavel && {
            id: responsavel.id,
            nome: responsavel.nome,
            telefone: responsavel.telefone,
          },
        };
      }),
    };
  });
}
