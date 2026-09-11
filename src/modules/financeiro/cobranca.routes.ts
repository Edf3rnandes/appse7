import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MotivoCancelamento, StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { tratadorDeErro } from "../../lib/erros.js";
import { hoje, somarDias } from "../../lib/datas.js";
import { lerConfig } from "../conteudo/conteudo.routes.js";
import {
  AsaasIndisponivelError,
  asaasConfigurado,
  cancelarCobranca,
  criarCliente,
  criarCobranca,
  criarParcelamento,
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
export function proximoVencimento(dia: number): string {
  const agora = new Date();
  const alvo = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), dia));

  if (alvo <= agora) alvo.setUTCMonth(alvo.getUTCMonth() + 1);
  return alvo.toISOString().slice(0, 10);
}

/**
 * O vencimento da taxa de matrícula: 24h a partir de agora, não o dia
 * configurado.
 *
 * O dia fixo é regra da mensalidade recorrente, que segue as condições do
 * plano. A taxa é cobrada avulsa, no ato da matrícula — dar até o próximo dia
 * 10 pra ela dava, num caso real, quase um mês de prazo pra um pagamento
 * único.
 */
export function vencimentoDaTaxa(): string {
  return somarDias(hoje(), 1).toISOString().slice(0, 10);
}

/**
 * Cobrança do tipo pedido, já em aberto, se houver.
 *
 * O Asaas é a fonte da verdade aqui, não o nosso banco: uma cobrança criada
 * e não gravada por uma falha de rede continuaria valendo para a família.
 * Usado tanto pela emissão avulsa quanto pelo parcelamento — os dois
 * geram cobrança descrita como "Mensalidade", então um parcelamento não
 * nasce em cima de uma avulsa esquecida em aberto, nem o contrário.
 */
async function cobrancaEmAberto(matriculaId: string, tipo: "TAXA" | "MENSALIDADE") {
  const jaExistem = await listarCobrancasDaMatricula(matriculaId);
  return jaExistem.find(
    (c) =>
      ["PENDING", "OVERDUE", "AWAITING_RISK_ANALYSIS"].includes(c.status) &&
      (c.description ?? "").startsWith(tipo === "TAXA" ? "Taxa" : "Mensalidade"),
  );
}

/** O responsável precisa existir no Asaas. Criamos na primeira cobrança e guardamos o id — não a cada emissão. */
async function garantirClienteAsaas(matricula: {
  responsavelId: string;
  responsavel: { asaasCustomer: string | null; nome: string; cpf: string; email: string | null; telefone: string | null };
}): Promise<string> {
  if (matricula.responsavel.asaasCustomer) return matricula.responsavel.asaasCustomer;

  const criado = await criarCliente({
    nome: matricula.responsavel.nome,
    cpf: matricula.responsavel.cpf,
    email: matricula.responsavel.email,
    telefone: matricula.responsavel.telefone,
  });
  await prisma.responsavel.update({
    where: { id: matricula.responsavelId },
    data: { asaasCustomer: criado.id },
  });
  return criado.id;
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
        plano: { select: { nome: true, valor: true, descontoPercentual: true, descontoAteDias: true } },
      },
    });
    if (!matricula) return reply.code(404).send({ message: "Matrícula não encontrada." });
    if (matricula.status === StatusMatricula.CANCELADA) {
      return reply.code(409).send({ message: "Matrícula cancelada não recebe cobrança." });
    }

    const emAberto = await cobrancaEmAberto(id, tipo);
    if (emAberto) {
      return reply.code(409).send({
        message: `Já existe uma cobrança de ${tipo === "TAXA" ? "taxa" : "mensalidade"} em aberto, com vencimento em ${emAberto.dueDate}.`,
        cobranca: emAberto,
      });
    }

    const clienteAsaas = await garantirClienteAsaas(matricula);

    const ehTaxa = tipo === "TAXA";
    const cobranca = await criarCobranca({
      clienteAsaas,
      valor: valor ?? (ehTaxa ? config.taxaMatricula : Number(matricula.plano.valor)),
      vencimento: vencimento ?? (ehTaxa ? vencimentoDaTaxa() : proximoVencimento(config.diaVencimento)),
      descricao: ehTaxa
        ? `Taxa de matrícula — ${matricula.aluno.nome} — ${matricula.turma.nome}`
        : `Mensalidade — ${matricula.aluno.nome} — ${matricula.turma.nome} — ${matricula.plano.nome}`,
      referencia: id,
      // O desconto até o vencimento é o que as condições do plano prometem, e
      // vale para a mensalidade; a taxa de matrícula não tem desconto.
      descontoPercentual: ehTaxa ? undefined : matricula.plano.descontoPercentual,
      descontoAteDias: ehTaxa ? undefined : matricula.plano.descontoAteDias,
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

  /**
   * Emite de uma vez todas as parcelas da mensalidade do plano — o
   * parcelamento nativo do Asaas, não N chamadas daqui.
   *
   * `parcelas` vem do plano por padrão, mas é editável na hora: é o que
   * cobre o caso do aluno que entrou depois do dia 10 — lança-se a
   * diferença do mês em "Cobrar mensalidade" (avulsa, valor livre) e aqui só
   * o que sobra do contrato (11 parcelas de um Mensal, 5 de um Semestral),
   * com o vencimento da primeira já no mês seguinte.
   */
  app.post("/financeiro/matriculas/:id/parcelas", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { parcelas, valor, vencimento } = z
      .object({
        parcelas: z.number().int().min(1).max(24).optional(),
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
        plano: { select: { nome: true, valor: true, parcelas: true, descontoPercentual: true, descontoAteDias: true } },
      },
    });
    if (!matricula) return reply.code(404).send({ message: "Matrícula não encontrada." });
    if (matricula.status === StatusMatricula.CANCELADA) {
      return reply.code(409).send({ message: "Matrícula cancelada não recebe cobrança." });
    }

    const emAberto = await cobrancaEmAberto(id, "MENSALIDADE");
    if (emAberto) {
      return reply.code(409).send({
        message: `Já existe uma cobrança de mensalidade em aberto, com vencimento em ${emAberto.dueDate}.`,
        cobranca: emAberto,
      });
    }

    const clienteAsaas = await garantirClienteAsaas(matricula);

    const cobranca = await criarParcelamento({
      clienteAsaas,
      parcelas: parcelas ?? matricula.plano.parcelas,
      valorParcela: valor ?? Number(matricula.plano.valor),
      vencimento: vencimento ?? proximoVencimento(config.diaVencimento),
      descricao: `Mensalidade — ${matricula.aluno.nome} — ${matricula.turma.nome} — ${matricula.plano.nome}`,
      referencia: id,
      descontoPercentual: matricula.plano.descontoPercentual,
      descontoAteDias: matricula.plano.descontoAteDias,
    });

    await prisma.matricula.update({
      where: { id },
      data: {
        asaasPagamento: cobranca.id,
        linkPagamento: cobranca.invoiceUrl,
        ...(matricula.status === StatusMatricula.CRIADA
          ? { status: StatusMatricula.PAGAMENTO_PENDENTE }
          : {}),
      },
    });

    request.log.info(
      { matricula: id, parcelas: parcelas ?? matricula.plano.parcelas },
      "parcelamento emitido no Asaas",
    );

    return reply.code(201).send(cobranca);
  });

  app.get("/financeiro/matriculas/:id/cobrancas", equipe, async (request) => {
    const { id } = idParams.parse(request.params);
    return { cobrancas: await listarCobrancasDaMatricula(id) };
  });

  const cancelarSchema = z.object({
    motivo: z.nativeEnum(MotivoCancelamento),
    motivoDetalhe: z.string().max(1000).optional(),
    // Cobrança já paga nunca entra aqui — só o que ainda pode ser apagado.
    // "Futuras" cobre PENDING e AWAITING_RISK_ANALYSIS; "vencidas" é OVERDUE,
    // e a tela pede confirmação em separado porque apagar uma cobrança
    // vencida é abrir mão de uma dívida que ainda pode ser cobrada.
    apagarFuturas: z.boolean().default(false),
    apagarVencidas: z.boolean().default(false),
  });

  /**
   * Cancela a matrícula com motivo — o único caminho para chegar a
   * CANCELADA (ver o bloqueio no PATCH de /escola/matriculas).
   *
   * Apagar cobrança no Asaas é opcional e best-effort: uma falha ao apagar
   * uma cobrança não pode impedir o cancelamento de valer, senão a família
   * fica presa numa matrícula que já devia ter acabado por causa de uma
   * falha na integração. As falhas voltam na resposta para o administrativo
   * decidir o que fazer — apagar à mão no Asaas, por exemplo.
   */
  app.post("/financeiro/matriculas/:id/cancelar", equipe, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { motivo, motivoDetalhe, apagarFuturas, apagarVencidas } = cancelarSchema.parse(
      request.body,
    );

    const matricula = await prisma.matricula.findUnique({ where: { id } });
    if (!matricula) return reply.code(404).send({ message: "Matrícula não encontrada." });
    if (matricula.status === StatusMatricula.CANCELADA) {
      return reply.code(409).send({ message: "Essa matrícula já está cancelada." });
    }

    let cobrancasApagadas = 0;
    const erros: string[] = [];

    if (apagarFuturas || apagarVencidas) {
      const config = await lerConfig();
      if (!config.emissaoAtiva) {
        erros.push(
          "Emissão pelo Hub está desligada — nenhuma cobrança foi apagada por aqui, confira no Asaas.",
        );
      } else {
        const cobrancas = await listarCobrancasDaMatricula(id);
        const alvo = cobrancas.filter(
          (c) =>
            (apagarFuturas && ["PENDING", "AWAITING_RISK_ANALYSIS"].includes(c.status)) ||
            (apagarVencidas && c.status === "OVERDUE"),
        );

        for (const cobranca of alvo) {
          try {
            await cancelarCobranca(cobranca.id);
            cobrancasApagadas += 1;
          } catch (erro) {
            erros.push(
              `${cobranca.description ?? cobranca.id}: ${erro instanceof Error ? erro.message : "erro desconhecido"}`,
            );
          }
        }
      }
    }

    const cancelada = await prisma.matricula.update({
      where: { id },
      data: {
        status: StatusMatricula.CANCELADA,
        canceladaEm: new Date(),
        motivoCancelamento: motivo,
        motivoCancelamentoDetalhe: motivoDetalhe ?? null,
      },
    });

    request.log.info({ matricula: id, motivo, cobrancasApagadas }, "matrícula cancelada");

    return { matricula: cancelada, cobrancasApagadas, erros };
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
