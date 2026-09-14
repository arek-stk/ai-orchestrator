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
