import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TipoVinculo } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { entrarComGoogle, montarToken, vincularPorCpf } from "../src/modules/auth/auth.service.js";

/**
 * Vínculo de responsável que ficou sem destino.
 *
 * A chave estrangeira `vinculos.responsavelId` é ON DELETE SET NULL. Quando a
 * secretaria apaga um responsável do cadastro — e refaz o cadastro dele depois,
 * que é o caso comum de um CPF digitado errado — a conta dele fica com um
 * vínculo do tipo RESPONSAVEL apontando para lugar nenhum. O portal abre, o
 * login funciona, e a lista de filhos vem vazia sem explicar por quê.
 *
 * Precisa de um Postgres com o schema do Hub. Rode com:
 *   DATABASE_URL=... JWT_SECRET=... npx tsx --test tests/*.test.ts
 */

const EMAIL = "teste-vinculo@exemplo.com";
const CPF = "40364147806";
const NOME = "Responsável de Teste (vínculo)";

const perfil = { sub: "sub-vinculo-1", email: EMAIL, nome: NOME, avatarUrl: null };

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
  await prisma.responsavel.deleteMany({ where: { cpf: CPF } });
}

describe("vínculo de responsável sem destino", () => {
  before(limpar);
  after(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  it("é reaproveitado quando a pessoa informa o CPF de novo", async () => {
    const usuario = await entrarComGoogle(perfil);
    const responsavel = await prisma.responsavel.create({ data: { nome: NOME, cpf: CPF } });

    await vincularPorCpf(usuario.id, CPF, "127.0.0.1");

    // A secretaria apaga o cadastro: o ON DELETE SET NULL solta o vínculo.
    await prisma.responsavel.delete({ where: { id: responsavel.id } });
    const solto = await prisma.vinculo.findFirst({ where: { usuarioId: usuario.id } });
    assert.equal(solto?.responsavelId, null, "o vínculo deveria ter ficado sem destino");

    // E refaz o cadastro, com o mesmo CPF.
    const refeito = await prisma.responsavel.create({ data: { nome: NOME, cpf: CPF } });
    await vincularPorCpf(usuario.id, CPF, "127.0.0.1");

    const vinculos = await prisma.vinculo.findMany({ where: { usuarioId: usuario.id } });
    assert.equal(vinculos.length, 1, "não pode sobrar um segundo vínculo do mesmo tipo");
    assert.equal(vinculos[0].responsavelId, refeito.id);
  });

  it("perde para o vínculo bom na hora de montar o token", async () => {
    // Estado que só existe em base já bagunçada: dois vínculos RESPONSAVEL, o
    // vazio primeiro. O token tem de pegar o que aponta para alguém.
    const token = montarToken({
      id: "u1",
      nome: NOME,
      email: EMAIL,
      papeis: [],
      vinculos: [
        { tipo: TipoVinculo.RESPONSAVEL, professorId: null, responsavelId: null },
        { tipo: TipoVinculo.RESPONSAVEL, professorId: null, responsavelId: "r1" },
      ],
    });

    assert.equal(token.responsavelId, "r1");
  });
});
