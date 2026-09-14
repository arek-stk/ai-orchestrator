import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ConcurrentModificationError } from '@orch/core';
import { NotFoundError } from '@orch/db';
import { registerAuth } from './auth';
import type { Container } from './container';
import { registerRoutes } from './routes';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(container: Container, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ? { level: container.config.env === 'production' ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: container.config.env === 'production',
  });

  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof ConcurrentModificationError) return reply.code(409).send({ error: 'the resource was modified concurrently; retry' });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: (error as Error).message });
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'internal server error' });
  });

  registerAuth(app, container);
  await registerRoutes(app, container);
  return app;
}
