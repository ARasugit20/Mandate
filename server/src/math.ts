import { createHash } from "node:crypto";
import type { CategoryId, LinePlan, MinScore, ProviderName, Quote } from "../../shared/types.ts";

export const MICROS = 1_000_000n;
export const FULL_AT = 90;

export function parseDusdc(s: string): bigint {
  const trimmed = s.trim();
  const neg = trimmed.startsWith("-");
  const raw = neg ? trimmed.slice(1) : trimmed;
  const [whole = "0", fracRaw = ""] = raw.split(".");
  if (!/^\d+$/.test(whole) || (fracRaw && !/^\d+$/.test(fracRaw))) {
    throw new Error(`Invalid dUSDC amount: ${s}`);
  }
  const frac = (fracRaw + "000000").slice(0, 6);
  const value = BigInt(whole) * MICROS + BigInt(frac);
  return neg ? -value : value;
}

export function formatDusdc(n: bigint): string {
  const neg = n < 0n;
  const x = neg ? -n : n;
  const whole = x / MICROS;
  const frac = (x % MICROS).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function round6Number(n: number): string {
  if (!Number.isFinite(n)) throw new Error("non-finite amount");
  return formatDusdc(BigInt(Math.round(n * 1e6)));
}

export type EcsInput = {
  n: number;
  cFull: number;
  cHalf: number;
  full: number;
  half: number;
  halfEnabled: boolean;
  verificationFee: number;
  retryPenalty: number;
};

export type EcsResult = {
  pFull: number;
  pHalf: number;
  pZero: number;
  p: number;
  expectedPay: number;
  ecs: number;
};

export function ecs(input: EcsInput): EcsResult {
  const { n, cFull, cHalf, full, half, halfEnabled, verificationFee, retryPenalty } = input;
  const pFull = (cFull + 1) / (n + 3);
  const pHalf = halfEnabled ? (cHalf + 1) / (n + 3) : 0;
  const pZero = 1 - pFull - pHalf;
  const p = pFull + pHalf;
  const expectedPay = full * pFull + half * pHalf;
  const ecsValue = (expectedPay + verificationFee + retryPenalty * (1 - p)) / p;
  return { pFull, pHalf, pZero, p, expectedPay, ecs: ecsValue };
}

export function canonicalLines(lines: LinePlan[]): string {
  return JSON.stringify(
    lines.map((l) => ({
      category: l.category,
      budget: l.budget,
      minScore: l.minScore,
      maxUnitPrice: l.maxUnitPrice,
    })),
  );
}

export function missionHash(goal: string, lines: LinePlan[]): string {
  return createHash("sha256").update(goal + canonicalLines(lines)).digest("hex");
}

export function rescaleBudgets(lines: LinePlan[], ownerBudget: string): LinePlan[] {
  const target = parseDusdc(ownerBudget);
  const sums = lines.map((l) => parseDusdc(l.budget));
  const total = sums.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new Error("line budgets sum to 0");
  const scaled = sums.map((s) => (s * target) / total);
  let acc = scaled.reduce((a, b) => a + b, 0n);
  scaled[scaled.length - 1] += target - acc;
  return lines.map((l, i) => ({ ...l, budget: formatDusdc(scaled[i]!) }));
}

const RESEARCH_QUOTES: Record<ProviderName, { claim: number; full: number }> = {
  alpha: { claim: 95, full: 0.03 },
  deep: { claim: 92, full: 0.08 },
  premium: { claim: 98, full: 0.2 },
};

const CATEGORY_MULT: Record<CategoryId, number> = {
  0: 1,
  1: 1.15,
  2: 0.85,
  3: 1.1,
};

export function quoteLine(opts: {
  category: CategoryId;
  maxUnitPrice: string;
  minScore: MinScore;
  provider: ProviderName;
  n: number;
  cFull: number;
  cHalf: number;
  meanVerified: number | null;
  verificationFee: number;
  retryPenalty: number;
}): Quote {
  const base = RESEARCH_QUOTES[opts.provider];
  const fullNum = base.full * CATEGORY_MULT[opts.category];
  const halfEnabled = opts.minScore < FULL_AT;
  const halfNum = halfEnabled ? fullNum * 0.5 : 0;
  const cap = Number(opts.maxUnitPrice);
  const eligible = fullNum <= cap + 1e-12;
  const ineligibleReason = eligible ? null : "OverUnitPrice";
  const full = round6Number(fullNum);
  const half = round6Number(halfNum);
  if (!eligible) {
    return {
      provider: opts.provider,
      claimedScore: base.claim,
      full,
      half,
      halfEnabled,
      eligible: false,
      ineligibleReason,
      ecs: null,
      pSuccess: null,
      expectedPay: null,
      explanation: "OverUnitPrice — price left unchanged, quote ineligible.",
    };
  }
  const result = ecs({
    n: opts.n,
    cFull: opts.cFull,
    cHalf: opts.cHalf,
    full: fullNum,
    half: halfNum,
    halfEnabled,
    verificationFee: opts.verificationFee,
    retryPenalty: opts.retryPenalty,
  });
  const explanation =
    opts.n >= 3 && opts.meanVerified != null
      ? `Proven mean verified score ${opts.meanVerified.toFixed(1)} over ${opts.n} receipts.`
      : "No proof yet — trusting the claim.";
  return {
    provider: opts.provider,
    claimedScore: base.claim,
    full,
    half,
    halfEnabled,
    eligible: true,
    ineligibleReason: null,
    ecs: round6Number(result.ecs),
    pSuccess: (result.p * 100).toFixed(1) + "%",
    expectedPay: round6Number(result.expectedPay),
    explanation,
  };
}

export type RefFact = { key: string; value: number };

export function factScore(
  claims: Array<{ key: string; value: number }>,
  facts: RefFact[],
): number | null {
  const byKey = new Map(facts.map((f) => [f.key, f.value]));
  const matched: number[] = [];
  for (const claim of claims) {
    const fact = byKey.get(claim.key);
    if (fact == null || fact === 0) continue;
    const ok = Math.abs(claim.value - fact) / Math.abs(fact) <= 0.02;
    matched.push(ok ? 100 : 0);
  }
  if (matched.length === 0) return null;
  return Math.round(matched.reduce((a, b) => a + b, 0) / matched.length);
}

export function blendScore(fact: number | null, rubric: number): number {
  if (fact == null) return Math.round(rubric);
  return Math.round(0.7 * fact + 0.3 * rubric);
}

export const NVIDIA_FACTS: RefFact[] = [
  { key: "revenue_ttm_b", value: 130.497 },
  { key: "gross_margin", value: 0.7499 },
  { key: "data_center_pct", value: 0.88 },
];
