// German number formatting for the AI Hub (the rest of the dashboard is English and uses lib/format.ts).

const integer = new Intl.NumberFormat('de-DE');
const compactFormat = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const percent = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 1 });

export function formatCountDe(value: number): string {
  return integer.format(value);
}

export function formatCompactDe(value: number): string {
  return value >= 10_000 ? compactFormat.format(value) : integer.format(value);
}

export function formatUsdDe(value: number): string {
  return usd.format(value);
}

export function formatShareDe(share: number): string {
  return percent.format(share);
}
