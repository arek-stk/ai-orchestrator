import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
/** Driver-independent database type: both node-postgres and PGlite databases extend PgDatabase. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  db: Db;
  kind: 'postgres' | 'pglite';
  migrate(): Promise<void>;
  close(): Promise<void>;
  /**
   * PostgreSQL only: LISTEN on a channel with a dedicated connection (multi-instance event fan-out, ADR-024).
   * `onError` fires when the connection is lost; the returned function stops listening and releases it.
   */
  listen?(channel: string, onPayload: (payload: string | undefined) => void, onError: (error: unknown) => void): Promise<() => Promise<void>>;
  notify?(channel: string, payload: string): Promise<void>;
}

const CHANNEL_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

function assertChannel(channel: string): void {
  // Channel names are identifiers in LISTEN and cannot be bound as parameters.
  if (!CHANNEL_PATTERN.test(channel)) throw new Error(`invalid channel name: ${channel}`);
}

export interface DatabaseOptions {
  /** PostgreSQL connection string. When absent, embedded PGlite is used (ADR-002). */
  url?: string | null;
  /** PGlite data directory. null/undefined → in-memory (tests). */
  dataDir?: string | null;
  poolSize?: number;
  migrationsFolder?: string;
}

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function createDatabase(options: DatabaseOptions = {}): Promise<DatabaseHandle> {
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;

  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: options.poolSize ?? 10 });
    const db = drizzlePg({ client: pool, schema });
    return {
      db: db as unknown as Db,
      kind: 'postgres',
      migrate: () => migratePg(db, { migrationsFolder }),
      close: () => pool.end(),
      listen: async (channel, onPayload, onError) => {
        assertChannel(channel);
        const client = await pool.connect();
        let released = false;
        const onNotification = (message: pg.Notification) => {
          if (message.channel === channel) onPayload(message.payload);
        };
        const onClientError = (error: unknown) => onError(error);
        const onEnd = () => {
          if (!released) onError(new Error('listener connection ended'));
        };
        client.on('notification', onNotification);
        client.on('error', onClientError);
        client.on('end', onEnd);
        const release = async (destroy: boolean) => {
          if (released) return;
          released = true;
          client.off('notification', onNotification);
          client.off('end', onEnd);
          if (!destroy) await client.query(`UNLISTEN ${channel}`).catch(() => {});
          client.off('error', onClientError);
          client.release(true);
        };
        try {
          await client.query(`LISTEN ${channel}`);
        } catch (error) {
          await release(true);
          throw error;
        }
        return () => release(false);
      },
      notify: async (channel, payload) => {
        assertChannel(channel);
        await pool.query('select pg_notify($1, $2)', [channel, payload]);
      },
    };
  }

  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const client = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzlePglite({ client, schema });
  return {
    db: db as unknown as Db,
    kind: 'pglite',
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  };
}
