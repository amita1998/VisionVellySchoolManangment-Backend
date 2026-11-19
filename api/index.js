/**
 * Vercel serverless entry point.
 *
 * `vercel.json` rewrites every /api/* request here (any depth) and Vercel keeps the
 * original path in `req.url`, so the same Express app that `server.js` runs locally
 * answers on the platform — same routes, envelope, CORS, cookies and permissions.
 */
import { createApp } from '../src/app.js';

const app = createApp();

export default app;
