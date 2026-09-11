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

/**
 * Quanto uma matrícula soma na receita prevista — zero se for bolsista.
 *
 * Bolsista ocupa vaga (conta como matrícula ativa, para ocupação e vagas
 * ociosas) mas não é dinheiro entrando: o plano dele continua com valor de
 * tabela só para efeito de exibição ("Mensal, R$150"), nunca de conta.
 */
export function receitaDe(m: { bolsista: boolean; plano: { valor: unknown; descontoPercentual: unknown } }): number {
  return m.bolsista ? 0 : valorLiquido(m.plano.valor, m.plano.descontoPercentual);
}
