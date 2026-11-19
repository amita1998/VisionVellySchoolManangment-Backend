import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { config } from './config/env.js';
import { healthCheck } from './config/db.js';
import { AppError } from './utils/errors.js';
import apiRoutes from './routes/index.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      /**
       * A project can be reached through more than one vercel.app alias (the short
       * `<project>-<suffix>` form and the `<project>-<team>` form). CLIENT_ORIGIN therefore
       * accepts a comma-separated list; an origin that is not on it gets no CORS headers,
       * which the browser blocks. Same-origin/no-Origin requests (server-to-server, curl)
       * are always allowed.
       */
      origin(origin, callback) {
        const allowed = config.clientOrigin
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (!origin || allowed.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  if (!config.isTest) app.use(morgan('dev'));

  // Single response envelope used by every endpoint: { success, data } or { success, error }.
  app.get('/api/health', async (_req, res, next) => {
    try {
      const db = await healthCheck();
      res.json({
        success: true,
        data: { status: 'ok', name: config.appName, environment: config.nodeEnv, database: db },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Connectivity probe for the bare API host (`https://<backend>/` and `/api`).
   * Opening the deployment URL in a browser should say the service is up instead of the
   * generic 404 envelope — that 404 is what reads as "backend connect nahi hua".
   * Deliberately not the app envelope: this shape is the one people paste into a status check.
   */
  app.get(['/', '/api'], async (_req, res) => {
    try {
      await healthCheck();
      res.json({ ok: true, service: config.statusService, status: 'running' });
    } catch (error) {
      console.error('[api] status probe failed', error.code || error.message);
      res.status(503).json({ ok: false, service: config.statusService, status: 'database unreachable' });
    }
  });

  app.use('/api', apiRoutes);

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
    });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((error, _req, res, _next) => {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('[api] unhandled error', error);

    const body = {
      success: false,
      error: {
        code: error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
        /**
         * 5xx messages are masked in production so an unexpected stack/DB error never leaks.
         * An AppError is ours and written for the person reading it (e.g. UPLOADS_UNAVAILABLE,
         * "storage is not configured on this deployment"), so its message is shown as-is;
         * masking it produces "Something went wrong" for a problem the user can act on.
         */
        message:
          status >= 500 && !config.isProduction
            ? error.message
            : status >= 500 && !(error instanceof AppError)
              ? 'Something went wrong. Please try again.'
              : error.message,
      },
    };
    if (error.fields) body.error.fields = error.fields;
    if (error.details !== undefined) body.error.details = error.details;

    res.status(status).json(body);
  });

  return app;
}

export default createApp;
