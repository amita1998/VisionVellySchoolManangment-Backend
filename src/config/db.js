import pg from 'pg';
import { config } from './env.js';

/**
 * DATE -> keep the raw 'YYYY-MM-DD' string.
 * If node-postgres parses a DATE into a JS Date at local midnight, toISOString()
 * shifts the day backwards for IST (+05:30) and attendance/dues land on the wrong day.
 * Never construct Date objects out of DATE columns anywhere in this codebase.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// TIMESTAMP without time zone is not used by this schema; keep it raw as well.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value) => value);
// NUMERIC stays a string on purpose: money must never pass through a float.

const isServerless = Boolean(process.env.VERCEL);

/**
 * On Vercel the instance is frozen between requests, while Neon's pooler closes the idle
 * sockets behind it. A query that lands on one of those sockets never gets an answer, so the
 * function sits there until the platform kills it — the 504 FUNCTION_INVOCATION_TIMEOUT users
 * see. Three settings prevent that:
 *
 *  - idleTimeoutMillis 5s + allowExitOnIdle: on the platform, clients are recycled long before
 *    they can go stale, and the pool stops holding the event loop open;
 *  - queryTimeoutMs / statement_timeout: if a socket still goes silent, the query fails in
 *    seconds with a logged error (500) instead of hanging for the 300s runtime limit;
 *  - keepAlive: keeps the TCP connection healthy while the instance is warm.
 *
 * Locally the defaults stay friendlier (30s idle) but the timeouts apply as well.
 */
export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: isServerless ? 5_000 : 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: isServerless,
  keepAlive: true,
  query_timeout: config.db.queryTimeoutMs,
  statement_timeout: config.db.queryTimeoutMs,
  application_name: 'vvs-api',
});

pool.on('error', (error) => {
  console.error('[db] idle client error', error.code || '', error.message);
});

/** Errors that mean "the socket died", never "the statement was rejected". */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);

export function isConnectionError(error) {
  if (!error) return false;
  if (CONNECTION_ERROR_CODES.has(error.code)) return true;
  return /Connection terminated|connection error|socket hang up/i.test(error.message || '');
}

/** A statement that only reads is safe to repeat; anything else must not be retried blindly. */
const READ_ONLY = /^\s*(select|with)\b/i;

export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (error) {
    if (!isConnectionError(error) || !READ_ONLY.test(text)) throw error;
    console.warn('[db] retrying a read after a connection error:', error.code || error.message);
    return pool.query(text, params);
  }
}

/** Run `fn` inside a transaction; rolls back on any throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  let connectionDied = null;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (isConnectionError(error)) connectionDied = error;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      connectionDied = connectionDied || rollbackError;
      console.error('[db] rollback failed', rollbackError.code || rollbackError.message);
    }
    throw error;
  } finally {
    /**
     * Releasing a dead client with no error puts the broken socket back into the pool and the
     * next query handed to it hangs. Passing the error makes pg destroy the client instead.
     */
    if (connectionDied) client.release(connectionDied);
    else client.release();
  }
}

export async function healthCheck() {
  const { rows } = await pool.query(
    "select current_database() as database, now() at time zone 'Asia/Kolkata' as server_time",
  );
  /**
   * The host is echoed back so an operator can see WHICH database the running deployment is
   * actually talking to — two Neon projects look identical from the database name alone.
   * Only the hostname leaves the process; the credentials never do.
   */
  let host = null;
  try {
    host = new URL(process.env.DATABASE_URL).hostname;
  } catch {
    host = null;
  }
  return { ...rows[0], host };
}

export default pool;
