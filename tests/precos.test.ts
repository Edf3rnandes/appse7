import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { valorLiquido } from "../src/lib/precos.js";

/**
 * Valor líquido do plano — o que a família paga de verdade se pagar até o
 * vencimento, não o valor de tabela. O desconto é por PLANO, não por família:
 * um aluno no plano Base (10%) não herda o desconto de 20% de um irmão no
 * plano Família, mesmo as duas matrículas contando pra mesma "receita
 * prevista" da escola.
 */

describe("valorLiquido", () => {
  it("aplica o desconto do próprio plano", () => {
    assert.equal(valorLiquido(150, 10), 135);
    assert.equal(valorLiquido(200, 20), 160);
  });

  it("sem desconto, o valor líquido é o bruto", () => {
    assert.equal(valorLiquido(150, 0), 150);
    assert.equal(valorLiquido(150, undefined), 150);
  });

  it("valor ausente vira 0, não NaN", () => {
    assert.equal(valorLiquido(null, 10), 0);
    assert.equal(valorLiquido(undefined, 10), 0);
  });

  it("exemplo: filho na Base (10%) + pai no plano comum (20%) — cada um com o desconto do seu próprio plano", () => {
    // João (filho), Base Altiplano: mensalidade R$ 150, desconto 10% (fixo do
    // plano Base, mesmo fazendo parte de uma matrícula de família).
    const joao = valorLiquido(150, 10);
    // Marcos (pai), Adultos 1 Altiplano, plano com desconto de família: 20%.
    const marcos = valorLiquido(200, 20);
    assert.equal(joao, 135);
    assert.equal(marcos, 160);
    // O boleto sai pela soma bruta (150 + 200 = 350); o que entra até o
    // vencimento é a soma dos líquidos — cada um com SEU desconto, não um
    // desconto de família aplicado por igual aos dois.
    assert.equal(joao + marcos, 295);
    assert.notEqual(joao + marcos, (150 + 200) * 0.8); // não é "20% pra todo mundo"
  });
});
