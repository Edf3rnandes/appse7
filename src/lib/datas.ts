// Datas de CALENDÁRIO (dia, sem hora) são gravadas como `date` no Postgres e
// representadas aqui sempre como meia-noite UTC. Todo cálculo abaixo usa
// apenas componentes UTC.
//
// Misturar leitura local com construção UTC foi a origem de um bug real: o
// servidor roda em America/Fortaleza (UTC-3), então a meia-noite UTC de uma
// segunda-feira é domingo 21h no horário local. Lendo `getDate()` (local) de
// uma data que era 2026-09-07T00:00Z, obtinha-se dia 6 — domingo —, e a
// "segunda daquela semana" saía 7 dias antes. Toda semana do cronograma era
// gravada na semana anterior, em silêncio.

export function emUtc(ano: number, mes: number, dia: number): Date {
  return new Date(Date.UTC(ano, mes, dia));
}

export function somarDias(data: Date, dias: number): Date {
  const d = new Date(data);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

/**
 * O dia de hoje segundo o relógio de parede do servidor, convertido para a
 * data de calendário correspondente.
 *
 * É a única função que olha o fuso local, e de propósito: "hoje" para quem
 * está em João Pessoa é o dia que ele vê no relógio, não o dia em UTC.
 */
export function hoje(): Date {
  const agora = new Date();
  return emUtc(agora.getFullYear(), agora.getMonth(), agora.getDate());
}

/** Segunda-feira da semana de uma data de calendário. */
export function segundaDaSemana(data: Date): Date {
  // getUTCDay: 0 = domingo. Domingo pertence à semana que começou na segunda
  // anterior, por isso o -6 no lugar de +1.
  const diaDaSemana = data.getUTCDay();
  return somarDias(data, diaDaSemana === 0 ? -6 : 1 - diaDaSemana);
}

export function primeiroDiaDoMes(ano: number, mes: number): Date {
  return emUtc(ano, mes - 1, 1);
}

export function ultimoDiaDoMes(ano: number, mes: number): Date {
  return emUtc(ano, mes, 0);
}

/**
 * Uma data de calendário, N meses à frente.
 *
 * É a conta que decide até quando uma matrícula vale: um plano semestral de 6
 * parcelas vence em 6 meses. O sistema antigo fazia o mesmo com o addMonths do
 * Carbon, só que na hora de gerar a cobrança — então matrícula sem cobrança
 * gerada ficava sem vencimento e nunca aparecia como vencida.
 *
 * `setUTCMonth` cuida da virada de ano sozinho. O dia 31 num mês de 30 escorrega
 * para o dia 1 do mês seguinte: é o comportamento do próprio Date, e o mesmo do
 * Carbon, então a data não muda de significado na migração.
 */
export function mesesAFrente(meses: number, apartir: Date = hoje()): Date {
  const base = emUtc(apartir.getUTCFullYear(), apartir.getUTCMonth(), apartir.getUTCDate());
  base.setUTCMonth(base.getUTCMonth() + meses);
  return base;
}
