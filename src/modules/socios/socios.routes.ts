import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { tratadorDeErro } from "../../lib/erros.js";
import { diaUtc, fecharDia } from "./fechamento.js";
import { receitaDe, valorLiquido } from "../../lib/precos.js";
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
  bolsista: boolean;
  plano: { valor: unknown; descontoPercentual: unknown };
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
        bolsista: true,
        plano: { select: { valor: true, descontoPercentual: true } },
      },
    })) as MatriculaParaConta[];

    const serie = janela.map((mes) => {
      const ativas = matriculas.filter((m) => ativaEm(m, mes.fim, mes.inicio));
      const receita = ativas.reduce((s, m) => s + receitaDe(m), 0);

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
      const receita = ativas.reduce((s, m) => s + receitaDe(m), 0);
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

  /**
   * Turmas: onde sobra vaga e onde falta.
   *
   * As duas perguntas que o sócio faz olhando a grade — "qual turma está
   * vazia" e "qual está estourando" — são a mesma consulta, lida dos dois
   * lados. Devolvemos todas as turmas com os números, e a tela ordena.
   *
   * Vaga ociosa não é só uma cadeira vazia: é uma cadeira vazia numa quadra
   * alugada, com professor pago e horário reservado. O custo já correu.
   */
  app.get("/socios/turmas", somenteSocios, async () => {
    const janela = ultimosMeses(4);
    const desde = janela[0].inicio;
    const mesCorrente = janela[janela.length - 1];

    const turmas = await prisma.turma.findMany({
      where: { ativa: true },
      orderBy: [{ unidade: { nome: "asc" } }, { nome: "asc" }],
      select: {
        id: true,
        nome: true,
        categoria: true,
        capacidade: true,
        aceitaNovasMatriculas: true,
        unidade: { select: { nome: true } },
        horarios: { select: { dia: true, inicio: true, fim: true }, orderBy: { inicio: "asc" } },
        professores: { select: { professor: { select: { id: true, nome: true } } } },
        // Os planos da turma dão o preço de referência quando ela está vazia e
        // não há aluno de onde tirar ticket médio.
        planos: { select: { plano: { select: { valor: true, ativo: true, descontoPercentual: true } } } },
        matriculas: {
          select: {
            status: true,
            criadoEm: true,
            canceladaEm: true,
            arquivadoEm: true,
            expiraEm: true,
            atualizadoEm: true,
            bolsista: true,
            plano: { select: { valor: true, descontoPercentual: true } },
          },
        },
      },
    });

    const linhas = turmas.map((t) => {
      const paraConta = t.matriculas.map((m) => ({
        ...m,
        unidade: { id: "", nome: "" },
      })) as unknown as MatriculaParaConta[];

      const ativas = paraConta.filter((m) => ativaEm(m, mesCorrente.fim, mesCorrente.inicio));
      const receita = ativas.reduce((soma, m) => soma + receitaDe(m), 0);
      const capacidade = t.capacidade ?? 0;

      // Preço de referência da turma vazia: a mediana dos planos ativos ligados
      // a ela. Mediana e não média porque uma turma costuma ter mensal,
      // semestral e família no mesmo balcão, e a média entre eles não é o preço
      // de ninguém.
      const precos = t.planos
        .filter((p) => p.plano.ativo)
        .map((p) => valorLiquido(p.plano.valor, p.plano.descontoPercentual))
        .filter((v) => v > 0)
        .sort((x, y) => x - y);
      const ticketDoPlano = precos.length ? precos[Math.floor(precos.length / 2)] : 0;
      const ticket = ativas.length > 0 ? receita / ativas.length : ticketDoPlano;

      // Pedidos que chegaram pelo site e ainda não foram confirmados. Numa
      // turma cheia isso é fila de espera; numa turma vazia é trabalho parado
      // no administrativo. Os dois casos interessam, por motivos opostos.
      const pendentes = t.matriculas.filter(
        (m) => m.status === StatusMatricula.CRIADA && !m.arquivadoEm,
      ).length;

      const entradasRecentes = t.matriculas.filter(
        (m) => m.criadoEm >= desde && m.status !== StatusMatricula.CRIADA,
      ).length;

      const saidasRecentes = t.matriculas.filter((m) => {
        const saida = saidaDe(m as unknown as MatriculaParaConta);
        return saida !== null && saida >= desde;
      }).length;

      return {
        turmaId: t.id,
        turma: t.nome,
        categoria: t.categoria,
        unidade: t.unidade.nome,
        horarios: t.horarios.map((h) => ({ dia: h.dia, inicio: h.inicio, fim: h.fim })),
        professores: t.professores.map((pt) => ({ id: pt.professor.id, nome: pt.professor.nome })),
        aceitaNovas: t.aceitaNovasMatriculas,
        ativas: ativas.length,
        capacidade,
        // Sem capacidade cadastrada não dá para falar em ocupação. Devolver 0
        // faria a turma parecer vazia numa lista ordenada por ociosidade, que
        // é justamente onde ela não deveria estar.
        ocupacao: capacidade > 0 ? Number(((ativas.length / capacidade) * 100).toFixed(1)) : null,
        vagas: capacidade > 0 ? capacidade - ativas.length : null,
        receitaPrevista: Number(receita.toFixed(2)),
        // O que essas cadeiras vazias renderiam por mês.
        //
        // Com aluno na turma, o ticket sai da própria turma. Sem aluno nenhum,
        // sai do plano ligado a ela — e é justamente a turma vazia que precisa
        // deste número, porque ela é a que mais custa. Deixar nulo aqui
        // esconderia o caso mais caro atrás de um traço.
        potencialOcioso:
          capacidade > 0 ? Number((ticket * (capacidade - ativas.length)).toFixed(2)) : null,
        // De onde veio o preço usado acima, para a tela não apresentar os dois
        // com a mesma confiança.
        ticketDe: ativas.length > 0 ? "turma" : ticketDoPlano > 0 ? "plano" : "sem referência",
        pendentes,
        entradasRecentes,
        saidasRecentes,
      };
    });

    return { meses: 4, turmas: linhas };
  });

  /**
   * Taxa de adesão: de cada pedido que chegou, quantos viraram matrícula.
   *
   * ATENÇÃO À DEFINIÇÃO, porque "adesão" tem duas leituras e elas dão números
   * muito diferentes:
   *
   *   - a que está aqui: pedidos CONFIRMADOS ÷ pedidos RECEBIDOS. Mede o funil
   *     — quanto do interesse que chega vira aluno de verdade;
   *   - a outra: matriculados ÷ capacidade. Essa é ocupação, e já está em
   *     /socios/turmas.
   *
   * Se para vocês adesão é a segunda, é trocar de campo na tela — as duas
   * estão calculadas.
   */
  app.get("/socios/adesao", somenteSocios, async (request) => {
    const { meses } = z
      .object({ meses: z.coerce.number().int().min(3).max(24).default(6) })
      .parse(request.query);

    const janela = ultimosMeses(meses);

    const matriculas = await prisma.matricula.findMany({
      where: { criadoEm: { gte: janela[0].inicio } },
      select: {
        status: true,
        criadoEm: true,
        canceladaEm: true,
        arquivadoEm: true,
        atualizadoEm: true,
        observacao: true,
      },
    });

    const serie = janela.map((mes) => {
      const doMes = matriculas.filter(
        (m) => m.criadoEm >= mes.inicio && m.criadoEm <= mes.fim,
      );

      const confirmadas = doMes.filter(
        (m) =>
          m.status === StatusMatricula.CONFIRMADA ||
          m.status === StatusMatricula.PAGAMENTO_PENDENTE,
      ).length;

      const aguardando = doMes.filter((m) => m.status === StatusMatricula.CRIADA).length;
      const recusadas = doMes.filter((m) => m.status === StatusMatricula.CANCELADA).length;

      // De onde veio o pedido. A matrícula feita pelo site carimba isso na
      // observação; a que o administrativo digitou, não. É o que separa
      // "quanto o site converte" de "quanto a escola matricula".
      const pelosite = doMes.filter((m) =>
        (m.observacao ?? "").startsWith("Matrícula feita pelo site"),
      ).length;

      return {
        mes: mes.chave,
        corrente: mes.corrente,
        recebidos: doMes.length,
        confirmados: confirmadas,
        aguardando,
        recusados: recusadas,
        pelosite,
        // Só conta o que já foi decidido: um pedido ainda esperando o
        // administrativo não é uma recusa, e colocá-lo no denominador
        // derrubaria a taxa do mês corrente todo mês, por construção.
        taxa:
          confirmadas + recusadas > 0
            ? Number(((confirmadas / (confirmadas + recusadas)) * 100).toFixed(1))
            : null,
      };
    });

    const decididos = serie.reduce((s, m) => s + m.confirmados + m.recusados, 0);
    const confirmados = serie.reduce((s, m) => s + m.confirmados, 0);

    return {
      serie,
      periodo: {
        recebidos: serie.reduce((s, m) => s + m.recebidos, 0),
        confirmados,
        aguardando: serie.reduce((s, m) => s + m.aguardando, 0),
        pelosite: serie.reduce((s, m) => s + m.pelosite, 0),
        taxa: decididos > 0 ? Number(((confirmados / decididos) * 100).toFixed(1)) : null,
      },
    };
  });

  /**
   * A série de fechamentos diários.
   *
   * Diferente de tudo o mais neste módulo: isto é lido de uma tabela, não
   * calculado na hora. Cada linha foi gravada às 23:59 do próprio dia.
   */
  app.get("/socios/fechamentos", somenteSocios, async (request) => {
    const { dias } = z
      .object({ dias: z.coerce.number().int().min(7).max(180).default(30) })
      .parse(request.query);

    const desde = new Date(diaUtc(new Date()).getTime() - dias * 86400000);

    const linhas = await prisma.fechamentoDiario.findMany({
      where: { data: { gte: desde } },
      orderBy: { data: "asc" },
    });

    return {
      dias: linhas.map((f) => ({
        data: f.data.toISOString().slice(0, 10),
        ativos: f.ativos,
        entradas: f.entradas,
        saidas: f.saidas,
        saldo: f.entradas - f.saidas,
        receitaPrevista: Number(f.receitaPrevista),
        vagasOciosas: f.vagasOciosas,
        origem: f.origem,
      })),
      // Quantos dias da série são reconstrução e não fechamento de verdade. A
      // tela avisa enquanto esse número não for zero.
      reconstruidos: linhas.filter((f) => f.origem === "RECONSTRUIDO").length,
    };
  });

  /**
   * Reprocessa o fechamento de um dia.
   *
   * Existe para o dia em que o servidor estava dormindo às 23:59 — coisa que
   * acontece em qualquer hospedagem que hiberna. Sem isto, um dia perdido
   * ficaria perdido.
   */
  app.post("/socios/fechamentos/reprocessar", somenteSocios, async (request) => {
    const { data } = z
      .object({ data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.").optional() })
      .parse(request.body ?? {});

    const dia = data ? new Date(`${data}T00:00:00.000Z`) : new Date();
    const fechado = await fecharDia(dia, "MANUAL");

    return {
      data: fechado.data.toISOString().slice(0, 10),
      ativos: fechado.ativos,
      entradas: fechado.entradas,
      saidas: fechado.saidas,
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
   * Mesma regra do resto do sistema — nada aqui apaga de verdade. Saber que
   * fulano foi sócio entre 2019 e 2024 é informação, e um DELETE a queimaria.
   */
  app.delete("/socios/sociedade/:id", somenteSocios, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existe = await prisma.socio.findFirst({ where: { id, arquivadoEm: null } });
    if (!existe) return reply.code(404).send({ message: "Sócio não encontrado." });

    await prisma.socio.update({ where: { id }, data: { arquivadoEm: new Date() } });
    return { id };
  });
}
