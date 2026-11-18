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

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'vvs-api',
});

pool.on('error', (error) => {
  console.error('[db] idle client error', error);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction; rolls back on any throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  const { rows } = await pool.query(
    "select current_database() as database, now() at time zone 'Asia/Kolkata' as server_time",
  );
  return rows[0];
}

export default pool;
