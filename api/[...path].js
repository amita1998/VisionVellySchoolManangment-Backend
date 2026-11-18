/**
 * Vercel serverless entry point (catch-all).
 *
 * On Vercel every file under `api/` becomes a function. This dynamic segment matches
 * `/api/<anything>` — including `/api/auth/login` — and hands the untouched request to the
 * same Express app the local server runs, so routing, the response envelope, CORS, cookies
 * and permissions behave exactly as they do in development.
 *
 * Local development keeps using `src/server.js`; this file is only used by the platform.
 */
import { createApp } from '../src/app.js';

const app = createApp();

export default app;
