/**
 * Valor líquido de um plano — o que a família paga de verdade se pagar até o
 * vencimento, não o valor de tabela.
 *
 * O desconto por pagamento em dia é uma condição padrão do plano (ver as
 * condições contratuais de cada um: "DESCONTO: 10% até o vencimento" etc.),
 * não uma promoção rara — e o desconto muda de plano para plano (o plano
 * Base é 10% mesmo fazendo parte de uma matrícula de família, que nos outros
 * planos é 20%). Por isso toda conta de "receita prevista" soma este valor,
 * e não o bruto: bruto é o que sai no boleto, líquido é o que entra.
 */
export function valorLiquido(valor: unknown, descontoPercentual: unknown): number {
  const bruto = Number(valor ?? 0);
  const desconto = Number(descontoPercentual ?? 0);
  return bruto * (1 - desconto / 100);
}
