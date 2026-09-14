// Dependency-free Prometheus text exposition (format 0.0.4). Label sets are bounded per metric so a
// misbehaving client (e.g. random URLs) cannot grow memory without limit.

export type Labels = Record<string, string>;

const MAX_SERIES_PER_METRIC = 2_000;
const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`).join(',')}}`;
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function seriesKey(labels: Labels): string {
  return formatLabels(labels);
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {
    if (!NAME_PATTERN.test(name)) throw new Error(`invalid metric name: ${name}`);
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): string[];
}

class ScalarMetric extends Metric {
  protected readonly series = new Map<string, { labels: Labels; value: number }>();

  protected entry(labels: Labels): { labels: Labels; value: number } | null {
    const key = seriesKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) return null;
      entry = { labels: { ...labels }, value: 0 };
      this.series.set(key, entry);
    }
    return entry;
  }

  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = this.header();
    for (const { labels, value } of this.series.values()) lines.push(`${this.name}${formatLabels(labels)} ${formatValue(value)}`);
    return lines;
  }
}

export class Counter extends ScalarMetric {
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new Error('counters only increase');
    const entry = this.entry(labels);
    if (entry) entry.value += amount;
  }
}

export class Gauge extends ScalarMetric {
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }

  set(labels: Labels, value: number): void {
    const entry = this.entry(labels);
    if (entry) entry.value = value;
  }

  /** Replaces every series (used for values collected on scrape, so vanished label values disappear). */
  replaceAll(values: ReadonlyArray<{ labels: Labels; value: number }>): void {
    this.series.clear();
    for (const { labels, value } of values) this.set(labels, value);
  }
}

export const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class Histogram extends Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    private readonly buckets: readonly number[] = DEFAULT_DURATION_BUCKETS,
  ) {
    super(name, help, 'histogram');
  }

  observe(labels: Labels, value: number): void {
    const key = seriesKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) return;
      entry = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) entry.counts[i]!++;
    entry.sum += value;
    entry.count++;
  }

  count(labels: Labels): number {
    return this.series.get(seriesKey(labels))?.count ?? 0;
  }

  render(): string[] {
    const lines = this.header();
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bucket, i) => lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: formatValue(bucket) })} ${counts[i]}`));
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${formatValue(sum)}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  private register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) throw new Error(`metric ${metric.name} is already registered`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string): Counter {
    return this.register(new Counter(name, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.register(new Gauge(name, help));
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.register(new Histogram(name, help, buckets));
  }

  render(): string {
    return `${[...this.metrics.values()].flatMap((metric) => metric.render()).join('\n')}\n`;
  }
}

/** Metrics shared by the HTTP layer, workers and background maintenance. */
export interface ServerMetrics {
  registry: MetricsRegistry;
  httpRequests: Counter;
  httpDuration: Histogram;
  workerJobs: Counter;
  approvalsExpired: Counter;
  fanoutEvents: Counter;
  runs: Gauge;
  jobs: Gauge;
  activeAgentRuns: Gauge;
  pendingApprovals: Gauge;
  costTodayUsd: Gauge;
  tokensToday: Gauge;
  modelCallsToday: Gauge;
  processResidentMemory: Gauge;
  processHeapUsed: Gauge;
  processUptime: Gauge;
}

export function createServerMetrics(): ServerMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    httpRequests: registry.counter('orch_http_requests_total', 'HTTP requests by method, route template and status code.'),
    httpDuration: registry.histogram('orch_http_request_duration_seconds', 'HTTP request duration by method, route template and status code.'),
    workerJobs: registry.counter('orch_worker_jobs_total', 'Pipeline step jobs processed by workers of this process, by outcome.'),
    approvalsExpired: registry.counter('orch_approvals_expired_total', 'Pending approvals expired by this process.'),
    fanoutEvents: registry.counter('orch_event_fanout_total', 'Events received through the multi-instance fan-out, by result.'),
    runs: registry.gauge('orch_pipeline_runs', 'Pipeline runs by status.'),
    jobs: registry.gauge('orch_jobs', 'Durable queue jobs by status (queue depth).'),
    activeAgentRuns: registry.gauge('orch_agent_runs_active', 'Agent runs currently running.'),
    pendingApprovals: registry.gauge('orch_approvals_pending', 'Approvals waiting for a human decision.'),
    costTodayUsd: registry.gauge('orch_cost_today_usd', 'Model spend since 00:00 UTC in USD.'),
    tokensToday: registry.gauge('orch_tokens_today', 'Model tokens (input, output, cache) since 00:00 UTC.'),
    modelCallsToday: registry.gauge('orch_model_calls_today', 'Model calls since 00:00 UTC.'),
    processResidentMemory: registry.gauge('orch_process_resident_memory_bytes', 'Resident set size of the server process.'),
    processHeapUsed: registry.gauge('orch_process_heap_used_bytes', 'V8 heap used by the server process.'),
    processUptime: registry.gauge('orch_process_uptime_seconds', 'Uptime of the server process.'),
  };
}
