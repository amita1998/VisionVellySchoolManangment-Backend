#!/usr/bin/env node
/**
 * Versioned migration runner.
 * - Applies backend/migrations/*.sql in filename order, each in its own transaction.
 * - Records a sha256 checksum per file; editing an applied migration is refused.
 * - Serialises concurrent runs with a Postgres advisory lock.
 *
 * Usage: npm run migrate | npm run migrate:status
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from '../src/config/db.js';
import { BACKEND_ROOT } from '../src/config/env.js';

const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'migrations');
const LOCK_KEY = 728190001;

async function listFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries.filter((file) => file.endsWith('.sql')).sort();
}

async function readChecksum(file) {
  const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  return { sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
}

export async function runMigrations({ silent = false } = {}) {
  const log = silent ? () => {} : console.log;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = await listFiles();
    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

    let appliedNow = 0;
    for (const file of files) {
      const { sql, checksum } = await readChecksum(file);
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after it was applied. Never edit an applied migration — ` +
              'add a new one instead.',
          );
        }
        continue;
      }
      const started = Date.now();
      log(`[migrate] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        error.message = `Migration ${file} failed: ${error.message}`;
        throw error;
      }
      log(`[migrate] applied ${file} (${Date.now() - started} ms)`);
      appliedNow += 1;
    }

    log(`[migrate] database=${new URL(process.env.DATABASE_URL).pathname.slice(1)} files=${files.length} applied_now=${appliedNow}`);
    return { total: files.length, appliedNow };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function migrationStatus() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const files = await listFiles();
    const { rows } = await client.query('SELECT filename, applied_at FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.filename, row.applied_at]));
    for (const file of files) {
      const when = applied.get(file);
      console.log(`${when ? 'applied' : 'PENDING'}  ${file}${when ? `  ${when.toISOString()}` : ''}`);
    }
    console.log(`${files.length} migrations, ${files.length - applied.size} pending`);
  } finally {
    client.release();
  }
}

const isEntryPoint = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isEntryPoint) {
  const statusOnly = process.argv.includes('--status');
  try {
    if (statusOnly) await migrationStatus();
    else await runMigrations();
  } catch (error) {
    console.error(`[migrate] ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

export { fileURLToPath };
