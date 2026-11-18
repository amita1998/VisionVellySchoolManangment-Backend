#!/usr/bin/env node
/**
 * DESTRUCTIVE — development only.
 * Drops and recreates the public schema, then re-runs migrations and the seed.
 * Refuses to run when NODE_ENV=production.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { BACKEND_ROOT, config } from '../src/config/env.js';

if (config.isProduction) {
  console.error('[db:reset] refused: NODE_ENV=production');
  process.exit(1);
}

const client = await pool.connect();
try {
  console.log('[db:reset] dropping schema public');
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
} finally {
  client.release();
  await pool.end();
}

const node = process.execPath;
for (const script of ['migrate.js', 'seed.js']) {
  console.log(`[db:reset] running ${script}`);
  execFileSync(node, [path.join(BACKEND_ROOT, 'scripts', script)], { stdio: 'inherit' });
}
