/**
 * Vercel serverless entry point for the bare `/api` path.
 * Anything deeper is handled by `api/[...path].js`.
 */
import { createApp } from '../src/app.js';

const app = createApp();

export default app;
