/**
 * Leitor de dump do MySQL.
 *
 * Lê o arquivo que o `mysqldump` produz e devolve as linhas de cada tabela. Não
 * conecta em lugar nenhum: o dump é um arquivo, e ler arquivo dispensa
 * credencial, VPN e janela de manutenção. A ponte em src/db/legacy/ continua
 * existindo para quem tiver o banco à mão, mas ela deixou de ser o único
 * caminho — e era ela que estava travando a importação.
 *
 * O parser é deliberadamente pequeno e recusa o que não entende. Ele NÃO é um
 * interpretador de SQL: reconhece exatamente `INSERT INTO ... VALUES ...` no
 * formato do mysqldump, e ignora todo o resto (CREATE TABLE, LOCK, SET,
 * comentários). Qualquer coisa fora desse formato vira erro, em vez de virar
 * dado errado gravado em silêncio.
 *
 * Exige `--complete-insert`, que é o que põe os nomes das colunas no INSERT.
 * Sem eles, a ordem das colunas viria do CREATE TABLE do dump — e bastaria uma
 * coluna acrescentada no meio para o telefone de todo mundo virar CPF.
 */

export type ValorSql = string | number | null;
export type LinhaDump = Record<string, ValorSql>;

/** Uma tabela lida do dump, com as linhas na ordem em que apareceram. */
export type TabelasDoDump = Map<string, LinhaDump[]>;

export class DumpInvalidoError extends Error {}

/** Os escapes do MySQL que mudam o texto. */
const ESCAPES: Record<string, string> = {
  // O byte nulo. Grava-lo num nome quebraria o insert no Postgres; some,
  // que e o que ele significa num campo de texto de qualquer forma.
  "0": "",
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  Z: "",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

/**
 * Percorre o texto do dump extraindo os INSERTs das tabelas pedidas.
 *
 * `tabelas` limita o que é lido. Um dump da escola inteira traz coisas que não
 * interessam (jobs, migrations, sessions), e carregar tudo na memória para
 * jogar fora depois é desperdício num arquivo que pode ter centenas de MB.
 */
export function lerDump(texto: string, tabelas: string[]): TabelasDoDump {
  const querido = new Set(tabelas);
  const saida: TabelasDoDump = new Map(tabelas.map((t) => [t, []]));

  // `INSERT INTO `x` (`a`,`b`) VALUES` — daqui em diante o resto é lido à mão,
  // porque os valores podem conter parênteses, vírgulas e aspas escapadas.
  const cabecalho = /INSERT\s+INTO\s+[`"]?(\w+)[`"]?\s*\(([^)]*)\)\s*VALUES\s*/gi;

  let achado: RegExpExecArray | null;
  while ((achado = cabecalho.exec(texto)) !== null) {
    const tabela = achado[1];
    if (!querido.has(tabela)) continue;

    const colunas = achado[2]
      .split(",")
      .map((c) => c.trim().replace(/^[`"]|[`"]$/g, ""));

    const { tuplas, fim } = lerTuplas(texto, achado.index + achado[0].length, tabela);

    for (const tupla of tuplas) {
      if (tupla.length !== colunas.length) {
        throw new DumpInvalidoError(
          `Tabela ${tabela}: uma linha veio com ${tupla.length} valores para ` +
            `${colunas.length} colunas. O dump parece truncado.`,
        );
      }
      const linha: LinhaDump = {};
      colunas.forEach((c, i) => (linha[c] = tupla[i]));
      saida.get(tabela)!.push(linha);
    }

    // Continua a varredura depois do INSERT inteiro, e não de onde a regex
    // parou: sem isto o próximo `exec` voltaria para dentro dos valores.
    cabecalho.lastIndex = fim;
  }

  return saida;
}

/**
 * Lê a sequência `(...),(...),(...);` a partir de uma posição.
 *
 * Escrito à mão porque expressão regular não dá conta: um valor pode conter
 * `),(` dentro de aspas — um endereço com vírgula, uma observação com
 * parêntese — e a regex cortaria a linha ao meio.
 */
function lerTuplas(
  texto: string,
  inicio: number,
  tabela: string,
): { tuplas: ValorSql[][]; fim: number } {
  const tuplas: ValorSql[][] = [];
  let i = inicio;

  while (i < texto.length) {
    while (i < texto.length && /\s/.test(texto[i])) i++;
    if (texto[i] === ";") return { tuplas, fim: i + 1 };
    if (texto[i] === ",") {
      i++;
      continue;
    }
    if (texto[i] !== "(") return { tuplas, fim: i };

    i++; // abre parêntese
    const valores: ValorSql[] = [];
    let atual = "";
    let dentroDeAspas = false;
    // Se este valor veio entre aspas. É o que separa NULL (ausência de valor)
    // de 'NULL' (a palavra), e o número 0 do texto "0". Um aluno chamado
    // "Null" existe, e um CPF anotado como texto também.
    let ehTexto = false;
    let fechou = false;

    while (i < texto.length) {
      const c = texto[i];

      if (dentroDeAspas) {
        if (c === "\\") {
          const proximo = texto[i + 1];
          atual += ESCAPES[proximo] ?? proximo;
          i += 2;
          continue;
        }
        if (c === "'") {
          // Duas aspas seguidas dentro de um texto são uma aspa literal, não o
          // fim do valor.
          if (texto[i + 1] === "'") {
            atual += "'";
            i += 2;
            continue;
          }
          dentroDeAspas = false;
          i++;
          continue;
        }
        atual += c;
        i++;
        continue;
      }

      if (c === "'") {
        dentroDeAspas = true;
        ehTexto = true;
        i++;
        continue;
      }
      if (c === "," || c === ")") {
        valores.push(ehTexto ? atual : interpretar(atual));
        atual = "";
        ehTexto = false;
        i++;
        if (c === ")") {
          fechou = true;
          break;
        }
        continue;
      }
      atual += c;
      i++;
    }

    if (!fechou) {
      throw new DumpInvalidoError(
        `Tabela ${tabela}: o arquivo termina no meio de uma linha. Dump truncado?`,
      );
    }
    tuplas.push(valores);
  }

  throw new DumpInvalidoError(
    `Tabela ${tabela}: o INSERT não fecha com ponto e vírgula. Dump truncado?`,
  );
}

/**
 * Converte um valor NÃO entre aspas no tipo certo: número, NULL ou palavra
 * solta. O que veio entre aspas nem passa por aqui — é texto por definição.
 */
function interpretar(bruto: string): ValorSql {
  const limpo = bruto.trim();
  if (limpo === "" || limpo.toUpperCase() === "NULL") return null;
  if (/^-?\d+(\.\d+)?$/.test(limpo)) return Number(limpo);
  return limpo;
}

/** Texto, ou null. Vazio vira null: no MySQL da escola os dois convivem. */
export function texto(v: ValorSql): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Inteiro, ou null. */
export function inteiro(v: ValorSql): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Número decimal, ou null.
 *
 * O MySQL escreve DECIMAL sempre com ponto e sem separador de milhar
 * ("112.90"), então não há vírgula a tratar. Se um dia vier uma, é erro de
 * origem, e aparecer como null é melhor do que virar um valor cem vezes menor.
 */
export function decimal(v: ValorSql): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Data do MySQL para Date.
 *
 * Aceita "AAAA-MM-DD" e "AAAA-MM-DD hh:mm:ss". Monta em UTC pelos componentes,
 * em vez de deixar o `new Date(texto)` decidir: a string sem fuso é
 * interpretada como hora local, e a data de nascimento de metade dos alunos
 * andaria um dia para trás dependendo de onde o servidor roda.
 */
export function data(v: ValorSql): Date | null {
  const s = texto(v);
  if (!s) return null;

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;

  const [, ano, mes, dia, hora, minuto, segundo] = m;
  // '0000-00-00' é o "sem data" do MySQL antigo e não é uma data.
  if (ano === "0000") return null;

  return new Date(
    Date.UTC(
      Number(ano),
      Number(mes) - 1,
      Number(dia),
      Number(hora ?? 0),
      Number(minuto ?? 0),
      Number(segundo ?? 0),
    ),
  );
}
