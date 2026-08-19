import pg from "pg";
import { config } from "./config.js";

let pool;

/** Render instances have one connection string for the whole instance; the app
 *  always lives in its own dedicated database (`config.appDatabase`). */
export function appDatabaseUrl() {
  if (!config.databaseUrl) return config.databaseUrl;
  const url = new URL(config.databaseUrl);
  url.pathname = "/" + config.appDatabase;
  return url.toString();
}

/** Connection string for bootstrapping against an existing database on the same host. */
export function swapDatabase(url, db) {
  const u = new URL(url);
  u.pathname = "/" + db;
  return u.toString();
}

export function sslFor(url) {
  return url && !url.includes("localhost") ? { rejectUnauthorized: false } : undefined;
}

export function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: appDatabaseUrl(),
    max: config.isProd ? 5 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslFor(appDatabaseUrl())
  });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
