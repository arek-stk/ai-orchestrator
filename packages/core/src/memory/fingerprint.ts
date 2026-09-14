import { createHash } from 'node:crypto';

const SIGNAL = /(error|fail|failed|failing|expected|received|assert|exception|panic|TS\d{3,5}|cannot|undefined is not|not a function)/i;
const MAX_LINES = 12;

/**
 * Normalises failure output so that the same underlying failure produces the same text across runs:
 * timestamps, durations, line/column numbers, absolute path prefixes, hex addresses and plain numbers
 * are removed.
 */
export function normalizeFailure(text: string): string {
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
        .replace(/\(\d+(?:\.\d+)?\s?m?s\)/g, '')
        .replace(/\b\d+(?:\.\d+)?\s?m?s\b/g, '<dur>')
        .replace(/0x[0-9a-f]+/gi, '<hex>')
        .replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s:()'"]+)+[\\/]([^\\/\s:()'"]+)/g, '$1')
        .replace(/:\d+:\d+/g, '')
        .replace(/\b\d+\b/g, 'N')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0);

  const signal = lines.filter((line) => SIGNAL.test(line));
  return (signal.length > 0 ? signal : lines).slice(0, MAX_LINES).join('\n');
}

/** Stable short identifier for a failure, used by Failure Memory to detect repeated mistakes. */
export function failureFingerprint(text: string): string {
  return createHash('sha256').update(normalizeFailure(text)).digest('hex').slice(0, 16);
}
