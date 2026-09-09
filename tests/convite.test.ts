import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PapelNome, Provedor, TipoVinculo } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { entrarComGoogle } from "../src/modules/auth/auth.service.js";

/**
 * Convite aplicado a quem JÁ TEM CONTA.
 *
 * Este teste existe por causa de um bug real em produção: o administrativo emitiu
 * um convite de professor para o próprio e-mail, já cadastrado como ADMIN, e
 * ele ficou "aguardando" para sempre — a checagem de convite só rodava no
 * caminho de criação de conta nova.
 *
 * Precisa de um Postgres com o schema do Hub. Rode com:
 *   DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const EMAIL = "teste-convite@exemplo.com";
const EMAIL_OUTRO = "teste-outro@exemplo.com";

const perfil = (email: string, sub: string) => ({
  sub,
  email,
  nome: "Fulano de Teste",
  avatarUrl: null,
});

/** O professor do cadastro a que os convites deste arquivo apontam. */
const PROFESSOR_NOME = "Professor de Teste (convite)";

async function professorDeTeste() {
  const existente = await prisma.professor.findFirst({ where: { nome: PROFESSOR_NOME } });
  return existente ?? prisma.professor.create({ data: { nome: PROFESSOR_NOME } });
}

async function limpar() {
  const emails = [EMAIL, EMAIL_OUTRO];
  const usuarios = await prisma.usuario.findMany({ where: { email: { in: emails } } });
  const ids = usuarios.map((u) => u.id);
  if (ids.length) {
    await prisma.vinculo.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.papel.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.identidade.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.tentativaVinculo.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.convite.deleteMany({ where: { email: { in: emails } } });
  await prisma.professor.deleteMany({ where: { nome: PROFESSOR_NOME } });
}

async function convidarProfessor(email: string, professorId: string, diasDeValidade = 14) {
  return prisma.convite.create({
    data: {
      email,
      papel: PapelNome.PROFESSOR,
      professorId,
      expiraEm: new Date(Date.now() + diasDeValidade * 24 * 60 * 60 * 1000),
    },
  });
}

describe("convite de professor", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("é aplicado a uma conta que já existe, no login seguinte", async () => {
    // conta que já entrou antes, como a do administrativo
    const antes = await entrarComGoogle(perfil(EMAIL, "sub-1"));
    assert.equal(antes.vinculos.length, 0, "não deveria nascer com vínculo");

    const professor = await professorDeTeste();
    const convite = await convidarProfessor(EMAIL, professor.id);

    const depois = await entrarComGoogle(perfil(EMAIL, "sub-1"));
    const vinculo = depois.vinculos.find((v) => v.tipo === TipoVinculo.PROFESSOR);

    assert.ok(vinculo, "o vínculo de professor deveria ter sido criado");
    assert.equal(vinculo.professorId, professor.id);
    assert.ok(
      depois.papeis.some((p) => p.nome === PapelNome.PROFESSOR),
      "o papel de professor deveria ter sido concedido",
    );

    const usado = await prisma.convite.findUniqueOrThrow({ where: { id: convite.id } });
    assert.ok(usado.usadoEm, "o convite deveria ficar marcado como usado");
  });

  it("não é reaplicado depois de usado", async () => {
    const depois = await entrarComGoogle(perfil(EMAIL, "sub-1"));
    assert.equal(
      depois.vinculos.filter((v) => v.tipo === TipoVinculo.PROFESSOR).length,
      1,
      "não pode duplicar o vínculo a cada login",
    );
  });

  it("não rouba um professor já vinculado a outra conta", async () => {
    await entrarComGoogle(perfil(EMAIL_OUTRO, "sub-2"));
    // Esse professor já pertence à conta do primeiro teste.
    const professor = await professorDeTeste();
    const convite = await convidarProfessor(EMAIL_OUTRO, professor.id);

    const depois = await entrarComGoogle(perfil(EMAIL_OUTRO, "sub-2"));

    assert.equal(depois.vinculos.length, 0, "não deveria ganhar o vínculo alheio");
    const pendente = await prisma.convite.findUniqueOrThrow({ where: { id: convite.id } });
    assert.equal(pendente.usadoEm, null, "o convite deveria seguir pendente para o administrativo ver");
  });

  it("ignora convite expirado", async () => {
    await prisma.convite.deleteMany({ where: { email: EMAIL_OUTRO } });
    await prisma.convite.create({
      data: {
        email: EMAIL_OUTRO,
        papel: PapelNome.ADMINISTRATIVO,
        expiraEm: new Date(Date.now() - 60 * 1000),
      },
    });

    const depois = await entrarComGoogle(perfil(EMAIL_OUTRO, "sub-2"));
    assert.ok(
      !depois.papeis.some((p) => p.nome === PapelNome.ADMINISTRATIVO),
      "convite vencido não pode conceder papel",
    );
  });

  it("conta nova continua nascendo como responsável sem vínculo", async () => {
    await prisma.convite.deleteMany({ where: { email: EMAIL_OUTRO } });
    const usuarios = await prisma.usuario.findMany({ where: { email: EMAIL_OUTRO } });
    const ids = usuarios.map((u) => u.id);
    await prisma.papel.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.identidade.deleteMany({ where: { usuarioId: { in: ids } } });
    await prisma.usuario.deleteMany({ where: { id: { in: ids } } });

    const nova = await entrarComGoogle(perfil(EMAIL_OUTRO, "sub-3"));
    assert.deepEqual(
      nova.papeis.map((p) => p.nome),
      [PapelNome.RESPONSAVEL],
    );
    assert.equal(nova.vinculos.length, 0);
    assert.ok(
      await prisma.identidade.findUnique({
        where: { provedor_provedorSub: { provedor: Provedor.GOOGLE, provedorSub: "sub-3" } },
      }),
    );
  });
});
