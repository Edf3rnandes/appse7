import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  data,
  decimal,
  DumpInvalidoError,
  inteiro,
  lerDump,
  texto,
} from "../src/db/dump/ler-dump.js";

/**
 * O leitor do dump do MySQL.
 *
 * É o único ponto do sistema em que um erro não aparece como erro: um parser
 * que corta a linha no lugar errado grava o telefone de alguém no campo do CPF
 * e ninguém percebe até a cobrança sair com o dado trocado. Por isso os testes
 * aqui são quase todos sobre texto sujo, e não sobre o caminho feliz.
 */

describe("leitura do dump", () => {
  it("lê um INSERT simples com os nomes das colunas", () => {
    const t = lerDump(
      "INSERT INTO `units` (`id`, `name`) VALUES (1,'Bessa'),(2,'Bancários');",
      ["units"],
    );
    assert.deepEqual(t.get("units"), [
      { id: 1, name: "Bessa" },
      { id: 2, name: "Bancários" },
    ]);
  });

  it("ignora as tabelas que não foram pedidas", () => {
    const t = lerDump(
      "INSERT INTO `jobs` (`id`) VALUES (1);\nINSERT INTO `units` (`id`) VALUES (2);",
      ["units"],
    );
    assert.equal(t.get("units")?.length, 1);
    assert.equal(t.has("jobs"), false);
  });

  it("não se perde com vírgula e parêntese dentro do texto", () => {
    // O caso que quebra um parser feito com expressão regular: o `),(` está
    // dentro das aspas e NÃO separa duas linhas.
    const t = lerDump(
      "INSERT INTO `customers` (`id`, `name`) VALUES " +
        "(1,'Marina Nóbrega, a mãe do Miguel'),(2,'Fulano (o pai), do Bessa');",
      ["customers"],
    );
    assert.deepEqual(t.get("customers"), [
      { id: 1, name: "Marina Nóbrega, a mãe do Miguel" },
      { id: 2, name: "Fulano (o pai), do Bessa" },
    ]);
  });

  it("entende as duas formas de aspas escapadas", () => {
    const t = lerDump(
      "INSERT INTO `t` (`a`, `b`) VALUES ('com \\'barra\\'','com ''duas''');",
      ["t"],
    );
    assert.deepEqual(t.get("t"), [{ a: "com 'barra'", b: "com 'duas'" }]);
  });

  it("separa NULL de 'NULL' e 0 de '0'", () => {
    // Um aluno chamado Null existe, e um CPF anotado como texto também. Tratar
    // os dois como ausência de valor apagaria dado real.
    const t = lerDump("INSERT INTO `t` (`a`, `b`, `c`, `d`) VALUES (NULL,'NULL',0,'0');", ["t"]);
    assert.deepEqual(t.get("t"), [{ a: null, b: "NULL", c: 0, d: "0" }]);
  });

  it("traduz os escapes de quebra de linha e barra", () => {
    const t = lerDump("INSERT INTO `t` (`a`) VALUES ('linha1\\nlinha2\\\\fim');", ["t"]);
    assert.equal(t.get("t")?.[0].a, "linha1\nlinha2\\fim");
  });

  it("recusa um dump truncado em vez de gravar meia linha", () => {
    assert.throws(
      () => lerDump("INSERT INTO `t` (`a`, `b`) VALUES (1,'sem fim", ["t"]),
      DumpInvalidoError,
    );
  });

  it("recusa uma linha com número de valores diferente do de colunas", () => {
    assert.throws(
      () => lerDump("INSERT INTO `t` (`a`, `b`) VALUES (1);", ["t"]),
      DumpInvalidoError,
    );
  });

  it("lê vários INSERTs da mesma tabela, como o mysqldump quebra por tamanho", () => {
    const t = lerDump(
      "INSERT INTO `t` (`a`) VALUES (1),(2);\nINSERT INTO `t` (`a`) VALUES (3);",
      ["t"],
    );
    assert.deepEqual(t.get("t")?.map((l) => l.a), [1, 2, 3]);
  });
});

describe("conversão dos valores", () => {
  it("data monta em UTC pelos componentes", () => {
    // Deixar o `new Date(texto)` decidir faria a data ser lida como hora local:
    // a data de nascimento andaria um dia dependendo de onde o servidor roda.
    assert.equal(data("2014-03-11")?.toISOString(), "2014-03-11T00:00:00.000Z");
    assert.equal(data("2026-07-20 15:30:00")?.toISOString(), "2026-07-20T15:30:00.000Z");
  });

  it("'0000-00-00' não é data", () => {
    assert.equal(data("0000-00-00"), null);
    assert.equal(data("0000-00-00 00:00:00"), null);
  });

  it("texto vazio vira ausência", () => {
    assert.equal(texto(""), null);
    assert.equal(texto("   "), null);
    assert.equal(texto(" Bessa "), "Bessa");
  });

  it("capacidade em branco é ausência, não zero", () => {
    // Zero diria "turma sem vaga", que é o oposto de "não sabemos" — e é assim
    // que a turma apareceria no topo da lista de ociosas por falta de dado.
    assert.equal(inteiro(""), null);
    assert.equal(inteiro(null), null);
    assert.equal(inteiro("16"), 16);
  });

  it("decimal aceita o formato que o MySQL escreve", () => {
    assert.equal(decimal("112.90"), 112.9);
    assert.equal(decimal(148), 148);
    assert.equal(decimal(""), null);
  });
});
