import { PapelNome, Provedor } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { adminEmails } from "../config/env.js";

// Seed idempotente: pode rodar a cada deploy.
//
// Ele NAO cria senha para ninguem por padrao. O caminho normal de entrada e o
// Google — a conta so ganha identidade de senha se SEED_ADMIN_SENHA existir,
// que e a valvula de escape para nao ficar trancado do lado de fora se o login
// social cair.
async function main() {
  if (adminEmails.length === 0) {
    console.log("ADMIN_EMAILS vazio — nenhum administrador para semear.");
    return;
  }

  const senha = process.env.SEED_ADMIN_SENHA ?? "";

  for (const email of adminEmails) {
    const usuario = await prisma.usuario.upsert({
      where: { email },
      create: { nome: email.split("@")[0], email },
      update: {},
    });

    await prisma.papel.upsert({
      where: { usuarioId_nome: { usuarioId: usuario.id, nome: PapelNome.ADMIN } },
      create: { usuarioId: usuario.id, nome: PapelNome.ADMIN },
      update: {},
    });

    if (senha !== "") {
      await prisma.identidade.upsert({
        where: { provedor_provedorSub: { provedor: Provedor.SENHA, provedorSub: email } },
        create: {
          usuarioId: usuario.id,
          provedor: Provedor.SENHA,
          provedorSub: email,
          senhaHash: await bcrypt.hash(senha, 10),
        },
        update: { senhaHash: await bcrypt.hash(senha, 10) },
      });
    }

    console.log(`admin garantido: ${email}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
