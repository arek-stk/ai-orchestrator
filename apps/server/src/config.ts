import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AutopilotLimits } from '@orch/core';
import { loadOrCreateDevKey, parseEncryptionKey } from './crypto';

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : null));

const flag = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  SERVER_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: optionalString,
  DATA_DIR: z.string().default('.data'),
  ORCH_ENCRYPTION_KEY: optionalString,
  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 90).default(168),
  ALLOW_DEV_LOGIN: flag,
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,
  GITHUB_TOKEN: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  GOOGLE_API_KEY: optionalString,
  OPENAI_COMPATIBLE_BASE_URL: optionalString,
  OPENAI_COMPATIBLE_API_KEY: optionalString,
  GLOBAL_DAILY_BUDGET_USD: z.coerce.number().min(0).default(25),
  SANDBOX: z.enum(['docker', 'none']).default('none'),
  SANDBOX_EGRESS_NETWORK: optionalString,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  DEMO_LATENCY_MS: z.coerce.number().int().min(0).max(30_000).default(600),
  PROJECT_ACL: z.enum(['enforced', 'off']).optional(),
  METRICS_TOKEN: optionalString,
  APPROVAL_TTL_HOURS: z.coerce.number().min(0).max(24 * 365).default(72),
  MIGRATIONS_DIR: optionalString,
  EVENT_FANOUT: z.enum(['auto', 'off']).default('auto'),
  // Autopilot / away mode (ADR-034). Off by default in production.
  AUTOPILOT_ENABLED: z.enum(['true', 'false', '1', '0']).optional(),
  AUTOPILOT_MAX_HOURS: z.coerce.number().positive().max(24 * 14).default(72),
  AUTOPILOT_MAX_BUDGET_USD: z.coerce.number().positive().max(10_000).default(50),
  AUTOPILOT_MAX_AUTONOMY: z.coerce.number().int().min(0).max(3).default(3),
  AUTOPILOT_RETURN_GRACE_HOURS: z.coerce.number().min(0).max(24 * 14).default(48),
  AUTOPILOT_MAX_APPROVAL_DAYS: z.coerce.number().positive().max(90).default(14),
  AUTOPILOT_MAX_USD_PER_HOUR: z.coerce.number().positive().max(10_000).default(10),
});

export interface ServerConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  role: 'all' | 'api' | 'worker';
  appOrigin: string;
  serverOrigin: string;
  databaseUrl: string | null;
  dataDir: string;
  inMemoryDatabase: boolean;
  encryptionKey: Buffer;
  sessionTtlMs: number;
  devLoginEnabled: boolean;
  github: { clientId: string | null; clientSecret: string | null; webhookSecret: string | null; token: string | null };
  providers: {
    anthropicApiKey: string | null;
    openaiApiKey: string | null;
    googleApiKey: string | null;
    openaiCompatibleBaseUrl: string | null;
    openaiCompatibleApiKey: string | null;
  };
  globalDailyBudgetUsd: number;
  sandbox: 'docker' | 'none';
  /** Docker network with restricted egress used for dependency installation; null = installs are refused. */
  sandboxEgressNetwork: string | null;
  workerConcurrency: number;
  schedulerIntervalMs: number;
  demoLatencyMs: number;
  /** Per-project access control (ADR-022). */
  projectAcl: 'enforced' | 'off';
  /** Bearer token for /api/metrics scrapers; null = admin session only (ADR-021). */
  metricsToken: string | null;
  /** Pending approvals older than this expire; 0 disables expiry (ADR-023). */
  approvalTtlMs: number;
  /** Drizzle migrations folder override (production bundle, ADR-020). */
  migrationsDir: string | null;
  /** auto = LISTEN/NOTIFY fan-out on PostgreSQL, in-process bus on PGlite (ADR-024). */
  eventFanout: 'auto' | 'off';
  /** Autopilot / away mode bounds (ADR-034). */
  autopilot: AutopilotLimits;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Pick<ServerConfig, 'inMemoryDatabase' | 'demoLatencyMs'>> = {},
): ServerConfig {
  const parsed = EnvSchema.parse(env);
  const production = parsed.NODE_ENV === 'production';
  const inMemoryDatabase = overrides.inMemoryDatabase ?? false;

  if (parsed.METRICS_TOKEN && parsed.METRICS_TOKEN.length < 24) {
    throw new Error('METRICS_TOKEN must be at least 24 characters long.');
  }

  if (parsed.SERVER_ROLE !== 'all' && !parsed.DATABASE_URL) {
    throw new Error('SERVER_ROLE=api|worker requires DATABASE_URL: the embedded database is single-process (ADR-002).');
  }

  let encryptionKey: Buffer;
  if (parsed.ORCH_ENCRYPTION_KEY) encryptionKey = parseEncryptionKey(parsed.ORCH_ENCRYPTION_KEY);
  else if (production) throw new Error('ORCH_ENCRYPTION_KEY is required in production.');
  else encryptionKey = inMemoryDatabase ? randomBytes(32) : loadOrCreateDevKey(parsed.DATA_DIR);

  return {
    env: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    role: parsed.SERVER_ROLE,
    appOrigin: parsed.APP_ORIGIN.replace(/\/$/, ''),
    serverOrigin: `http://localhost:${parsed.PORT}`,
    databaseUrl: parsed.DATABASE_URL,
    dataDir: parsed.DATA_DIR,
    inMemoryDatabase,
    encryptionKey,
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1000,
    // Dev login is impossible in production, whatever the flag says (ADR-007).
    devLoginEnabled: !production && parsed.ALLOW_DEV_LOGIN,
    github: {
      clientId: parsed.GITHUB_CLIENT_ID,
      clientSecret: parsed.GITHUB_CLIENT_SECRET,
      webhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
      token: parsed.GITHUB_TOKEN,
    },
    providers: {
      anthropicApiKey: parsed.ANTHROPIC_API_KEY,
      openaiApiKey: parsed.OPENAI_API_KEY,
      googleApiKey: parsed.GOOGLE_API_KEY,
      openaiCompatibleBaseUrl: parsed.OPENAI_COMPATIBLE_BASE_URL,
      openaiCompatibleApiKey: parsed.OPENAI_COMPATIBLE_API_KEY,
    },
    globalDailyBudgetUsd: parsed.GLOBAL_DAILY_BUDGET_USD,
    sandbox: parsed.SANDBOX,
    sandboxEgressNetwork: parsed.SANDBOX_EGRESS_NETWORK,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    schedulerIntervalMs: parsed.SCHEDULER_INTERVAL_MS,
    demoLatencyMs: overrides.demoLatencyMs ?? parsed.DEMO_LATENCY_MS,
    // Enforced by default in production; development and tests keep the single-team demo simple.
    projectAcl: parsed.PROJECT_ACL ?? (production ? 'enforced' : 'off'),
    metricsToken: parsed.METRICS_TOKEN,
    approvalTtlMs: parsed.APPROVAL_TTL_HOURS * 60 * 60 * 1000,
    migrationsDir: parsed.MIGRATIONS_DIR,
    eventFanout: parsed.EVENT_FANOUT,
    autopilot: {
      // Unattended work is an explicit opt-in in production; development and the demo can start sessions right away.
      enabled: parsed.AUTOPILOT_ENABLED === undefined ? !production : parsed.AUTOPILOT_ENABLED === 'true' || parsed.AUTOPILOT_ENABLED === '1',
      maxHours: parsed.AUTOPILOT_MAX_HOURS,
      maxBudgetUsd: parsed.AUTOPILOT_MAX_BUDGET_USD,
      maxAutonomy: parsed.AUTOPILOT_MAX_AUTONOMY as AutopilotLimits['maxAutonomy'],
      returnGraceMs: parsed.AUTOPILOT_RETURN_GRACE_HOURS * 60 * 60 * 1000,
      maxApprovalLifetimeMs: parsed.AUTOPILOT_MAX_APPROVAL_DAYS * 24 * 60 * 60 * 1000,
      maxUsdPerHour: parsed.AUTOPILOT_MAX_USD_PER_HOUR,
    },
  };
}
