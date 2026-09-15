import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer } from './container';
import { seedDemoData } from './seed';
import { WorkerPool } from './worker';

// Load the repository-level .env (Node's built-in loader; no dotenv dependency).
for (const candidate of [fileURLToPath(new URL('../../../.env', import.meta.url)), '.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const config = loadConfig();
const container = await createContainer(config);
const seeded = await seedDemoData(container);
const app = await buildApp(container, { logger: true });

let workers: WorkerPool | null = null;
if (config.role !== 'worker') await app.listen({ port: config.port, host: config.host });
if (config.role !== 'api') {
  // Restart recovery: sessions resume from the database; effective autonomy is never persisted, so nothing to repair.
  const recovered = await container.autopilot.recover();
  if (recovered.resumed > 0 || recovered.stopped > 0) app.log.info(recovered, 'autopilot sessions recovered');
  workers = new WorkerPool(container, { concurrency: config.workerConcurrency, schedulerIntervalMs: config.schedulerIntervalMs, log: app.log });
  workers.start();
}

app.log.info(
  {
    role: config.role,
    database: container.db.kind,
    demoMode: container.demoMode(),
    seededDemoData: seeded,
    github: container.githubKind,
    sandbox: container.sandbox.available ? 'docker' : 'none',
  },
  'AI orchestrator started',
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await workers?.stop();
  await app.close();
  await container.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
