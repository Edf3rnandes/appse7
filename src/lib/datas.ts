// Datas de calendário (sem hora) são gravadas como @db.Date no Postgres. Para
// comparar sem escorregar um dia por fuso, montamos tudo em UTC — o valor que
// o Prisma grava e devolve para uma coluna Date é sempre meia-noite UTC.

export function emUtc(ano: number, mes: number, dia: number): Date {
  return new Date(Date.UTC(ano, mes, dia));
}

/** Segunda-feira da semana da data informada. */
export function segundaDaSemana(data: Date): Date {
  const d = emUtc(data.getFullYear(), data.getMonth(), data.getDate());
  // getUTCDay: 0 = domingo. Domingo pertence à semana que começou na segunda
  // anterior, por isso o -6 no lugar de +1.
  const diaDaSemana = d.getUTCDay();
  const ajuste = diaDaSemana === 0 ? -6 : 1 - diaDaSemana;
  return somarDias(d, ajuste);
}

export function somarDias(data: Date, dias: number): Date {
  const d = new Date(data);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

export function primeiroDiaDoMes(data: Date): Date {
  return emUtc(data.getFullYear(), data.getMonth(), 1);
}

export function ultimoDiaDoMes(data: Date): Date {
  return emUtc(data.getFullYear(), data.getMonth() + 1, 0);
}
