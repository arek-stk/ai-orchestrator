// "Code" view: a canonical, readable JSON form of a definition and a tolerant parser that reports syntax errors with line
// and column. Schema and graph validation happen on the server (POST /api/workflows/validate) and are shown inline.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types';

const NODE_KEYS: Record<WorkflowNode['type'], string[]> = {
  goal: ['id', 'type', 'label', 'goal', 'position'],
  orchestrator: ['id', 'type', 'label', 'description', 'position'],
  agent: ['id', 'type', 'label', 'role', 'toolId', 'model', 'temperature', 'maxTokens', 'enabledTools', 'output', 'instructions', 'description', 'tags', 'position'],
  join: ['id', 'type', 'label', 'description', 'position'],
  finale: ['id', 'type', 'label', 'description', 'output', 'position'],
};

function ordered(node: WorkflowNode): Record<string, unknown> {
  const source = node as unknown as Record<string, unknown>;
  const keys = NODE_KEYS[node.type] ?? Object.keys(source);
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  // Unknown extra keys are kept at the end, so the server can report them instead of the client dropping them silently.
  for (const key of Object.keys(source)) if (!(key in out)) out[key] = source[key];
  return out;
}

/** Stable, human-friendly JSON: fixed key order per node type, two-space indentation. */
export function serializeDefinition(definition: WorkflowDefinition): string {
  const value = {
    schemaVersion: definition.schemaVersion,
    nodes: definition.nodes.map(ordered),
    edges: definition.edges.map((edge: WorkflowEdge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface CodeParseError {
  message: string;
  line: number | null;
  column: number | null;
}

export type CodeParseResult = { ok: true; value: unknown } | { ok: false; error: CodeParseError };

export const MAX_CODE_LENGTH = 400_000;

/** Line and column (1-based) of a character offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/** Reads the first integer after `marker` in an engine error message (no regular expressions). */
function numberAfter(message: string, marker: string): number | null {
  const index = message.indexOf(marker);
  if (index < 0) return null;
  let digits = '';
  for (let i = index + marker.length; i < message.length && digits.length < 9; i++) {
    const char = message[i]!;
    if (char >= '0' && char <= '9') digits += char;
    else if (digits.length > 0) break;
  }
  return digits ? Number(digits) : null;
}

/**
 * Offset of the first JSON syntax error, for engines whose error message has no position (V8 reports some errors only
 * as "Unexpected token"). A linear recursive-descent scan with bounded nesting; null when the text is valid.
 */
export function jsonErrorOffset(text: string): number | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return true;
    }
    return false;
  };
  const string = (): boolean => {
    if (text[i] !== '"') return false;
    i++;
    while (i < text.length) {
      const char = text[i]!;
      if (char === '"') {
        i++;
        return true;
      }
      if (char === '\\') i += 2;
      else if (char.charCodeAt(0) < 0x20) return false;
      else i++;
    }
    return false;
  };
  const number = (): boolean => {
    const start = i;
    if (text[i] === '-') i++;
    while (i < text.length && ((text[i]! >= '0' && text[i]! <= '9') || text[i] === '.' || text[i] === 'e' || text[i] === 'E' || text[i] === '+' || text[i] === '-')) i++;
    return i > start && text[i - 1] !== '-';
  };
  const value = (depth: number): boolean => {
    if (depth > 256) return false;
    ws();
    const char = text[i];
    if (char === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return true;
      }
      for (;;) {
        ws();
        if (!string()) return false;
        ws();
        if (text[i] !== ':') return false;
        i++;
        if (!value(depth + 1)) return false;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return true;
        }
        return false;
      }
    }
    if (char === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return true;
      }
      for (;;) {
        if (!value(depth + 1)) return false;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return true;
        }
        return false;
      }
    }
    if (char === '"') return string();
    if (char === 't') return literal('true');
    if (char === 'f') return literal('false');
    if (char === 'n') return literal('null');
    return number();
  };
  if (!value(0)) return Math.min(i, text.length);
  ws();
  return i < text.length ? i : null;
}

export function parseDefinitionText(text: string): CodeParseResult {
  if (text.length > MAX_CODE_LENGTH) return { ok: false, error: { message: `Der Code ist zu lang (höchstens ${MAX_CODE_LENGTH.toLocaleString('de-DE')} Zeichen).`, line: null, column: null } };
  if (text.trim().length === 0) return { ok: false, error: { message: 'Der Code ist leer.', line: null, column: null } };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: { message: 'Erwartet wird ein JSON-Objekt mit schemaVersion, nodes und edges.', line: 1, column: 1 } };
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
      return { ok: false, error: { message: '„nodes“ und „edges“ müssen Listen sein.', line: null, column: null } };
    }
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const explicitLine = numberAfter(message, 'line ');
    const explicitColumn = numberAfter(message, 'column ');
    if (explicitLine !== null) return { ok: false, error: { message: `Ungültiges JSON: ${message}`, line: explicitLine, column: explicitColumn } };
    const position = numberAfter(message, 'position ') ?? jsonErrorOffset(text);
    const at = position !== null ? lineColumn(text, position) : null;
    return { ok: false, error: { message: `Ungültiges JSON: ${message}`, line: at?.line ?? null, column: at?.column ?? null } };
  }
}

/** Line of `"id": "<nodeId>"` in the serialized text, to point inline issues at their node. */
export function lineOfId(text: string, id: string): number | null {
  const needle = `"id": ${JSON.stringify(id)}`;
  const index = text.indexOf(needle);
  return index < 0 ? null : lineColumn(text, index).line;
}
