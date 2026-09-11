import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hoje, somarDias } from "../src/lib/datas.js";
import { proximoVencimento, vencimentoDaTaxa } from "../src/modules/financeiro/cobranca.routes.js";

/**
 * Vencimento padrão das cobranças emitidas pelo Hub.
 *
 * A taxa de matrícula e a mensalidade não seguem a mesma régua: a mensalidade
 * é recorrente e segue o dia combinado nas condições do plano (dia 10); a
 * taxa é avulsa, cobrada no ato da matrícula, e vence em 24h — dar até o
 * próximo dia 10 pra ela dava, num caso real, quase um mês de prazo pra um
 * pagamento único.
 */
describe("vencimento padrão da cobrança", () => {
  it("a taxa de matrícula vence amanhã, não no dia configurado", () => {
    const amanha = somarDias(hoje(), 1).toISOString().slice(0, 10);
    assert.equal(vencimentoDaTaxa(), amanha);
  });

  it("a mensalidade continua seguindo o dia configurado, no mês corrente ou no próximo", () => {
    const hojeIso = hoje().toISOString().slice(0, 10);
    const vencimento = proximoVencimento(10);
    assert.match(vencimento, /^\d{4}-\d{2}-10$/);
    assert.ok(vencimento >= hojeIso, "não pode gerar um vencimento no passado");
  });
});
