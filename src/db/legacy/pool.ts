import mysql from "mysql2/promise";
import { env, legadoConfigurado } from "../../config/env.js";

// Conexao isolada e SOMENTE LEITURA com o MySQL do sistema Laravel.
//
// Regras desta camada:
//   1. O usuario MySQL (LEGACY_MYSQL_USER) deve ter apenas GRANT SELECT.
//   2. Nenhum outro modulo importa `mysql2` direto — tudo que le do sistema
//      antigo passa por um repository daqui, para que a integracao inteira
//      possa ser desligada sem tocar no resto do Hub.
//   3. `readOnlyQuery` recusa qualquer statement que nao comece com SELECT,
//      como segunda camada alem da permissao do usuario no banco.
//
// A instancia do pool e criada preguicosamente: se o legado nao estiver
// configurado, nem chega a existir socket aberto.

let pool: mysql.Pool | null = null;

export class LegadoIndisponivelError extends Error {
  constructor() {
    super("Conexao com o sistema Laravel nao configurada (LEGACY_MYSQL_*).");
  }
}

function obterPool(): mysql.Pool {
  if (!legadoConfigurado) throw new LegadoIndisponivelError();
  if (!pool) {
    pool = mysql.createPool({
      host: env.LEGACY_MYSQL_HOST,
      port: env.LEGACY_MYSQL_PORT,
      user: env.LEGACY_MYSQL_USER,
      password: env.LEGACY_MYSQL_PASSWORD,
      database: env.LEGACY_MYSQL_DATABASE,
      connectionLimit: 5,
      namedPlaceholders: true,
      timezone: "Z",
      // Sem isto, DECIMAL(10,2) volta como string e todo calculo de valor
      // precisa de Number() no consumidor.
      decimalNumbers: true,
    });
  }
  return pool;
}

export async function readOnlyQuery<T>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith("SELECT")) {
    throw new Error("Bloqueado: apenas SELECT e permitido na conexao com o sistema Laravel.");
  }

  const [rows] = await obterPool().query(sql, params as never);
  return rows as T[];
}

export async function encerrarPoolLegado(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
