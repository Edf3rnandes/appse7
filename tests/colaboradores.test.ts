import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error — módulo do navegador, sem tipos. É o mesmo arquivo que a
// página carrega: testar uma cópia não provaria nada sobre a tela.
import { juntarColaboradores } from "../public/app.js";

/**
 * A promessa da tela de Colaboradores: uma pessoa, uma linha.
 *
 * Antes eram duas telas — "Professores" e "Usuários" — e quem já tinha cadastro
 * e conta aparecia nas duas, com a mesma cara, sem nada dizendo que era a mesma
 * pessoa. Pior: o campo de e-mail do cadastro prometia emitir o convite e não
 * emitia; o convite só saía na outra aba, redigitando tudo.
 *
 * Estes testes fixam a costura das três origens (cadastro, conta e convite).
 * Não precisam de banco: a função é pura de propósito, justamente para poder
 * ser provada.
 */

const professor = (id: string, extra = {}) => ({
  id, nome: `Prof ${id}`, email: `${id}@escola.com`, telefone: "83 90000-0000",
  ativo: true, _count: { turmas: 3 }, ...extra,
});

const conta = (id: string, extra = {}) => ({
  id, nome: `Conta ${id}`, email: `${id}@gmail.com`, ativo: true,
  ultimoLoginEm: null, papeis: ["PROFESSOR"], vinculos: [], ...extra,
});

const convite = (email: string, extra = {}) => ({
  id: `conv-${email}`, email, papel: "PROFESSOR", professorId: null,
  expiraEm: new Date(Date.now() + 86400000).toISOString(), usadoEm: null, ...extra,
});

describe("colaboradores: uma pessoa, uma linha", () => {
  it("junta o cadastro do professor com a conta dele", () => {
    const p = professor("p1");
    const c = conta("u1", {
      papeis: ["PROFESSOR"],
      vinculos: [{ tipo: "PROFESSOR", nome: "Prof p1", professorId: "p1" }],
    });

    const linhas = juntarColaboradores([p], [c], []);

    assert.equal(linhas.length, 1, "a mesma pessoa não pode virar duas linhas");
    assert.equal(linhas[0].professor.id, "p1");
    assert.equal(linhas[0].conta.id, "u1");
  });

  it("junta o convite em aberto à linha do professor convidado", () => {
    const linhas = juntarColaboradores(
      [professor("p1")], [], [convite("p1@escola.com", { professorId: "p1" })],
    );

    assert.equal(linhas.length, 1);
    assert.ok(linhas[0].convite, "o convite deveria aparecer na linha da pessoa");
  });

  it("ignora convite já usado — quem entrou aparece como conta", () => {
    const c = conta("u1", {
      vinculos: [{ tipo: "PROFESSOR", nome: "Prof p1", professorId: "p1" }],
    });
    const usado = convite("p1@escola.com", {
      professorId: "p1", usadoEm: new Date().toISOString(),
    });

    const linhas = juntarColaboradores([professor("p1")], [c], [usado]);

    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].convite, null, "convite usado não é pendência");
    assert.ok(linhas[0].conta);
  });

  it("não mostra responsável: cliente não é colaborador", () => {
    const familia = conta("u9", { papeis: ["RESPONSAVEL"], vinculos: [] });
    const linhas = juntarColaboradores([], [familia], []);
    assert.equal(linhas.length, 0);
  });

  it("mostra o administrativo, que tem conta e não tem cadastro", () => {
    const adm = conta("u2", { papeis: ["ADMINISTRATIVO"], vinculos: [] });
    const linhas = juntarColaboradores([], [adm], []);

    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].professor, null);
    assert.equal(linhas[0].conta.id, "u2");
  });

  it("mostra o convite sem cadastro, e some com ele quando vira conta", () => {
    const conv = convite("novo@gmail.com", { papel: "ADMINISTRATIVO" });

    const antes = juntarColaboradores([], [], [conv]);
    assert.equal(antes.length, 1, "o convidado precisa aparecer para poder ser reenviado");

    // Mesma pessoa depois de entrar: a conta é a linha, o convite não repete.
    const entrou = conta("u3", { email: "novo@gmail.com", papeis: ["ADMINISTRATIVO"] });
    const depois = juntarColaboradores([], [entrou], [conv]);
    assert.equal(depois.length, 1, "convite e conta da mesma pessoa não podem virar duas linhas");
    assert.ok(depois[0].conta);
  });

  it("põe quem precisa de atenção primeiro", () => {
    const semAcesso = professor("aaa-sem", { nome: "Zulmira" });
    const convidado = professor("bbb-conv", { nome: "Bruno" });
    const dentro = professor("ccc-tem", { nome: "Ana" });

    const linhas = juntarColaboradores(
      [dentro, convidado, semAcesso],
      [conta("u1", {
        vinculos: [{ tipo: "PROFESSOR", nome: "Ana", professorId: "ccc-tem" }],
      })],
      [convite("bbb-conv@escola.com", { professorId: "bbb-conv" })],
    );

    assert.deepEqual(
      linhas.map((l: { nome: string }) => l.nome),
      ["Zulmira", "Bruno", "Ana"],
      "sem acesso vem antes de convidado, que vem antes de quem já entra",
    );
  });

  it("usa o e-mail da conta quando o cadastro está sem e-mail", () => {
    // As turmas vieram do sistema antigo, que não guardava e-mail de professor.
    const p = professor("p1", { email: null });
    const c = conta("u1", {
      email: "rafael@gmail.com",
      vinculos: [{ tipo: "PROFESSOR", nome: "Prof p1", professorId: "p1" }],
    });

    const linhas = juntarColaboradores([p], [c], []);
    assert.equal(linhas[0].email, "rafael@gmail.com");
  });
});
