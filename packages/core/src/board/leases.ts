import { z } from 'zod';

// Leases (ADR-030): a holder (person, external AI, orchestrator) claims a task or a set of path globs for a bounded
// time, so two actors do not change the same work concurrently. Pure rules; persistence behind LeaseRepository.

export const LEASE_HOLDER_TYPES = ['user', 'external_ai', 'orchestrator'] as const;
export type LeaseHolderType = (typeof LEASE_HOLDER_TYPES)[number];

export const LEASE_SCOPES = ['task', 'paths'] as const;
export type LeaseScope = (typeof LEASE_SCOPES)[number];

export type LeaseEndReason = 'released' | 'broken' | 'expired';

export const DEFAULT_LEASE_TTL_MS = 30 * 60_000;
export const MIN_LEASE_TTL_MS = 5 * 60_000;
/** Leases never block others indefinitely: heartbeats extend a lease up to this age at most. */
export const MAX_LEASE_DURATION_MS = 8 * 60 * 60_000;
export const MAX_LEASE_GLOBS = 20;
export const MAX_GLOB_LENGTH = 300;
/** Active leases per project (bounded conflict checks). */
export const MAX_ACTIVE_LEASES_PER_PROJECT = 200;

export interface Lease {
  id: string;
  projectId: string;
  holderType: LeaseHolderType;
  holderId: string;
  holderName: string;
  scope: LeaseScope;
  taskId: string | null;
  /** Normalised globs (`*` within a segment, `**` across segments); empty for task leases. */
  pathGlobs: string[];
  reason: string;
  expiresAt: Date;
  heartbeatAt: Date;
  createdAt: Date;
  releasedAt: Date | null;
  releasedBy: string | null;
  endReason: LeaseEndReason | null;
}

export interface NewLease {
  projectId: string;
  holderType: LeaseHolderType;
  holderId: string;
  holderName: string;
  scope: LeaseScope;
  taskId: string | null;
  pathGlobs: string[];
  reason: string;
  expiresAt: Date;
}

export interface LeaseFilter {
  projectId?: string;
  scope?: LeaseScope;
  taskId?: string;
  limit?: number;
}

export type AcquireResult = { lease: Lease; conflicts: [] } | { lease: null; conflicts: Lease[] };

export interface LeaseRepository {
  /** Atomically checks `findLeaseConflicts` against the project's active leases and inserts the lease when none conflict. */
  acquire(input: NewLease, now: Date): Promise<AcquireResult>;
  get(id: string): Promise<Lease | null>;
  /** Unreleased leases that have not expired at `now`. */
  listActive(filter: LeaseFilter, now: Date): Promise<Lease[]>;
  /** Extends an active lease; null when it was released or has expired. */
  heartbeat(id: string, expiresAt: Date, now: Date): Promise<Lease | null>;
  /** Ends an unreleased lease; null when it was already ended (so callers emit exactly one event). */
  end(id: string, by: string, reason: LeaseEndReason, now: Date): Promise<Lease | null>;
  /** Unreleased leases whose expiry has passed, oldest first. */
  listExpired(now: Date, limit: number): Promise<Lease[]>;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/**
 * Normalises a repository-relative glob; null when it is unsafe or unsupported. Supported wildcards are `*` (within a
 * segment) and `**` (any number of segments). Absolute paths, `..`, backslashes, control characters, `?`, `[]` and
 * `{}` are rejected.
 */
export function normalizeLeaseGlob(raw: string): string | null {
  const glob = raw.trim();
  if (glob.length === 0 || glob.length > MAX_GLOB_LENGTH) return null;
  for (const char of glob) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || '\\?[]{}'.includes(char)) return null;
  }
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob)) return null;
  const segments = glob.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  // `a**b` is ambiguous; `**` must be a whole segment.
  if (segments.some((segment) => segment !== '**' && segment.includes('**'))) return null;
  // Collapse repeated `**` segments.
  const collapsed = segments.filter((segment, i) => !(segment === '**' && segments[i - 1] === '**'));
  return collapsed.join('/');
}

export const LeaseGlobsSchema = z
  .array(z.string().max(MAX_GLOB_LENGTH))
  .min(1)
  .max(MAX_LEASE_GLOBS)
  .transform((globs, ctx) => {
    const normalized: string[] = [];
    for (const glob of globs) {
      const value = normalizeLeaseGlob(glob);
      if (!value) {
        ctx.addIssue({ code: 'custom', message: `unsupported path glob: ${glob.slice(0, 80)}` });
        return z.NEVER;
      }
      if (!normalized.includes(value)) normalized.push(value);
    }
    return normalized;
  });

/**
 * Whether a segment pattern with `*` matches a literal segment. Iterative greedy matching with one backtrack point:
 * O(pattern × text) worst case, no regular expressions.
 */
export function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Whether two segment patterns can match a common segment. Conservative (may report overlap) when both use `*`. */
function segmentsOverlap(a: string, b: string): boolean {
  const aWild = a.includes('*');
  const bWild = b.includes('*');
  if (!aWild && !bWild) return a === b;
  if (!aWild) return segmentMatches(b, a);
  if (!bWild) return segmentMatches(a, b);
  const aPrefix = a.slice(0, a.indexOf('*'));
  const bPrefix = b.slice(0, b.indexOf('*'));
  const aSuffix = a.slice(a.lastIndexOf('*') + 1);
  const bSuffix = b.slice(b.lastIndexOf('*') + 1);
  const prefixesCompatible = aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
  const suffixesCompatible = aSuffix.endsWith(bSuffix) || bSuffix.endsWith(aSuffix);
  return prefixesCompatible && suffixesCompatible;
}

/**
 * Whether two normalised globs (or a glob and a plain path) can match a common path. Dynamic programming over segment
 * positions with memoisation: at most (segments of a + 1) × (segments of b + 1) states.
 */
export function globsOverlap(a: string, b: string): boolean {
  const left = a.split('/');
  const right = b.split('/');
  const memo = new Map<number, boolean>();
  const width = right.length + 1;
  const visit = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === left.length && j === right.length) result = true;
    else if (i < left.length && left[i] === '**') result = visit(i + 1, j) || (j < right.length && visit(i, j + 1));
    else if (j < right.length && right[j] === '**') result = visit(i, j + 1) || (i < left.length && visit(i + 1, j));
    else if (i === left.length || j === right.length) result = false;
    else result = segmentsOverlap(left[i]!, right[j]!) && visit(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

// ---------------------------------------------------------------------------
// Conflicts and expiry
// ---------------------------------------------------------------------------

export function isLeaseActive(lease: Pick<Lease, 'releasedAt' | 'expiresAt'>, now: Date): boolean {
  return lease.releasedAt === null && lease.expiresAt.getTime() > now.getTime();
}

const sameHolder = (a: Pick<Lease, 'holderType' | 'holderId'>, b: Pick<Lease, 'holderType' | 'holderId'>) => a.holderType === b.holderType && a.holderId === b.holderId;

export type LeaseRequest = Pick<NewLease, 'holderType' | 'holderId' | 'scope' | 'taskId' | 'pathGlobs'>;

/** Active leases of other holders that conflict with the request (same task, or overlapping path globs). */
export function findLeaseConflicts(leases: readonly Lease[], request: LeaseRequest, now: Date): Lease[] {
  return leases.filter((lease) => {
    if (!isLeaseActive(lease, now) || sameHolder(lease, request) || lease.scope !== request.scope) return false;
    if (request.scope === 'task') return lease.taskId !== null && lease.taskId === request.taskId;
    return lease.pathGlobs.some((held) => request.pathGlobs.some((wanted) => globsOverlap(held, wanted)));
  });
}

/** Path leases of other holder types (for the pipeline: people and external AIs) that cover at least one changed path. */
export function pathLeaseConflicts(leases: readonly Lease[], changedPaths: readonly string[], holderType: LeaseHolderType, now: Date): Array<{ lease: Lease; paths: string[] }> {
  const conflicts: Array<{ lease: Lease; paths: string[] }> = [];
  for (const lease of leases) {
    if (lease.scope !== 'paths' || !isLeaseActive(lease, now) || lease.holderType === holderType) continue;
    const paths = changedPaths.filter((path) => lease.pathGlobs.some((glob) => globsOverlap(glob, path)));
    if (paths.length > 0) conflicts.push({ lease, paths });
  }
  return conflicts;
}

/** Task ids that have an active task lease of a holder other than the orchestrator. */
export function foreignTaskLeases(leases: readonly Lease[], now: Date): Set<string> {
  const ids = new Set<string>();
  for (const lease of leases) {
    if (lease.scope === 'task' && lease.taskId && lease.holderType !== 'orchestrator' && isLeaseActive(lease, now)) ids.add(lease.taskId);
  }
  return ids;
}

/** Expiry for a new lease or heartbeat: `ttl` from now, never beyond the maximum lease duration. */
export function leaseExpiry(now: Date, ttlMs: number, createdAt: Date = now): Date {
  const ttl = Math.min(Math.max(ttlMs, MIN_LEASE_TTL_MS), MAX_LEASE_DURATION_MS);
  return new Date(Math.min(now.getTime() + ttl, createdAt.getTime() + MAX_LEASE_DURATION_MS));
}
