import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createContainer, type Container } from './container';
import { MetricsRegistry } from './metrics';

const ORIGIN = 'http://localhost:3000';
const METRICS_TOKEN = 'scrape-token-0123456789abcdef';

let container: Container;
let app: FastifyInstance;
let logApp: FastifyInstance;
const logLines: string[] = [];

async function login(name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev-login', headers: { origin: ORIGIN }, payload: { login: name } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!;
}

beforeAll(async () => {
  const config = loadConfig(
    { NODE_ENV: 'test', ALLOW_DEV_LOGIN: 'true', APP_ORIGIN: ORIGIN, METRICS_TOKEN, ORCH_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') },
    { inMemoryDatabase: true, demoLatencyMs: 0 },
  );
  container = await createContainer(config);
  app = await buildApp(container);
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(...String(chunk).split('\n').filter(Boolean));
      callback();
    },
  });
  logApp = await buildApp(container, { logStream: stream });
});

afterAll(async () => {
  await app.close();
  await logApp.close();
  await container.close();
});

describe('Prometheus registry', () => {
  it('renders counters, gauges and histograms in the text exposition format', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('demo_requests_total', 'Requests.\nSecond line');
    counter.inc({ route: '/a"b\\c' });
    counter.inc({ route: '/a"b\\c' }, 2);
    registry.gauge('demo_depth', 'Depth.').replaceAll([{ labels: { status: 'queued' }, value: 4 }]);
    registry.histogram('demo_seconds', 'Durations.', [0.1, 1]).observe({ route: '/x' }, 0.5);

    const text = registry.render();
    expect(text).toContain('# HELP demo_requests_total Requests.\\nSecond line');
    expect(text).toContain('# TYPE demo_requests_total counter');
    expect(text).toContain('demo_requests_total{route="/a\\"b\\\\c"} 3');
    expect(text).toContain('demo_depth{status="queued"} 4');
    expect(text).toContain('demo_seconds_bucket{le="0.1",route="/x"} 0');
    expect(text).toContain('demo_seconds_bucket{le="1",route="/x"} 1');
    expect(text).toContain('demo_seconds_bucket{le="+Inf",route="/x"} 1');
    expect(text).toContain('demo_seconds_count{route="/x"} 1');
    expect(text.endsWith('\n')).toBe(true);
    expect(() => registry.counter('demo_depth', 'dup')).toThrow(/already registered/);
    expect(() => counter.inc({}, -1)).toThrow();
    expect(() => registry.gauge('bad-name', 'x')).toThrow(/invalid metric name/);
  });
});

describe('GET /api/metrics', () => {
  it('requires a bearer token or an admin session', async () => {
    expect((await app.inject({ url: '/api/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/metrics', headers: { authorization: 'Bearer wrong-token-0123456789abcdef' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/metrics', headers: { authorization: METRICS_TOKEN } })).statusCode).toBe(401);

    const ownerCookie = await login('metrics-owner');
    const operatorCookie = await login('metrics-operator');
    expect((await app.inject({ url: '/api/metrics', headers: { cookie: operatorCookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/metrics', headers: { cookie: ownerCookie } })).statusCode).toBe(200);
  });

  it('exposes operational gauges and HTTP request counters by route template', async () => {
    await app.inject({ url: '/api/health' });
    await app.inject({ url: '/api/tasks/tsk_missing' }); // 401, recorded under the route template
    const response = await app.inject({ url: '/api/metrics', headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain; version=0.0.4');
    const body = response.body;
    expect(body).toContain('orch_pipeline_runs{status="QUEUED"} 0');
    expect(body).toContain('orch_jobs{status="queued"} 0');
    expect(body).toContain('orch_agent_runs_active 0');
    expect(body).toContain('orch_approvals_pending 0');
    expect(body).toMatch(/orch_cost_today_usd \d/);
    expect(body).toMatch(/orch_tokens_today \d/);
    expect(body).toContain('orch_http_requests_total{method="GET",route="/api/health",status="200"} 1');
    expect(body).toContain('orch_http_requests_total{method="GET",route="/api/tasks/:id",status="401"} 1');
    expect(body).toContain('orch_http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/api/health",status="200"} 1');
    expect(body).not.toContain('tsk_missing');
  });
});

describe('request ids and log redaction', () => {
  it('echoes a well-formed inbound request id and generates one otherwise', async () => {
    const echoed = await app.inject({ url: '/api/health', headers: { 'x-request-id': 'edge-proxy-1234abcd' } });
    expect(echoed.headers['x-request-id']).toBe('edge-proxy-1234abcd');
    const generated = await app.inject({ url: '/api/health', headers: { 'x-request-id': 'bad id with spaces\n' } });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs request ids and redacts secrets', async () => {
    await logApp.inject({ url: '/api/health', headers: { 'x-request-id': 'trace-abcdef123456', authorization: 'Bearer secret-bearer-value' } });
    logApp.log.info({ provider: { apiKey: 'plain-provider-key-value', name: 'visible' }, oauth: { clientSecret: 'plain-client-secret' } }, 'provider saved');
    logApp.log.error({ err: new Error('upstream rejected sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123') }, 'call failed');

    const text = logLines.join('\n');
    expect(text).toContain('"reqId":"trace-abcdef123456"');
    expect(text).toContain('"name":"visible"');
    expect(text).not.toContain('plain-provider-key-value');
    expect(text).not.toContain('plain-client-secret');
    expect(text).not.toContain('secret-bearer-value');
    expect(text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
    expect(text).toContain('[REDACTED:anthropic_api_key]');
  });
});
