import type { Decision } from '../domain/records';

// Rung (a) of the decision ladder (docs/plans/autopilot.md §3.3): deterministic precedent retrieval over accepted ADRs,
// docs/STATE.md and decision memory, plus the quote verification every later rung reuses. Everything here is pure.
// Repository text (ADRs, STATE) and decision text are untrusted: they are only ever matched, quoted and delimited.

export const DECISIONS_DOC_PATH = 'docs/DECISIONS.md';
export const STATE_DOC_PATH = 'docs/STATE.md';

/** Upper bound for a governance document that is parsed at all (bounded work on hostile input). */
export const MAX_PRECEDENT_DOC_CHARS = 400_000;
const MAX_SECTION_CHARS = 20_000;
const MAX_ADRS = 300;
/** Quotes shorter than this prove nothing ("the", "use it"). */
export const MIN_QUOTE_CHARS = 12;
export const MAX_QUOTE_CHARS = 600;

export type AdrStatus = 'accepted' | 'proposed' | 'superseded' | 'deprecated' | 'unknown';

export interface AdrSection {
  /** Normalised id, e.g. "ADR-034". */
  id: string;
  title: string;
  status: AdrStatus;
  /** The section including addenda, bounded. */
  text: string;
}

export type PrecedentKind = 'adr' | 'state' | 'decision';

export interface Precedent {
  /** "adr:ADR-034", "state:docs/STATE.md" or "decision:dec_…". */
  ref: string;
  kind: PrecedentKind;
  title: string;
  text: string;
  /** Only accepted ADRs, confirmed/active decisions and the STATE document may settle or block a question. */
  authoritative: boolean;
}

const ADR_HEADING = /^##\s+ADR-(\d{1,4})\b\s*[—–-]?\s*(.*)$/;
const ADDENDUM_HEADING = /^###\s+ADR-(\d{1,4})\s+addendum\b/i;

function adrId(digits: string): string {
  return `ADR-${digits.padStart(3, '0')}`;
}

function statusOf(section: string): AdrStatus {
  // The status line is "* **Status:** Accepted (date)"; the first status line of the section wins.
  for (const line of section.split('\n')) {
    const index = line.indexOf('**Status:**');
    if (index === -1) continue;
    const value = line.slice(index + '**Status:**'.length).trim().toLowerCase();
    if (value.startsWith('accepted')) return 'accepted';
    if (value.startsWith('proposed')) return 'proposed';
    if (value.startsWith('superseded')) return 'superseded';
    if (value.startsWith('deprecated')) return 'deprecated';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Splits `docs/DECISIONS.md` into ADR sections. A `### ADR-NNN addendum` belongs to its ADR even when it appears later
 * in the file. Line based and linear; oversized documents are truncated first.
 */
export function parseAdrSections(markdown: string): AdrSection[] {
  const lines = markdown.slice(0, MAX_PRECEDENT_DOC_CHARS).replace(/\r\n?/g, '\n').split('\n');
  const sections = new Map<string, { title: string; lines: string[] }>();
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = ADR_HEADING.exec(line);
    if (heading) {
      const id = adrId(heading[1]!);
      current = sections.get(id) ?? { title: heading[2]!.trim(), lines: [] };
      sections.set(id, current);
      current.lines.push(line);
      continue;
    }
    const addendum = ADDENDUM_HEADING.exec(line);
    if (addendum) {
      const id = adrId(addendum[1]!);
      current = sections.get(id) ?? { title: `${id} addendum`, lines: [] };
      sections.set(id, current);
      current.lines.push(line);
      continue;
    }
    if (line.startsWith('## ')) {
      current = null;
      continue;
    }
    if (current && current.lines.length < 2_000) current.lines.push(line);
  }
  return [...sections.entries()].slice(0, MAX_ADRS).map(([id, section]) => {
    const text = section.lines.join('\n').slice(0, MAX_SECTION_CHARS);
    return { id, title: section.title.slice(0, 200), status: statusOf(text), text };
  });
}

/** Whitespace- and case-insensitive substring match; the quote must be long enough to mean something. */
export function quoteAppearsIn(text: string, quote: string | null | undefined): boolean {
  if (!quote) return false;
  const needle = normalizeForQuote(quote);
  if (needle.length < MIN_QUOTE_CHARS || needle.length > MAX_QUOTE_CHARS) return false;
  return normalizeForQuote(text).includes(needle);
}

function normalizeForQuote(text: string): string {
  // Markdown emphasis and backticks are ignored so a quote of "**Status:** Accepted" matches "Status: Accepted".
  return text.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from has have how in is it its of on or should that the this to use used we what when where which who will with without would which should could into than then there these those via per not no yes our your their them they you i'.split(
    ' ',
  ),
);

/** Lower-case word tokens (≥ 3 chars, no stopwords), bounded. */
export function keywords(text: string, max = 400): Set<string> {
  const result = new Set<string>();
  for (const raw of text.slice(0, 50_000).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    result.add(raw);
    if (result.size >= max) break;
  }
  return result;
}

export interface PrecedentCorpus {
  adrs: readonly AdrSection[];
  stateDoc: string | null;
  decisions: readonly Decision[];
}

/** Turns the raw sources into precedents. Rejected decisions are dropped entirely. */
export function buildPrecedents(corpus: PrecedentCorpus): Precedent[] {
  const precedents: Precedent[] = corpus.adrs.map((adr) => ({
    ref: `adr:${adr.id}`,
    kind: 'adr' as const,
    title: `${adr.id} — ${adr.title} (${adr.status})`,
    text: adr.text,
    authoritative: adr.status === 'accepted',
  }));
  if (corpus.stateDoc) {
    precedents.push({ ref: `state:${STATE_DOC_PATH}`, kind: 'state', title: 'docs/STATE.md', text: corpus.stateDoc.slice(0, MAX_SECTION_CHARS), authoritative: true });
  }
  for (const decision of corpus.decisions) {
    if (decision.status === 'rejected') continue;
    precedents.push({
      ref: `decision:${decision.id}`,
      kind: 'decision',
      title: `Decision ${decision.id} (${decision.status})`,
      text: `Question: ${decision.question}\nDecision: ${decision.decision}\nReason: ${decision.reason}`.slice(0, 4_000),
      // A provisional decision is itself unconfirmed: it may inform, but never settle, a new question.
      authoritative: decision.status === 'active' || decision.status === 'confirmed',
    });
  }
  return precedents;
}

export interface RankedPrecedent extends Precedent {
  score: number;
}

/**
 * Deterministic keyword-overlap retrieval: score = shared keywords / question keywords, ties broken by ref. Superseded
 * ADRs are kept (a question may touch them) but never outrank an accepted one with the same score.
 */
export function retrievePrecedents(question: string, precedents: readonly Precedent[], limit = 5, minScore = 0.2): RankedPrecedent[] {
  const wanted = keywords(question, 60);
  if (wanted.size === 0) return [];
  return precedents
    .map((precedent) => {
      const have = keywords(`${precedent.title}\n${precedent.text}`);
      let shared = 0;
      for (const word of wanted) if (have.has(word)) shared++;
      return { ...precedent, score: Math.round((shared / wanted.size) * 1000) / 1000 };
    })
    .filter((p) => p.score >= minScore)
    .sort((a, b) => b.score - a.score || Number(b.authoritative) - Number(a.authoritative) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .slice(0, limit);
}

/**
 * Deterministic consistency check on a proposed answer: councils and agents never change ADRs (they are governance, a
 * human decision). An answer that proposes superseding, replacing, revising or ignoring an ADR is always parked.
 */
export function proposesAdrChange(text: string): string | null {
  const lower = text.slice(0, 20_000).toLowerCase();
  // "adr", "adrs", "adr-034", "decisions.md" as whole words; a simple, non-backtracking pattern.
  const mentions = /\b(?:adrs?|adr-\d{1,4}|decisions\.md)\b/g;
  for (const match of lower.matchAll(mentions)) {
    const index = match.index ?? 0;
    const window = lower.slice(Math.max(0, index - 80), index + 80);
    for (const verb of ['supersede', 'replace', 'revise', 'overturn', 'ignore', 'deviate from', 'amend', 'rewrite', 'delete']) {
      if (window.includes(verb)) return `the answer proposes to ${verb} an ADR`;
    }
  }
  return null;
}
