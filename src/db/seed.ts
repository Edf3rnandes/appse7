import { PapelNome, Provedor } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { adminEmails, socioEmails } from "../config/env.js";

// Seed idempotente: pode rodar a cada deploy.
//
// Ele NAO cria senha para ninguem por padrao. O caminho normal de entrada e o
// Google — a conta so ganha identidade de senha se SEED_ADMIN_SENHA existir,
// que e a valvula de escape para nao ficar trancado do lado de fora se o login
// social cair.
async function main() {
  // As contas a garantir, e quais papeis cada uma leva. Um mesmo e-mail pode
  // estar nas duas listas — e no caso do dono, normalmente esta.
  const contas = new Map<string, Set<PapelNome>>();
  const anotar = (email: string, papel: PapelNome) => {
    if (!contas.has(email)) contas.set(email, new Set());
    contas.get(email)!.add(papel);
  };

  for (const e of adminEmails) anotar(e, PapelNome.ADMIN);
  // O primeiro socio precisa nascer daqui: so socio convida socio, e sem esta
  // linha a area dos socios nasceria inalcancavel — ninguem poderia entrar
  // para convidar o primeiro.
  for (const e of socioEmails) anotar(e, PapelNome.SOCIO);

  if (contas.size === 0) {
    console.log("ADMIN_EMAILS e SOCIO_EMAILS vazios — nenhuma conta para semear.");
    return;
  }

  const senha = process.env.SEED_ADMIN_SENHA ?? "";

  for (const [email, papeis] of contas) {
    const usuario = await prisma.usuario.upsert({
      where: { email },
      create: { nome: email.split("@")[0], email },
      update: {},
    });

    for (const papel of papeis) {
      await prisma.papel.upsert({
        where: { usuarioId_nome: { usuarioId: usuario.id, nome: papel } },
        create: { usuarioId: usuario.id, nome: papel },
        update: {},
      });
    }

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

    console.log(`conta garantida: ${email} (${[...papeis].join(", ")})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
