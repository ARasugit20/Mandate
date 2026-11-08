import { FIXTURES } from "./source";

/** Explorer link for a devnet signature. Fixture data never gets one. */
export function txUrl(tx: string | null | undefined): string | null {
  if (FIXTURES || !tx) return null;
  return `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
}

export function shortKey(s: string | null | undefined): string {
  if (!s) return "—";
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/** dUSDC strings arrive as "0.080000"; keep math in micro-units to avoid float drift. */
export function micro(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.round(Number(s) * 1_000_000);
}

export function fmt(units: number, digits = 3): string {
  return (units / 1_000_000).toFixed(digits);
}

/** "91.2%" → 0.912 */
export function pct(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n / 100 : null;
}

/** Same payment curve the verifier uses on chain: 90+ full, min–89 half (only when min < 90), below min zero. */
export function payout(fullUnits: number, score: number, minScore: number): number {
  if (score >= 90) return fullUnits;
  if (minScore < 90 && score >= minScore) return Math.floor(fullUnits / 2);
  return 0;
}

export function fmtTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}
