import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { USER_ROLES, type UserRole } from '@orch/core';
import type { SessionUser } from '@orch/db';
import type { Container } from './container';
import { hashToken, newToken, signValue, verifySignedValue } from './crypto';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = 'orch_session';
const STATE_COOKIE = 'orch_oauth_state';

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function hasRole(user: SessionUser | null, minimum: UserRole): boolean {
  return user !== null && ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

/** preHandler: 401 without a session, 403 when the role is too low. */
export function requireRole(minimum: UserRole) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.code(401).send({ error: 'authentication required' });
    if (!hasRole(request.user, minimum)) return reply.code(403).send({ error: `requires the ${minimum} role` });
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Session resolution, CSRF protection and authentication routes (ADR-007).
 * Registered on the root instance so hooks apply to every route.
 */
export function registerAuth(app: FastifyInstance, container: Container): void {
  const { config, admin } = container;
  const secureCookies = config.env === 'production';

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? await admin.sessions.findUser(hashToken(token), container.clock.now()) : null;
  });

  // CSRF: cookie-authenticated state changes must come from the web app's origin. Webhooks authenticate by HMAC.
  const allowedOrigins = new Set([config.appOrigin, config.serverOrigin]);
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING.has(request.method) || request.url.startsWith('/api/webhooks/')) return;
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'cross-origin request rejected' });
    }
  });

  const startSession = async (request: FastifyRequest, reply: FastifyReply, userId: string) => {
    const token = newToken();
    await admin.sessions.create({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(container.clock.now().getTime() + config.sessionTtlMs),
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    await admin.audit.record({ actorType: 'user', actorId: userId, action: 'auth.login', target: null, ip: request.ip });
  };

  const authRateLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/api/auth/me', async (request) => ({
    user: request.user,
    methods: { github: Boolean(config.github.clientId && config.github.clientSecret), dev: config.devLoginEnabled },
  }));

  app.post('/api/auth/dev-login', authRateLimit, async (request, reply) => {
    if (!config.devLoginEnabled) return reply.code(404).send({ error: 'not found' });
    const { login } = z.object({ login: z.string().regex(/^[a-zA-Z0-9-]{2,39}$/) }).parse(request.body);
    const user = await admin.users.upsertDevUser(login);
    await startSession(request, reply, user.id);
    return { user: { id: user.id, login: user.login, role: user.role } };
  });

  app.get('/api/auth/github/login', authRateLimit, async (_request, reply) => {
    const { clientId } = config.github;
    if (!clientId || !config.github.clientSecret) return reply.code(503).send({ error: 'GitHub login is not configured' });
    const state = newToken(24);
    reply.setCookie(STATE_COOKIE, signValue(config.encryptionKey, state), { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/api/auth/github', maxAge: 600 });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', `${config.appOrigin}/api/auth/github/callback`);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/github/callback', authRateLimit, async (request, reply) => {
    const { clientId, clientSecret } = config.github;
    if (!clientId || !clientSecret) return reply.code(503).send({ error: 'GitHub login is not configured' });
    const query = z.object({ code: z.string().min(1).max(200), state: z.string().min(1).max(200) }).safeParse(request.query);
    const cookie = request.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/github' });
    if (!query.success || !cookie || verifySignedValue(config.encryptionKey, cookie) !== query.data.state) {
      return reply.code(400).send({ error: 'invalid OAuth state' });
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: query.data.code, redirect_uri: `${config.appOrigin}/api/auth/github/callback` }),
    });
    const tokenBody = z.object({ access_token: z.string() }).safeParse(await tokenResponse.json());
    if (!tokenResponse.ok || !tokenBody.success) return reply.code(502).send({ error: 'GitHub token exchange failed' });

    const profileResponse = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${tokenBody.data.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'ai-orchestrator' },
    });
    const profile = z
      .object({ id: z.number().int(), login: z.string(), name: z.string().nullable(), email: z.string().nullable(), avatar_url: z.string().nullable() })
      .safeParse(await profileResponse.json());
    if (!profileResponse.ok || !profile.success) return reply.code(502).send({ error: 'could not load the GitHub profile' });

    const user = await admin.users.upsertGithubUser({
      githubId: profile.data.id,
      login: profile.data.login,
      name: profile.data.name,
      email: profile.data.email,
      avatarUrl: profile.data.avatar_url,
    });
    await startSession(request, reply, user.id);
    return reply.redirect(config.appOrigin);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await admin.sessions.delete(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (request.user) await admin.audit.record({ actorType: 'user', actorId: request.user.id, action: 'auth.logout', target: null, ip: request.ip });
    return { ok: true };
  });

  app.get('/api/users', { preHandler: requireRole('admin') }, async () => ({
    users: (await admin.users.list()).map((u) => ({ id: u.id, login: u.login, name: u.name, avatarUrl: u.avatarUrl, role: u.role, lastLoginAt: u.lastLoginAt })),
  }));

  app.patch('/api/users/:id/role', { preHandler: requireRole('owner') }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { role } = z.object({ role: z.enum(USER_ROLES) }).parse(request.body);
    if (id === request.user!.id && role !== 'owner') return reply.code(400).send({ error: 'owners cannot demote themselves' });
    const user = await admin.users.setRole(id, role);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    if (role === 'viewer') await admin.sessions.deleteForUser(id);
    await admin.audit.record({ actorType: 'user', actorId: request.user!.id, action: 'user.role', target: id, details: { role }, ip: request.ip });
    return { user: { id: user.id, login: user.login, role: user.role } };
  });
}
