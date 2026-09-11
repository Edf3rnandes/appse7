import { StatusMatricula } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { valorLiquido } from "../../lib/precos.js";

/**
 * O fechamento do dia.
 *
 * Todo dia às 23:59 o sistema grava quantos alunos a escola tinha, quantos
 * entraram e quantos saíram. A partir daí o número do dia é o que ele era no
 * dia — e não o que a base de hoje sugere que ele tenha sido.
 *
 * A diferença não é acadêmica. Sem fechamento, a única forma de responder
 * "quantos alunos tínhamos em março" é reconstruir das datas de cada
 * matrícula, e reconstrução tem dois furos que nenhum código conserta:
 *
 *   - preço: ela usa o valor de HOJE do plano, então um reajuste reescreve o
 *     passado inteiro;
 *   - status: `status` guarda o estado atual, não a linha do tempo. Uma
 *     matrícula hoje cancelada não diz em que dia foi confirmada.
 *
 * Cada linha é idempotente pela data: rodar duas vezes no mesmo dia corrige,
 * não duplica. É o que permite reprocessar um dia que falhou sem medo.
 */

export type OrigemFechamento = "AUTOMATICO" | "MANUAL" | "RECONSTRUIDO";

/** Meia-noite UTC do dia — a chave da linha. */
export function diaUtc(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** O último instante do dia. */
function fimDoDia(dia: Date) {
  return new Date(dia.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * Calcula e grava o retrato de um dia.
 *
 * Ele lê a base como ela está AGORA e a filtra pelas datas do dia pedido. Para
 * o dia corrente isso é exato. Para um dia passado é reconstrução — e é por
 * isso que `origem` existe: a tela precisa poder dizer qual dos dois está
 * mostrando, em vez de apresentar os dois com a mesma cara de exato.
 */
export async function fecharDia(dia: Date, origem: OrigemFechamento = "AUTOMATICO") {
  const inicio = diaUtc(dia);
  const fim = fimDoDia(inicio);

  const matriculas = await prisma.matricula.findMany({
    select: {
      status: true,
      criadoEm: true,
      canceladaEm: true,
      arquivadoEm: true,
      expiraEm: true,
      atualizadoEm: true,
      plano: { select: { valor: true, descontoPercentual: true } },
    },
  });

  const saidaDe = (m: (typeof matriculas)[number]) => {
    if (m.canceladaEm) return m.canceladaEm;
    if (m.arquivadoEm) return m.arquivadoEm;
    if (m.status === StatusMatricula.CANCELADA) return m.atualizadoEm;
    return null;
  };

  const ativas = matriculas.filter((m) => {
    if (m.criadoEm > fim) return false;
    const saida = saidaDe(m);
    if (saida && saida <= fim) return false;
    if (m.expiraEm && m.expiraEm < inicio) return false;
    return (
      m.status === StatusMatricula.CONFIRMADA ||
      m.status === StatusMatricula.PAGAMENTO_PENDENTE
    );
  });

  const entradas = matriculas.filter(
    (m) => m.criadoEm >= inicio && m.criadoEm <= fim && m.status !== StatusMatricula.CRIADA,
  ).length;

  const saidas = matriculas.filter((m) => {
    const saida = saidaDe(m);
    return saida !== null && saida >= inicio && saida <= fim;
  }).length;

  // Valor líquido (com o desconto por pagamento em dia, próprio de cada
  // plano) — o que a escola de fato espera receber, não o valor de tabela.
  // Ver o comentário de valorLiquido() em src/lib/precos.ts.
  const receita = ativas.reduce((s, m) => s + valorLiquido(m.plano.valor, m.plano.descontoPercentual), 0);

  // Vagas ociosas: só faz sentido contra a capacidade de hoje, porque
  // capacidade de turma também não tem histórico. Para o dia corrente é exato;
  // para um dia passado é a melhor aproximação disponível.
  const turmas = await prisma.turma.findMany({
    where: { ativa: true },
    select: { capacidade: true },
  });
  const capacidade = turmas.reduce((s, t) => s + (t.capacidade ?? 0), 0);

  const dados = {
    ativos: ativas.length,
    entradas,
    saidas,
    receitaPrevista: Number(receita.toFixed(2)),
    vagasOciosas: Math.max(0, capacidade - ativas.length),
    origem,
  };

  return prisma.fechamentoDiario.upsert({
    where: { data: inicio },
    create: { data: inicio, ...dados },
    update: dados,
  });
}

/**
 * Preenche os dias que passaram sem fechamento.
 *
 * Roda na subida do servidor. Cobre o caso normal — o serviço estava dormindo
 * às 23:59, coisa que acontece em qualquer hospedagem que hiberna — e também o
 * primeiro dia de vida do sistema, em que a série inteira precisa nascer de
 * algum lugar.
 *
 * Nunca reescreve um dia já fechado: um fechamento gravado no próprio dia vale
 * mais que qualquer reconstrução feita depois, e sobrescrevê-lo trocaria um
 * número exato por um aproximado.
 */
export async function preencherDiasEmFalta(diasParaTras = 60) {
  const hoje = diaUtc(new Date());
  const existentes = await prisma.fechamentoDiario.findMany({
    where: { data: { gte: new Date(hoje.getTime() - diasParaTras * 86400000) } },
    select: { data: true },
  });

  const jaTem = new Set(existentes.map((f) => f.data.toISOString().slice(0, 10)));
  const preenchidos: string[] = [];

  // De ontem para trás: o dia de hoje ainda não terminou, e fechá-lo agora
  // gravaria um retrato do meio da tarde como se fosse o do fim do dia.
  for (let i = 1; i <= diasParaTras; i++) {
    const dia = new Date(hoje.getTime() - i * 86400000);
    const chave = dia.toISOString().slice(0, 10);
    if (jaTem.has(chave)) continue;
    await fecharDia(dia, "RECONSTRUIDO");
    preenchidos.push(chave);
  }

  return preenchidos;
}

/**
 * Agenda o fechamento para as 23:59 do fuso da escola.
 *
 * Um `setTimeout` por vez, recalculado a cada disparo, em vez de um intervalo
 * fixo de 24h: intervalo fixo escorrega no horário de verão e acumula desvio,
 * e um serviço que reinicia perderia a conta. Aqui cada agendamento é
 * calculado do relógio, então reiniciar o processo apenas reagenda.
 *
 * `TZ=America/Fortaleza` está no blueprint do Render. Se faltar, o servidor
 * roda em UTC e o fechamento cairia às 20:59 local — por isso o horário é
 * calculado no fuso configurado, e não em UTC direto.
 */
export function agendarFechamento(fuso = process.env.TZ || "America/Fortaleza") {
  const agendar = () => {
    const espera = milissegundosAte(23, 59, fuso);
    const relogio = setTimeout(async () => {
      try {
        await fecharDia(new Date(), "AUTOMATICO");
      } catch {
        // Um fechamento que falha não pode derrubar o servidor. O dia perdido
        // é recuperado por preencherDiasEmFalta() na próxima subida, ou pela
        // rota de reprocessamento.
      }
      agendar();
    }, espera);

    // Não segura o processo vivo só por causa do timer: um `npm test` ou um
    // script que importe este módulo precisa conseguir terminar.
    relogio.unref?.();
  };

  agendar();
}

/** Quantos milissegundos faltam até HH:MM no fuso dado. */
export function milissegundosAte(hora: number, minuto: number, fuso: string) {
  const agora = new Date();

  // A hora local do fuso, lida do próprio Intl para não depender de o processo
  // estar rodando nele.
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(agora);

  const num = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const segundosAgora = num("hour") * 3600 + num("minute") * 60 + num("second");
  const segundosAlvo = hora * 3600 + minuto * 60;

  const falta = segundosAlvo - segundosAgora;
  return (falta > 0 ? falta : falta + 24 * 3600) * 1000;
}
