import { randomUUID } from 'node:crypto';
import { redactSecrets } from '@orch/core';

export const REQUEST_ID_HEADER = 'x-request-id';

const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a well-formed inbound request id (from a proxy or client) so logs correlate; otherwise generates one. */
export function requestIdFrom(header: unknown): string {
  return typeof header === 'string' && VALID_REQUEST_ID.test(header) ? header : randomUUID();
}

/** pino redaction: credentials in headers and secret-like fields anywhere one level below the log object. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  '*.apiKey',
  '*.apiKeyEncrypted',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.password',
  '*.secret',
  '*.clientSecret',
  '*.client_secret',
  '*.webhookSecret',
];

interface SerializedError {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

/** Error serializer that strips secret-looking values (provider keys, tokens) from messages and stacks. */
export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { type: typeof error, message: redactSecrets(String(error)), stack: '' };
  const code = (error as { code?: unknown }).code;
  return {
    type: error.name,
    message: redactSecrets(error.message),
    stack: redactSecrets(error.stack ?? ''),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

export interface LogDestination {
  write(message: string): void;
}

export function loggerOptions(env: 'development' | 'test' | 'production', stream?: LogDestination) {
  return {
    level: env === 'production' ? ('info' as const) : ('debug' as const),
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { err: serializeError },
    ...(stream ? { stream } : {}),
  };
}
