import { redactSecrets } from '../security/secrets';
import { MAX_MESSAGE_LENGTH } from './types';

// Room content is untrusted (humans, model output, later external AIs). It is stored as plain text: control and
// invisible bidi characters are removed (they can hide or reorder text, "Trojan Source"), secrets are redacted and
// the length is bounded. Rendering never interprets HTML or Markdown.

// Single character classes only (linear time): C0 controls except tab and newline, DEL, C1 controls, zero-width
// characters, bidi embeddings/overrides/isolates, word joiner and BOM.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const CARRIAGE_RETURN = /\r\n?/g;
const EXCESS_BLANK_LINES = /\n{4,}/g;
const WHITESPACE_RUN = /\s+/g;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  // Avoid leaving half of a surrogate pair at the cut.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}\u2026`;
}

/** Sanitises a message body: strips invisible characters, redacts secrets, trims and bounds the length. */
export function sanitizeMessageBody(raw: string, max = MAX_MESSAGE_LENGTH): string {
  // Bound the work done by the redaction patterns before running them.
  const bounded = raw.length > max * 2 ? raw.slice(0, max * 2) : raw;
  // Invisible characters go first so they cannot split a secret and hide it from redaction.
  const visible = bounded.replace(CARRIAGE_RETURN, '\n').replace(INVISIBLE, '');
  const redacted = redactSecrets(visible).replace(EXCESS_BLANK_LINES, '\n\n\n').trim();
  return clip(redacted, max);
}

/** Single-line variant for names, titles and short summaries embedded in notices. */
export function sanitizeInline(raw: string, max: number): string {
  const bounded = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  return clip(redactSecrets(bounded.replace(INVISIBLE, '')).replace(WHITESPACE_RUN, ' ').trim(), max);
}
