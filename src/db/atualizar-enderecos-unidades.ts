import { prisma } from "../lib/prisma.js";

/**
 * Preenche o endereço das unidades que ainda estavam sem, com o texto do site
 * atual (www.se7voleidepraia.com.br, seção "Unidades") — a única fonte que
 * tínhamos à mão na hora de montar a página de entrada do Hub.
 *
 * Só grava onde `endereco` está vazio. Bancários e Bessa já tinham um
 * endereço diferente cadastrado aqui, e não mexemos neles: não dava para
 * saber, só olhando, qual dos dois está desatualizado — o daqui ou o do site.
 * Isso fica para alguém confirmar, não para o script decidir sozinho.
 *
 * Rode uma vez, com o `.env` apontando para o banco certo: npm run
 * atualizar:enderecos
 */

const ENDERECOS: Record<string, string> = {
  Altiplano: "Arena ACE, Rua Waldemar de Albuquerque Aranha, s/n",
  Areia: "R. Profa. Nyedja Nascimento, s/n – Areia, PB, 58397-000",
  "Cabo Branco": "Praia de Cabo Branco – Av. Cabo Branco, 5197",
  "Alagoa Grande": "R. João Neponucena, s/n – Alagoa Grande, PB, 58388-000",
};

async function main() {
  for (const [nome, endereco] of Object.entries(ENDERECOS)) {
    const unidade = await prisma.unidade.findFirst({ where: { nome } });
    if (!unidade) {
      console.log(`(ignorado) nenhuma unidade chamada "${nome}" neste banco`);
      continue;
    }
    if (unidade.endereco) {
      console.log(`(mantido) ${nome} já tinha endereço: ${unidade.endereco}`);
      continue;
    }
    await prisma.unidade.update({ where: { id: unidade.id }, data: { endereco } });
    console.log(`${nome} -> ${endereco}`);
  }
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
