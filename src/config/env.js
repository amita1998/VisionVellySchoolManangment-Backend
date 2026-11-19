import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the backend/ folder — never derive paths from process.cwd(). */
export const BACKEND_ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy backend/.env.example to backend/.env and fill it in.`,
    );
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer.`);
  return parsed;
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int('PORT', 4001),
  appName: process.env.APP_NAME || 'Vision Valley School Management System',
  /** Name shown by the bare-host status probe. API_SERVICE_NAME overrides it. */
  statusService: process.env.API_SERVICE_NAME || 'EERMS API',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5174',
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  db: {
    url: required('DATABASE_URL'),
    poolMax: int('DB_POOL_MAX', 10),
    /**
     * A hung query must fail as a 500 we can log, not as a platform 504. Vercel kills the
     * function after 300s; both timeouts below are well under that.
     */
    queryTimeoutMs: int('DB_QUERY_TIMEOUT_MS', 10_000),
  },
  auth: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtlSeconds: int('ACCESS_TOKEN_TTL', 900),
    refreshTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 7),
    rememberMeTtlDays: int('REMEMBER_ME_TTL_DAYS', 30),
    bcryptRounds: int('BCRYPT_ROUNDS', 12),
    maxLoginAttempts: int('MAX_LOGIN_ATTEMPTS', 5),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
    /**
     * Same-origin deployments (api.school.com + app.school.com on the same eTLD+1, or a
     * proxy) keep `lax`. Two different vercel.app projects are *cross-site* — vercel.app is
     * on the public suffix list — so the refresh cookie must be `none` (which requires
     * `secure`, already on in production) or every reload logs the user out.
     */
    cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax').toLowerCase() === 'none' ? 'none' : 'lax',
  },
  uploads: {
    dir: path.resolve(BACKEND_ROOT, process.env.UPLOAD_DIR || 'storage/uploads'),
    maxMb: int('MAX_UPLOAD_MB', 5),
  },
  seed: {
    demo: (process.env.SEED_DEMO || 'false').toLowerCase() === 'true',
    demoPassword: process.env.DEMO_PASSWORD || '',
    adminEmail: process.env.ADMIN_EMAIL || '',
    adminName: process.env.ADMIN_NAME || 'Administrator',
    adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || '',
  },
};

export default config;
