import type { EvidenceItem } from '../agents/schemas';
import type { Decision } from '../domain/records';
import { sanitizeMessageBody } from '../room/content';
import { normalizeRepoPath, UnsafePathError } from '../security/paths';
import { quoteAppearsIn, type AdrSection } from './precedents';

// Deterministic evidence verification for the decision ladder and the council (docs/plans/autopilot.md §4.4 step 4).
// A model's citation is a claim about the repository; the orchestrator checks it against the index at the base commit,
// the parsed ADRs, decision memory and executed checks. Nothing a model writes is taken as fact.

export type EvidenceStatus = 'verified' | 'unverified' | 'refuted';

export interface VerifiedEvidence extends EvidenceItem {
  /** Deterministic id (by position), referenced by votes ("changedBecause") and the synthesis. */
  id: string;
  status: EvidenceStatus;
  detail: string;
  /** For check evidence: the executed result. */
  passed?: boolean;
}

export interface CheckResult {
  /** Check name, e.g. "test" or "typecheck". */
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvidenceSources {
  /** Paths in the repository index at the run's base commit. */
  indexPaths: ReadonlySet<string>;
  /** File content at the base commit (never the run's staged change set); null when missing. */
  readFile(path: string): Promise<string | null>;
  adrs: ReadonlyMap<string, AdrSection>;
  decisions: ReadonlyMap<string, Decision>;
  stateDoc: string | null;
  /** Checks executed for this decision (experiments) or recorded CI results. */
  checks: ReadonlyMap<string, CheckResult>;
}

export const MAX_EVIDENCE_PER_BATCH = 40;
const MAX_FILE_CHARS = 400_000;

/** "ADR-34", "adr-034", "ADR 34" → "ADR-034"; null when it does not look like an ADR id. */
export function normalizeAdrRef(ref: string): string | null {
  const match = /^\s*adr[-\s]?(\d{1,4})\s*$/i.exec(ref.replace(/^adr:/i, ''));
  return match ? `ADR-${match[1]!.padStart(3, '0')}` : null;
}

/** File contents are loaded at most once per batch and bounded. */
export function cachedReader(read: (path: string) => Promise<string | null>): (path: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (path) => {
    let pending = cache.get(path);
    if (!pending) {
      pending = read(path).then((content) => (content === null ? null : content.slice(0, MAX_FILE_CHARS)));
      cache.set(path, pending);
    }
    return pending;
  };
}

async function verifyOne(item: EvidenceItem, sources: EvidenceSources, read: (path: string) => Promise<string | null>): Promise<Pick<VerifiedEvidence, 'status' | 'detail' | 'passed'>> {
  switch (item.type) {
    case 'file': {
      let path: string;
      try {
        path = normalizeRepoPath(item.ref);
      } catch (error) {
        return { status: 'refuted', detail: error instanceof UnsafePathError ? error.message : 'invalid path' };
      }
      if (!sources.indexPaths.has(path)) return { status: 'unverified', detail: `path ${path} is not in the repository index` };
      if (!item.quote) return { status: 'unverified', detail: 'file evidence without a quote' };
      const content = await read(path);
      if (content === null) return { status: 'unverified', detail: `path ${path} could not be read` };
      return quoteAppearsIn(content, item.quote) ? { status: 'verified', detail: `quote found in ${path}` } : { status: 'refuted', detail: `quote not found in ${path}` };
    }
    case 'adr': {
      const id = normalizeAdrRef(item.ref);
      const adr = id ? sources.adrs.get(id) : undefined;
      if (!adr) return { status: 'unverified', detail: `${item.ref} does not exist` };
      if (adr.status !== 'accepted') return { status: 'unverified', detail: `${adr.id} is ${adr.status}, not accepted` };
      if (!item.quote) return { status: 'unverified', detail: 'ADR evidence without a quote' };
      return quoteAppearsIn(adr.text, item.quote) ? { status: 'verified', detail: `quote found in ${adr.id}` } : { status: 'refuted', detail: `quote not found in ${adr.id}` };
    }
    case 'decision': {
      const decision = sources.decisions.get(item.ref.replace(/^decision:/, '').trim());
      if (!decision) return { status: 'unverified', detail: `decision ${item.ref} does not exist` };
      if (decision.status === 'rejected') return { status: 'unverified', detail: `decision ${decision.id} was rejected by a human` };
      if (decision.status === 'provisional') return { status: 'unverified', detail: `decision ${decision.id} is still provisional` };
      const text = `${decision.question}\n${decision.decision}\n${decision.reason}`;
      return quoteAppearsIn(text, item.quote) ? { status: 'verified', detail: `quote found in decision ${decision.id}` } : { status: 'refuted', detail: `quote not found in decision ${decision.id}` };
    }
    case 'state': {
      if (!sources.stateDoc) return { status: 'unverified', detail: 'no state document' };
      return quoteAppearsIn(sources.stateDoc, item.quote) ? { status: 'verified', detail: 'quote found in docs/STATE.md' } : { status: 'refuted', detail: 'quote not found in docs/STATE.md' };
    }
    case 'check': {
      const check = sources.checks.get(item.ref.trim().toLowerCase());
      if (!check) return { status: 'unverified', detail: `check ${item.ref} was not executed` };
      return { status: 'verified', detail: `check ${check.name} ${check.passed ? 'passed' : 'failed'}: ${check.detail}`.slice(0, 300), passed: check.passed };
    }
  }
}

/**
 * Verifies evidence items in order. Items beyond the batch bound are reported unverified (never silently trusted).
 * `refuted` means the citation is checkably false (quote absent, unsafe path): it discredits the claim it supports.
 */
export async function verifyEvidence(
  items: ReadonlyArray<{ id: string; item: EvidenceItem }>,
  sources: EvidenceSources,
): Promise<VerifiedEvidence[]> {
  const read = cachedReader(sources.readFile);
  const results: VerifiedEvidence[] = [];
  for (const [index, { id, item }] of items.entries()) {
    const quote = item.quote === null ? null : sanitizeMessageBody(item.quote, 600);
    const bounded = { type: item.type, ref: item.ref.slice(0, 300), quote };
    if (index >= MAX_EVIDENCE_PER_BATCH) {
      results.push({ ...bounded, id, status: 'unverified', detail: 'evidence limit per step reached' });
      continue;
    }
    results.push({ ...bounded, id, ...(await verifyOne(item, sources, read)) });
  }
  return results;
}
