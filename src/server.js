import { createApp } from './app.js';
import { config } from './config/env.js';
import { pool } from './config/db.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[api] ${config.appName} listening on http://localhost:${config.port}`);
  console.log(`[api] environment=${config.nodeEnv} timezone=${config.timezone}`);
});

async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
