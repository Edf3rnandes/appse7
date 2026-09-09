import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Confere a sintaxe do JavaScript das páginas.
 *
 * O front é módulo ES embutido no HTML, sem passo de build — então nada
 * verifica esse código antes do navegador. E o modo como ele falha é o pior
 * possível: um erro de sintaxe faz o navegador recusar o módulo INTEIRO, a
 * página fica em branco, e o log do servidor mostra 200 em tudo. Foi assim que
 * um `let unidades` declarado duas vezes derrubou a tela do administrativo sem
 * deixar rastro no servidor.
 *
 * `node --check` faz o mesmo que o navegador faz ao carregar o módulo, e custa
 * milissegundos. Roda no build e dá para chamar à mão: npm run checar:paginas
 */

const pasta = "public";
const temporaria = mkdtempSync(join(tmpdir(), "se7-paginas-"));
const problemas = [];

for (const arquivo of readdirSync(pasta)) {
  const caminho = join(pasta, arquivo);

  let codigo;
  if (arquivo.endsWith(".js")) {
    codigo = readFileSync(caminho, "utf8");
  } else if (arquivo.endsWith(".html")) {
    const html = readFileSync(caminho, "utf8");
    const bloco = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    if (!bloco) continue;
    codigo = bloco[1];
  } else {
    continue;
  }

  const destino = join(temporaria, `${arquivo}.mjs`);
  writeFileSync(destino, codigo);

  try {
    execFileSync(process.execPath, ["--check", destino], { stdio: "pipe" });
    console.log(`  ok  ${arquivo}`);
  } catch (erro) {
    // A mensagem do node aponta o arquivo temporário; trocamos pelo real para
    // a linha do erro ser útil a quem lê.
    const saida = String(erro.stderr).replaceAll(destino, caminho);
    problemas.push(saida);
    console.log(`FALHA  ${arquivo}`);
  }
}

if (problemas.length) {
  console.error("\n" + problemas.join("\n"));
  process.exit(1);
}
