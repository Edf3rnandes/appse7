import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { tratadorDeErro } from "../../lib/erros.js";
import {
  asaasConfigurado,
  AsaasIndisponivelError,
  listarRecebidas,
  listarVencidas,
} from "../../services/asaas/asaas.client.js";

/**
 * A área dos sócios.
 *
 * Não é a tela do administrativo com outro nome. O administrativo pergunta
 * "quem falta confirmar hoje"; o sócio pergunta "a escola cresceu ou encolheu
 * este mês, e onde". São recortes diferentes dos mesmos dados.
 *
 * Nada aqui escreve na escola. As rotas de sócio só leem matrícula, plano e
 * turma — o único lugar em que este módulo grava é no cadastro da sociedade,
 * que é dele.
 *
 * SOBRE OS NÚMEROS DO PASSADO, e isto importa antes de alguém tomar decisão
 * com eles: a série mês a mês é RECONSTRUÍDA a partir das datas de cada
 * matrícula (criação, cancelamento, expiração), não lida de um fechamento
 * mensal — que não existe, nem aqui nem no sistema atual. Duas consequências
 * honestas:
 *
 *   1. A receita de um mês passado usa o preço de HOJE do plano. Se um plano
 *      subir de R$ 112 para R$ 130, a série inteira sobe junto. O sistema
 *      atual não guarda histórico de preço, então não há de onde tirar o
 *      valor da época.
 *   2. `status` não tem histórico. Uma matrícula hoje CONFIRMADA conta como
 *      ativa desde que foi criada, mesmo que tenha levado duas semanas para
 *      ser confirmada.
 *
 * As duas coisas afetam meses passados, nunca o mês corrente. A tela diz isso
 * em vez de esconder, porque um número que parece exato e não é vale menos
 * que um número aproximado com a régua à vista.
 */

/** Primeiro dia do mês, em UTC. */
function inicioDoMes(ano: number, mes: number) {
  return new Date(Date.UTC(ano, mes, 1));
}

/** Último instante do mês. */
function fimDoMes(ano: number, mes: number) {
  return new Date(Date.UTC(ano, mes + 1, 1) - 1);
}

const comoDia = (d: Date) => d.toISOString().slice(0, 10);

/** Os N meses até o atual, do mais antigo para o mais novo. */
export function ultimosMeses(quantidade: number) {
  const hoje = new Date();
  const meses = [];

  for (let i = quantidade - 1; i >= 0; i--) {
    const referencia = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1));
    const ano = referencia.getUTCFullYear();
    const mes = referencia.getUTCMonth();
    meses.push({
      chave: `${ano}-${String(mes + 1).padStart(2, "0")}`,
      inicio: inicioDoMes(ano, mes),
      fim: fimDoMes(ano, mes),
      corrente: i === 0,
    });
  }

  return meses;
}

/** Matrícula como ela chega da consulta, com só o que a conta usa. */
export interface MatriculaParaConta {
  status: StatusMatricula;
  criadoEm: Date;
  canceladaEm: Date | null;
  arquivadoEm: Date | null;
  expiraEm: Date | null;
  atualizadoEm: Date;
  unidade: { id: string; nome: string };
  plano: { valor: unknown };
}

/**
 * Quando a matrícula deixou de valer.
 *
 * `canceladaEm` é a resposta certa. Quando ela falta — matrícula que consta
 * como CANCELADA sem data, o que a importação do Laravel vai produzir, porque
 * lá o cancelamento apagava a linha — sobra `arquivadoEm` e depois
 * `atualizadoEm`. Adivinhar a data errada é ruim; contar como ativa para
 * sempre uma matrícula cancelada seria pior.
 */
export function saidaDe(m: MatriculaParaConta): Date | null {
  if (m.canceladaEm) return m.canceladaEm;
  if (m.arquivadoEm) return m.arquivadoEm;
  if (m.status === StatusMatricula.CANCELADA) return m.atualizadoEm;
  return null;
}

const paraNumero = (v: unknown) => Number(v ?? 0);

export function ativaEm(m: MatriculaParaConta, fim: Date, inicio: Date) {
  if (m.criadoEm > fim) return false;

  const saida = saidaDe(m);
  if (saida && saida <= fim) return false;

  // Matrícula vencida não gera mensalidade. `expiraEm` é o fim do plano
  // contratado; depois dele a família renova ou some.
  if (m.expiraEm && m.expiraEm < inicio) return false;

  // CRIADA é pedido esperando o administrativo: não é receita ainda.
  return m.status === StatusMatricula.CONFIRMADA || m.status === StatusMatricula.PAGAMENTO_PENDENTE;
}

export async function sociosRoutes(app: FastifyInstance) {
  app.setErrorHandler(
    tratadorDeErro((erro) => {
      if (erro instanceof AsaasIndisponivelError) return { status: 503, mensagem: erro.message };
      return undefined;
    }),
  );

  // SOCIO só. ADMIN não entra: o painel mostra distribuição de lucro entre
  // pessoas, que não é assunto de quem administra a escola no dia a dia.
  // O caminho contrário — sócio fazendo tudo o que admin faz — está resolvido
  // em papeisEfetivos(), no plugin de acesso.
  const somenteSocios = { preHandler: [app.exigirPapel("SOCIO")] };

  /**
   * O painel gerencial.
   *
   * Uma consulta só na escola, e as contas em memória. A alternativa seria uma
   * consulta por mês — doze idas ao banco para desenhar uma tela — e o volume
   * aqui não justifica: são centenas de matrículas, não milhões.
   */
  app.get("/socios/painel", somenteSocios, async (request) => {
    const { meses } = z
      .object({ meses: z.coerce.number().int().min(3).max(24).default(6) })
      .parse(request.query);

    const janela = ultimosMeses(meses);
    const mesCorrente = janela[janela.length - 1];

    const matriculas = (await prisma.matricula.findMany({
      select: {
        status: true,
        criadoEm: true,
        canceladaEm: true,
        arquivadoEm: true,
        expiraEm: true,
        atualizadoEm: true,
        unidade: { select: { id: true, nome: true } },
        plano: { select: { valor: true } },
      },
    })) as MatriculaParaConta[];

    const serie = janela.map((mes) => {
      const ativas = matriculas.filter((m) => ativaEm(m, mes.fim, mes.inicio));
      const receita = ativas.reduce((s, m) => s + paraNumero(m.plano.valor), 0);

      const novas = matriculas.filter(
        (m) =>
          m.criadoEm >= mes.inicio &&
          m.criadoEm <= mes.fim &&
          m.status !== StatusMatricula.CRIADA,
      ).length;

      const saidas = matriculas.filter((m) => {
        const saida = saidaDe(m);
        return saida !== null && saida >= mes.inicio && saida <= mes.fim;
      }).length;

      return {
        mes: mes.chave,
        corrente: mes.corrente,
        ativas: ativas.length,
        receitaPrevista: Number(receita.toFixed(2)),
        ticketMedio: ativas.length ? Number((receita / ativas.length).toFixed(2)) : 0,
        novas,
        saidas,
        saldo: novas - saidas,
      };
    });

    // Ocupação e receita por unidade, no mês corrente. É onde o sócio vê
    // vaga ociosa — cadeira vazia numa turma que já tem professor pago.
    const unidades = await prisma.unidade.findMany({
      where: { ativa: true },
      orderBy: { nome: "asc" },
      select: {
        id: true,
        nome: true,
        turmas: { where: { ativa: true }, select: { capacidade: true } },
      },
    });

    const porUnidade = unidades.map((u) => {
      const ativas = matriculas.filter(
        (m) => m.unidade.id === u.id && ativaEm(m, mesCorrente.fim, mesCorrente.inicio),
      );
      const receita = ativas.reduce((s, m) => s + paraNumero(m.plano.valor), 0);
      const capacidade = u.turmas.reduce((s, t) => s + (t.capacidade ?? 0), 0);

      return {
        unidadeId: u.id,
        unidade: u.nome,
        turmas: u.turmas.length,
        ativas: ativas.length,
        capacidade,
        vagasOciosas: Math.max(0, capacidade - ativas.length),
        receitaPrevista: Number(receita.toFixed(2)),
        // Quanto essas cadeiras vazias valeriam pelo ticket da própria
        // unidade. Não é receita perdida garantida — é o tamanho do assunto.
        potencialOcioso: ativas.length
          ? Number((((receita / ativas.length) * (capacidade - ativas.length)) || 0).toFixed(2))
          : 0,
      };
    });

    return {
      geradoEm: new Date().toISOString(),
      // A tela precisa saber para escrever a ressalva do jeito certo, e não
      // como letra miúda genérica.
      reconstruido: {
        serie: true,
        nota:
          "Meses anteriores são reconstruídos das datas de cada matrícula e usam o preço atual do plano. " +
          "O mês corrente é exato.",
      },
      serie,
      porUnidade,
      totais: {
        ativas: serie[serie.length - 1].ativas,
        receitaPrevista: serie[serie.length - 1].receitaPrevista,
        ticketMedio: serie[serie.length - 1].ticketMedio,
        vagasOciosas: porUnidade.reduce((s, u) => s + u.vagasOciosas, 0),
        potencialOcioso: Number(
          porUnidade.reduce((s, u) => s + u.potencialOcioso, 0).toFixed(2),
        ),
      },
    };
  });

  /**
   * O lado do dinheiro que só o Asaas sabe: quanto entrou e quanto está
   * vencido.
   *
   * Rota separada do painel de propósito. Ela depende de um serviço externo, e
   * juntar as duas faria o painel inteiro sumir da tela quando o Asaas
   * demorasse — trocando um dado que falta por uma tela que não abre.
   */
  app.get("/socios/caixa", somenteSocios, async (request) => {
    const { meses } = z
      .object({ meses: z.coerce.number().int().min(3).max(24).default(6) })
      .parse(request.query);

    if (!asaasConfigurado) {
      return {
        disponivel: false,
        motivo:
          "A chave do Asaas não está configurada neste servidor. Sem ela não dá para dizer " +
          "quanto entrou — os números de receita do painel são previsão, não caixa.",
        serie: [],
        vencidas: null,
      };
    }

    const janela = ultimosMeses(meses);
    const recebidas = await listarRecebidas(
      comoDia(janela[0].inicio),
      comoDia(janela[janela.length - 1].fim),
    );

    const serie = janela.map((mes) => {
      const doMes = recebidas.filter((c) => {
        if (!c.paymentDate) return false;
        const pago = new Date(`${c.paymentDate}T00:00:00.000Z`);
        return pago >= mes.inicio && pago <= mes.fim;
      });

      return {
        mes: mes.chave,
        corrente: mes.corrente,
        recebido: Number(doMes.reduce((s, c) => s + (c.value ?? 0), 0).toFixed(2)),
        cobrancas: doMes.length,
      };
    });

    const vencidas = await listarVencidas(200);
    const hoje = new Date();
    const emAberto = vencidas.reduce((s, c) => s + (c.value ?? 0), 0);
    const recebidoNoMes = serie[serie.length - 1].recebido;

    return {
      disponivel: true,
      serie,
      vencidas: {
        quantidade: vencidas.length,
        valor: Number(emAberto.toFixed(2)),
        // Percentual do que está vencido sobre tudo o que deveria ter entrado
        // no mês. Sem o recebido no denominador o número não significa nada.
        percentual:
          recebidoNoMes + emAberto > 0
            ? Number(((emAberto / (recebidoNoMes + emAberto)) * 100).toFixed(1))
            : 0,
        // Faixas de atraso: cobrar quem venceu ontem e quem venceu há cinco
        // meses são conversas diferentes.
        faixas: [
          { rotulo: "até 30 dias", de: 0, ate: 30 },
          { rotulo: "31 a 60 dias", de: 31, ate: 60 },
          { rotulo: "61 a 90 dias", de: 61, ate: 90 },
          { rotulo: "mais de 90 dias", de: 91, ate: Number.MAX_SAFE_INTEGER },
        ].map((faixa) => {
          const dentro = vencidas.filter((c) => {
            const dias = Math.floor(
              (hoje.getTime() - new Date(`${c.dueDate}T00:00:00.000Z`).getTime()) / 86400000,
            );
            return dias >= faixa.de && dias <= faixa.ate;
          });
          return {
            rotulo: faixa.rotulo,
            quantidade: dentro.length,
            valor: Number(dentro.reduce((s, c) => s + (c.value ?? 0), 0).toFixed(2)),
          };
        }),
      },
    };
  });

  // ---------------------------------------------------------------- sociedade

  const socioSchema = z.object({
    nome: z.string().min(3, "Informe o nome do sócio.").max(160),
    participacao: z.coerce
      .number()
      .min(0, "Participação não pode ser negativa.")
      .max(100, "Participação não passa de 100%."),
    email: z.string().email("E-mail inválido.").optional().or(z.literal("")),
    telefone: z.string().max(30).optional().or(z.literal("")),
    entrouEm: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.")
      .optional()
      .or(z.literal("")),
  });

  app.get("/socios/sociedade", somenteSocios, async () => {
    const socios = await prisma.socio.findMany({
      where: { arquivadoEm: null },
      orderBy: [{ participacao: "desc" }, { nome: "asc" }],
    });

    const soma = socios.reduce((s, x) => s + Number(x.participacao), 0);

    return {
      socios: socios.map((s) => ({
        id: s.id,
        nome: s.nome,
        participacao: Number(s.participacao),
        email: s.email,
        telefone: s.telefone,
        entrouEm: s.entrouEm,
      })),
      somaParticipacao: Number(soma.toFixed(3)),
      // Avisamos, não travamos: durante uma entrada ou saída de sócio a soma
      // fica quebrada por alguns dias, e travar obrigaria a inventar número.
      fechaCem: Math.abs(soma - 100) < 0.01,
    };
  });

  app.post("/socios/sociedade", somenteSocios, async (request, reply) => {
    const d = socioSchema.parse(request.body);
    const socio = await prisma.socio.create({
      data: {
        nome: d.nome,
        participacao: d.participacao,
        email: d.email || null,
        telefone: d.telefone || null,
        entrouEm: d.entrouEm ? new Date(`${d.entrouEm}T00:00:00.000Z`) : null,
      },
    });
    return reply.code(201).send({ id: socio.id });
  });

  app.put("/socios/sociedade/:id", somenteSocios, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const d = socioSchema.parse(request.body);

    const existe = await prisma.socio.findFirst({ where: { id, arquivadoEm: null } });
    if (!existe) return reply.code(404).send({ message: "Sócio não encontrado." });

    await prisma.socio.update({
      where: { id },
      data: {
        nome: d.nome,
        participacao: d.participacao,
        email: d.email || null,
        telefone: d.telefone || null,
        entrouEm: d.entrouEm ? new Date(`${d.entrouEm}T00:00:00.000Z`) : null,
      },
    });
    return { id };
  });

  /**
   * Saída de sócio: carimbo, não DELETE.
   *
   * As distribuições já pagas apontam para ele. Apagar a linha levaria junto o
   * histórico de quanto cada um recebeu — que é o único registro que a
   * sociedade tem.
   */
  app.delete("/socios/sociedade/:id", somenteSocios, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existe = await prisma.socio.findFirst({ where: { id, arquivadoEm: null } });
    if (!existe) return reply.code(404).send({ message: "Sócio não encontrado." });

    await prisma.socio.update({ where: { id }, data: { arquivadoEm: new Date() } });
    return { id };
  });

  // ------------------------------------------------------------ distribuições

  app.get("/socios/distribuicoes", somenteSocios, async (request) => {
    const { meses } = z
      .object({ meses: z.coerce.number().int().min(3).max(48).default(12) })
      .parse(request.query);

    const desde = ultimosMeses(meses)[0].inicio;

    const linhas = await prisma.distribuicao.findMany({
      where: { competencia: { gte: desde } },
      orderBy: [{ competencia: "desc" }, { valor: "desc" }],
      include: { socio: { select: { id: true, nome: true } } },
    });

    // Agrupadas por competência: é assim que a sociedade conversa sobre elas.
    const porCompetencia = new Map<
      string,
      { competencia: string; total: number; itens: { id: string; socio: string; valor: number; observacao: string | null }[] }
    >();

    for (const l of linhas) {
      const chave = l.competencia.toISOString().slice(0, 7);
      if (!porCompetencia.has(chave)) {
        porCompetencia.set(chave, { competencia: chave, total: 0, itens: [] });
      }
      const grupo = porCompetencia.get(chave)!;
      grupo.total = Number((grupo.total + Number(l.valor)).toFixed(2));
      grupo.itens.push({
        id: l.id,
        socio: l.socio.nome,
        valor: Number(l.valor),
        observacao: l.observacao,
      });
    }

    return { competencias: [...porCompetencia.values()] };
  });

  app.post("/socios/distribuicoes", somenteSocios, async (request, reply) => {
    const d = z
      .object({
        socioId: z.string().uuid("Escolha o sócio."),
        competencia: z.string().regex(/^\d{4}-\d{2}$/, "Use AAAA-MM."),
        valor: z.coerce.number().positive("Valor precisa ser maior que zero."),
        observacao: z.string().max(300).optional().or(z.literal("")),
      })
      .parse(request.body);

    const socio = await prisma.socio.findFirst({
      where: { id: d.socioId, arquivadoEm: null },
    });
    if (!socio) return reply.code(404).send({ message: "Sócio não encontrado." });

    const competencia = new Date(`${d.competencia}-01T00:00:00.000Z`);

    const jaTem = await prisma.distribuicao.findUnique({
      where: { socioId_competencia: { socioId: d.socioId, competencia } },
    });
    if (jaTem) {
      return reply.code(409).send({
        message: `${socio.nome} já tem lançamento em ${d.competencia}. Apague o anterior para relançar.`,
      });
    }

    const criada = await prisma.distribuicao.create({
      data: {
        socioId: d.socioId,
        competencia,
        valor: d.valor,
        observacao: d.observacao || null,
      },
    });

    return reply.code(201).send({ id: criada.id });
  });

  app.delete("/socios/distribuicoes/:id", somenteSocios, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existe = await prisma.distribuicao.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ message: "Lançamento não encontrado." });

    await prisma.distribuicao.delete({ where: { id } });
    return { id };
  });
}
