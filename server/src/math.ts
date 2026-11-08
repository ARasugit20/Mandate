import { createHash } from "node:crypto";
import type {
  CategoryId,
  ClaimCheck,
  FactUnit,
  LinePlan,
  MinScore,
  PayoutMath,
  PayoutTier,
  ProviderName,
  Quote,
  RefFact,
  RubricScore,
  Verification,
} from "../../shared/types.ts";

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

/**
 * Providers report ratios as either a fraction (0.75) or a percentage (75).
 * Both are honest answers, so normalise before comparing rather than scoring
 * the percentage form as a 100x error.
 */
export function normalizeClaim(value: number, unit: FactUnit): number {
  if (unit === "fraction" && Math.abs(value) > 1.5) return value / 100;
  return value;
}

/**
 * Credit decays linearly from full marks inside the tolerance to zero at
 * FACT_ZERO_AT times the tolerance. A binary window turns every near-miss into
 * a zero, which is what collapsed every verified score to 0.3 * rubric.
 */
const FACT_ZERO_AT = 6;

export function checkClaims(
  claims: Array<{ key: string; value: number }>,
  facts: RefFact[],
): ClaimCheck[] {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const checks: ClaimCheck[] = [];
  for (const claim of claims) {
    const fact = byKey.get(claim.key);
    if (!fact || fact.value === 0) continue;
    const normalized = normalizeClaim(claim.value, fact.unit);
    const relError = Math.abs(normalized - fact.value) / Math.abs(fact.value);
    const span = fact.tolerance * (FACT_ZERO_AT - 1);
    const points =
      relError <= fact.tolerance
        ? 100
        : Math.max(0, Math.round(100 * (1 - (relError - fact.tolerance) / span)));
    const pct = (relError * 100).toFixed(1);
    checks.push({
      key: fact.key,
      label: fact.label,
      claimed: claim.value,
      normalized,
      expected: fact.value,
      unit: fact.unit,
      relError,
      points,
      note:
        points === 100
          ? `within ±${(fact.tolerance * 100).toFixed(0)}% (off by ${pct}%)`
          : points === 0
            ? `off by ${pct}% — no credit`
            : `off by ${pct}% — partial credit`,
    });
  }
  return checks;
}

export function factScore(checks: ClaimCheck[]): number | null {
  if (checks.length === 0) return null;
  return Math.round(checks.reduce((a, c) => a + c.points, 0) / checks.length);
}

export const FACT_WEIGHT = 0.7;
export const RUBRIC_WEIGHT = 0.3;

export function blendScore(fact: number | null, rubric: number): number {
  if (fact == null) return Math.round(rubric);
  return Math.round(FACT_WEIGHT * fact + RUBRIC_WEIGHT * rubric);
}

export function buildVerification(
  checks: ClaimCheck[],
  rubric: RubricScore,
): Verification {
  const fact = factScore(checks);
  const finalScore = blendScore(fact, rubric.score);
  return {
    factScore: fact,
    rubricScore: rubric.score,
    finalScore,
    checks,
    rubric,
    weights: { fact: FACT_WEIGHT, rubric: RUBRIC_WEIGHT },
    formula:
      fact == null
        ? `No checkable claims, so the final score is the rubric score: ${rubric.score}.`
        : `${FACT_WEIGHT} x fact ${fact} + ${RUBRIC_WEIGHT} x rubric ${rubric.score} = ${finalScore}.`,
  };
}

/**
 * Same branch as `settle` in programs/mandate/src/lib.rs, reproduced so the UI
 * can show the arithmetic. The chain remains the authority; this only explains.
 */
export function payoutFor(opts: {
  score: number;
  fullAmount: bigint;
  minScore: number;
}): PayoutMath {
  const halfEnabled = opts.minScore < FULL_AT;
  const halfAmount = halfEnabled ? opts.fullAmount / 2n : 0n;
  const tier: PayoutTier =
    opts.score >= FULL_AT ? "full" : halfEnabled && opts.score >= opts.minScore ? "half" : "zero";
  const paid = tier === "full" ? opts.fullAmount : tier === "half" ? halfAmount : 0n;
  const rule =
    tier === "full"
      ? `Verified ${opts.score} is at or above the full-payment bar of ${FULL_AT}, so the vault releases the whole quote.`
      : tier === "half"
        ? `Verified ${opts.score} cleared the line minimum of ${opts.minScore} but not the full bar of ${FULL_AT}, so the vault releases half.`
        : halfEnabled
          ? `Verified ${opts.score} is below the line minimum of ${opts.minScore}, so the vault releases nothing.`
          : `This line demands ${opts.minScore}, which is the full-payment bar, so there is no half tier and ${opts.score} pays nothing.`;
  return {
    score: opts.score,
    fullAt: FULL_AT,
    halfAt: opts.minScore,
    halfEnabled,
    fullAmount: formatDusdc(opts.fullAmount),
    halfAmount: formatDusdc(halfAmount),
    paid: formatDusdc(paid),
    tier,
    rule,
  };
}

/**
 * NVIDIA fiscal year 2025, ended 26 January 2025. The period is part of the
 * contract: providers are told which year to report, so a wrong number is
 * fabrication rather than a different trailing window.
 */
export const FACTS_PERIOD = "NVIDIA fiscal year 2025, ended 26 January 2025";

export const NVIDIA_FACTS: RefFact[] = [
  {
    key: "revenue_ttm_b",
    label: "Total revenue (USD billions)",
    value: 130.497,
    unit: "billion_usd",
    tolerance: 0.02,
  },
  {
    key: "gross_margin",
    label: "GAAP gross margin",
    value: 0.7499,
    unit: "fraction",
    tolerance: 0.02,
  },
  {
    key: "data_center_pct",
    label: "Data Center share of revenue",
    value: 0.8826,
    unit: "fraction",
    tolerance: 0.03,
  },
];
