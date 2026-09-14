import { randomBytes } from 'node:crypto';
import { z } from 'zod';
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
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Pick<ServerConfig, 'inMemoryDatabase' | 'demoLatencyMs'>> = {},
): ServerConfig {
  const parsed = EnvSchema.parse(env);
  const production = parsed.NODE_ENV === 'production';
  const inMemoryDatabase = overrides.inMemoryDatabase ?? false;

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
  };
}
