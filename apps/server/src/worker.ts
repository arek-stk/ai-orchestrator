import { randomUUID } from 'node:crypto';
import { ConcurrentModificationError, PIPELINE_STEP_JOB } from '@orch/core';
import { expireApprovals } from './approval-expiry';
import type { Container } from './container';

export interface WorkerLogger {
  info(details: object, message?: string): void;
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface WorkerPoolOptions {
  concurrency: number;
  schedulerIntervalMs: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  log?: WorkerLogger;
}

const silent: WorkerLogger = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Job workers + scheduler tick (ADR-004). Each worker claims pipeline steps with a lease, extends the lease
 * while a long agent call is running and releases the job afterwards. A crashed process simply lets the
 * lease expire; another worker resumes the run from its checkpoint.
 */
export class WorkerPool {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private scheduler: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private readonly log: WorkerLogger;

  constructor(
    private readonly container: Container,
    private readonly options: WorkerPoolOptions,
  ) {
    this.log = options.log ?? silent;
  }

  start(): void {
    this.stopping = false;
    this.loops = Array.from({ length: this.options.concurrency }, (_, index) => this.loop(`${this.id}-${index}`));
    this.scheduler = setInterval(() => void this.tick(), this.options.schedulerIntervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.scheduler) clearInterval(this.scheduler);
    await Promise.all(this.loops);
  }

  /** Runs one scheduler tick (skipped when the previous tick is still running). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.container.orchestrator.tick();
      if (result.started.length > 0 || result.recovered > 0) this.log.info(result, 'scheduler tick');
      await this.container.admin.sessions.deleteExpired(this.container.clock.now());
      const expired = await expireApprovals(this.container, this.log);
      if (expired > 0) this.log.info({ expired }, 'approvals expired');
    } catch (error) {
      this.log.error({ err: error }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Processes due jobs until none are claimable. Used by tests and one-off maintenance. */
  async drain(maxJobs = 500): Promise<number> {
    let processed = 0;
    while (processed < maxJobs && (await this.processNext(`${this.id}-drain`))) processed++;
    return processed;
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.stopping) {
      try {
        const worked = await this.processNext(workerId);
        if (!worked) await sleep(this.options.pollIntervalMs ?? 1_000);
      } catch (error) {
        this.log.error({ err: error, workerId }, 'worker loop error');
        await sleep(this.options.pollIntervalMs ?? 1_000);
      }
    }
  }

  private async processNext(workerId: string): Promise<boolean> {
    const leaseMs = this.options.leaseMs ?? 15 * 60_000;
    const [job] = await this.container.queue.claim(workerId, { types: [PIPELINE_STEP_JOB], leaseMs });
    if (!job) return false;

    const heartbeat = setInterval(() => void this.container.queue.extendLease(job.id, workerId, leaseMs), leaseMs / 3);
    try {
      const runId = String(job.payload.runId ?? '');
      const result = await this.container.orchestrator.step(runId);
      await this.container.queue.complete(job.id, workerId);
      this.container.metrics.workerJobs.inc({ type: job.type, outcome: 'succeeded' });
      if (result.next === 'done') this.log.info({ runId, status: result.status }, 'run finished');
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        // Another worker already advanced this run; its own follow-up job carries on.
        await this.container.queue.complete(job.id, workerId);
        this.container.metrics.workerJobs.inc({ type: job.type, outcome: 'superseded' });
      } else {
        this.log.error({ err: error, jobId: job.id }, 'pipeline step failed');
        const status = await this.container.queue.fail(job.id, workerId, error instanceof Error ? error.message : String(error));
        this.container.metrics.workerJobs.inc({ type: job.type, outcome: status === 'dead' ? 'dead' : 'retried' });
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
