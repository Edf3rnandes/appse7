import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PapelNome, Provedor, TipoVinculo } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma.js";
import {
  ContaInativaError,
  CredencialInvalidaError,
  entrarComSenha,
} from "../src/modules/auth/auth.service.js";

/**
 * Entrada por e-mail e senha — a porta de serviço da administração.
 *
 * Ela existe para o sistema não ficar inacessível quando o login com Google
 * não está disponível. O schema tinha `Provedor.SENHA`, o seed gravava o hash
 * e o comentário prometia a válvula de escape, mas não havia rota que a
 * consumisse: quem rodasse sem GOOGLE_CLIENT_ID ficava trancado do lado de
 * fora do próprio sistema.
 *
 * Precisa de um Postgres com o schema do Hub. Rode com:
 *   DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const EMAIL = "teste-senha@exemplo.com";
const SENHA = "senha-de-teste-123";

async function limpar() {
  const usuarios = await prisma.usuario.findMany({ where: { email: EMAIL } });
  const ids = usuarios.map((u) => u.id);
  if (ids.length) {
    await prisma.vinculo.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.papel.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.identidade.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.tentativaVinculo.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.convite.deleteMany({ where: { email: EMAIL } });
}

async function criarContaComSenha(ativo = true) {
  const usuario = await prisma.usuario.create({
    data: {
      nome: "Admin de Teste",
      email: EMAIL,
      ativo,
      papeis: { create: { nome: PapelNome.ADMIN } },
      identidades: {
        create: {
          provedor: Provedor.SENHA,
          provedorSub: EMAIL,
          senhaHash: await bcrypt.hash(SENHA, 10),
        },
      },
    },
  });
  return usuario;
}

describe("entrada por e-mail e senha", () => {
  before(limpar);
  after(limpar);

  it("entra com a senha correta e traz papéis e vínculos", async () => {
    await criarContaComSenha();

    const usuario = await entrarComSenha(EMAIL, SENHA);

    assert.equal(usuario.email, EMAIL);
    assert.deepEqual(
      usuario.papeis.map((p) => p.nome),
      [PapelNome.ADMIN],
    );
    assert.ok(usuario.ultimoLoginEm, "deveria carimbar o último acesso");
  });

  it("aceita o e-mail com espaços e em maiúsculas", async () => {
    const usuario = await entrarComSenha(`  ${EMAIL.toUpperCase()}  `, SENHA);
    assert.equal(usuario.email, EMAIL);
  });

  it("recusa a senha errada", async () => {
    await assert.rejects(() => entrarComSenha(EMAIL, "outra-coisa"), CredencialInvalidaError);
  });

  // Senha errada e e-mail inexistente precisam ser indistinguíveis: a
  // diferença entre as duas respostas diria a um estranho quais e-mails têm
  // conta aqui dentro.
  it("dá a mesma resposta para senha errada e para e-mail inexistente", async () => {
    const mensagens: string[] = [];

    for (const [email, senha] of [
      [EMAIL, "outra-coisa"],
      ["nao-existe-mesmo@exemplo.com", "qualquer"],
    ]) {
      await assert.rejects(
        () => entrarComSenha(email, senha),
        (erro: unknown) => {
          assert.ok(erro instanceof CredencialInvalidaError);
          mensagens.push(erro.message);
          return true;
        },
      );
    }

    assert.equal(mensagens[0], mensagens[1]);
  });

  it("recusa conta desativada, mesmo com a senha certa", async () => {
    await prisma.usuario.update({ where: { email: EMAIL }, data: { ativo: false } });
    await assert.rejects(() => entrarComSenha(EMAIL, SENHA), ContaInativaError);
    await prisma.usuario.update({ where: { email: EMAIL }, data: { ativo: true } });
  });

  // Mesmo motivo do teste de convite: um convite emitido para quem já tem
  // conta precisa valer no login seguinte, seja ele pelo Google ou por senha.
  it("aplica convite pendente também no login por senha", async () => {
    await prisma.convite.create({
      data: {
        email: EMAIL,
        papel: PapelNome.PROFESSOR,
        legacyId: 909091,
        expiraEm: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const usuario = await entrarComSenha(EMAIL, SENHA);

    assert.ok(
      usuario.papeis.some((p) => p.nome === PapelNome.PROFESSOR),
      "o papel do convite deveria entrar já nesta sessão",
    );
    assert.ok(
      usuario.vinculos.some((v) => v.tipo === TipoVinculo.PROFESSOR && v.legacyId === 909091),
      "o vínculo de professor deveria sair pronto do convite",
    );
  });
});
