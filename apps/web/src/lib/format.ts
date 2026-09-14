const intFormat = new Intl.NumberFormat('en-US');

/** $0.0042 below one dollar (up to 4 decimals), $12.40 otherwise. */
export function formatUsd(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs < 1) {
    let text = abs.toFixed(4).replace(/0+$/, '');
    const decimals = text.split('.')[1]?.length ?? 0;
    if (decimals < 2) text = abs.toFixed(2);
    if (Number(text) === 0) return `${sign}<$0.0001`;
    return `${sign}$${text}`;
  }
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compact(n: number): string {
  const abs = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = n / size;
      const digits = Math.abs(scaled) >= 100 ? 0 : 1;
      return `${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return intFormat.format(Math.round(n));
}

/** Stat-tile money: $1.2K for large values, full precision below $1,000. */
export function formatUsdCompact(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (Math.abs(n) >= 1000) return `$${compact(n)}`;
  return formatUsd(n);
}

export function formatTokens(value: number | null | undefined): string {
  return compact(Number(value ?? 0));
}

export function formatNumber(value: number | null | undefined): string {
  return intFormat.format(Number(value ?? 0));
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  return `${Number(value ?? 0).toFixed(digits)}%`;
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatAbsolute(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatRelative(value: string | Date | null | undefined, now: number = Date.now()): string {
  const d = toDate(value);
  if (!d) return 'n/a';
  const diff = Math.round((now - d.getTime()) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  let text: string;
  if (s < 10) return future ? 'in a moment' : 'just now';
  if (s < 60) text = `${s} s`;
  else if (s < 3600) text = `${Math.floor(s / 60)} min`;
  else if (s < 86_400) text = `${Math.floor(s / 3600)} h`;
  else if (s < 86_400 * 30) {
    const days = Math.floor(s / 86_400);
    text = `${days} ${days === 1 ? 'day' : 'days'}`;
  } else return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return future ? `in ${text}` : `${text} ago`;
}

/** WAITING_APPROVAL -> "Waiting approval", project_analyst -> "Project analyst". */
const ACRONYMS = new Set(['pr', 'ci', 'api', 'id', 'url', 'sha', 'ai', 'ui', 'sql', 'mcp']);

export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  const words = value.replace(/[_.]+/g, ' ').toLowerCase().trim().split(/\s+/);
  const text = words.map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word)).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

/** Clean axis ticks: 0, then multiples of 1/2/2.5/5 x 10^n covering max. */
export function niceTicks(max: number, target = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function formatDayLabel(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
