interface SecretPattern {
  name: string;
  source: string;
  flags: string;
  /** Replacement for redaction. `$1` etc. refer to capture groups. */
  replacement: string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'github_token', source: String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b`, flags: 'g', replacement: '[REDACTED:github_token]' },
  { name: 'anthropic_api_key', source: String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`, flags: 'g', replacement: '[REDACTED:anthropic_api_key]' },
  { name: 'openai_api_key', source: String.raw`\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}`, flags: 'g', replacement: '[REDACTED:openai_api_key]' },
  { name: 'google_api_key', source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, flags: 'g', replacement: '[REDACTED:google_api_key]' },
  { name: 'aws_access_key', source: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: 'g', replacement: '[REDACTED:aws_access_key]' },
  { name: 'slack_token', source: String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`, flags: 'g', replacement: '[REDACTED:slack_token]' },
  {
    name: 'private_key',
    source: String.raw`-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----|$)`,
    flags: 'g',
    replacement: '[REDACTED:private_key]',
  },
  {
    name: 'credential_assignment',
    source: String.raw`\b((?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*)(['"])[^'"\s]{12,}\2`,
    flags: 'gi',
    replacement: '$1$2[REDACTED]$2',
  },
];

export interface SecretFinding {
  name: string;
  index: number;
}

export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      findings.push({ name: pattern.name, index: match.index ?? 0 });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(text));
}

/** Redacts secret-looking values. Applied to logs, events and all model context. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), pattern.replacement);
  }
  return out;
}
