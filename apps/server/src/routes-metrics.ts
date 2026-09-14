import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RUN_STATUSES } from '@orch/core';
import { hasRole } from './auth';
import type { Container } from './container';
import { hashToken } from './crypto';

function bearerMatches(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  // Compare fixed-length digests so neither content nor length leaks through timing.
  return timingSafeEqual(Buffer.from(hashToken(header.slice(7)), 'hex'), Buffer.from(hashToken(token), 'hex'));
}

/** Refreshes the gauges that are read from the database on every scrape. */
export async function collectMetrics(container: Container): Promise<void> {
  const { metrics, queue, admin } = container;
  const [runs, jobs, activeAgents, pendingApprovals, today] = await Promise.all([
    admin.ops.runsByStatus(),
    queue.stats(),
    admin.ops.activeAgentRuns(),
    admin.ops.pendingApprovals(),
    admin.stats.summary(container.startOfDay()),
  ]);
  metrics.runs.replaceAll(RUN_STATUSES.map((status) => ({ labels: { status }, value: runs[status] ?? 0 })));
  metrics.jobs.replaceAll(Object.entries(jobs).map(([status, value]) => ({ labels: { status }, value })));
  metrics.activeAgentRuns.set({}, activeAgents);
  metrics.pendingApprovals.set({}, pendingApprovals);
  metrics.costTodayUsd.set({}, today.costUsd);
  metrics.tokensToday.set({}, today.tokens);
  metrics.modelCallsToday.set({}, today.calls);
  const memory = process.memoryUsage();
  metrics.processResidentMemory.set({}, memory.rss);
  metrics.processHeapUsed.set({}, memory.heapUsed);
  metrics.processUptime.set({}, Math.round(process.uptime()));
}

/**
 * Prometheus scrape endpoint (ADR-021). With METRICS_TOKEN set, a matching bearer token grants access (for
 * scrapers); an admin session always works. Everything else is rejected.
 */
export async function registerMetricsRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { metricsToken } = container.config;

  app.get('/api/metrics', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const tokenOk = metricsToken !== null && bearerMatches(request, metricsToken);
    if (!tokenOk) {
      if (!request.user) return reply.code(401).header('www-authenticate', 'Bearer realm="metrics"').send({ error: 'authentication required' });
      if (!hasRole(request.user, 'admin')) return reply.code(403).send({ error: 'requires the admin role' });
    }
    await collectMetrics(container);
    return reply.header('cache-control', 'no-store').type('text/plain; version=0.0.4; charset=utf-8').send(container.metrics.registry.render());
  });
}
