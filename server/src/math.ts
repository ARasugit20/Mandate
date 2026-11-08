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
  // Cite only what settled receipts prove, never the provider's claim.
  const explanation =
    opts.n > 0 && opts.meanVerified != null
      ? `Proven: mean verified score ${opts.meanVerified.toFixed(1)} over ${opts.n} settled receipt${opts.n === 1 ? "" : "s"}.`
      : "No settled receipts yet, so nothing is proven. Expected cost uses the default prior.";
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

// ---------- Verification ----------

export const FACT_TOLERANCE = 0.02; // a claim passes within 2% of the reference

export type RefFact = { key: string; label: string; value: number; period: string; sourceUrl: string };
export type Claim = { key: string; value: number; period: string };

export type ClaimEvidence = {
  key: string;
  label: string;
  period: string;
  sellerValue: number | null;
  sellerPeriod: string | null;
  referenceValue: number;
  source: string;
  tolerance: number;
  pass: boolean;
  reason: string;
};

export type StructureCheck = { name: string; pass: boolean };

/** One evidence row per reference fact. A claim must match metric AND period. */
export function checkClaims(claims: Claim[], facts: RefFact[]): ClaimEvidence[] {
  return facts.map((fact) => {
    const row = {
      key: fact.key,
      label: fact.label,
      period: fact.period,
      referenceValue: fact.value,
      source: fact.sourceUrl,
      tolerance: FACT_TOLERANCE,
    };
    const claim = claims.find((c) => c.key === fact.key);
    if (!claim) {
      return { ...row, sellerValue: null, sellerPeriod: null, pass: false, reason: "not claimed" };
    }
    const seller = { ...row, sellerValue: claim.value, sellerPeriod: claim.period };
    if (claim.period !== fact.period) {
      return { ...seller, pass: false, reason: `wrong period: claimed ${claim.period}, reference is ${fact.period}` };
    }
    // Ratios are stored as fractions (0.75); models often answer in percent (75).
    let value = claim.value;
    if (fact.value <= 1 && value > 1 && value <= 100) value = value / 100;
    const off = Math.abs(value - fact.value) / Math.abs(fact.value);
    const pct = (off * 100).toFixed(1);
    if (off <= FACT_TOLERANCE) return { ...seller, pass: true, reason: `within 2% (${pct}% off)` };
    return { ...seller, pass: false, reason: `${pct}% off, outside the 2% tolerance` };
  });
}

/** Simple checks that a brief is a usable brief, not just numbers. */
export function checkStructure(markdown: string): StructureCheck[] {
  return [
    { name: "At least 300 characters", pass: markdown.length >= 300 },
    { name: "Names the reporting period", pass: /quarter|Q[1-4]|fiscal|FY ?20\d\d/i.test(markdown) },
    { name: "Cites a source (SEC filing)", pass: /sec\.gov|10-Q|10-K|EDGAR/i.test(markdown) },
    { name: "Mentions a risk", pass: /risk/i.test(markdown) },
  ];
}

/** Share of checks that passed, 0-100. */
export function percentPassed(checks: Array<{ pass: boolean }>): number {
  if (checks.length === 0) return 0;
  return Math.round((100 * checks.filter((c) => c.pass).length) / checks.length);
}

/** Facts carry most of the weight: a well-written brief with wrong numbers fails. */
export function finalScore(factScore: number, structureScore: number, rubricScore: number): number {
  const score = Math.round(0.7 * factScore + 0.15 * structureScore + 0.15 * rubricScore);
  return Math.max(0, Math.min(100, score));
}

// ---------- Override counterfactual ----------

export type Counterfactual = {
  recommended: { provider: ProviderName; price: string; ecs: string | null; pSuccess: string | null; explanation: string };
  override: { provider: ProviderName; price: string; score: number; paid: string; metMinimum: boolean };
  /** Spent on the override (pay + verification fee), plus a retry with the recommendation if it failed. */
  overrideCostToSuccess: string;
  verdict: string;
};

export function counterfactual(opts: {
  recommended: Quote;
  override: Quote;
  score: number;
  paid: string;
  minScore: number;
  verificationFee: number;
}): Counterfactual {
  const { recommended, override, score, paid, minScore, verificationFee } = opts;
  const metMinimum = score >= minScore;
  const retry = metMinimum ? 0 : Number(recommended.ecs ?? recommended.full);
  const cost = Number(paid) + verificationFee + retry;

  let verdict: string;
  if (override.provider === recommended.provider) {
    verdict = `Assay already recommended ${recommended.provider}, the cheapest eligible provider.`;
  } else if (metMinimum) {
    verdict = `${override.provider} scored ${score} and passed this time. ${recommended.provider} was still the lower expected cost.`;
  } else {
    verdict =
      `${override.provider} scored ${score}, below the ${minScore} minimum, and was paid ${paid}. ` +
      `The line still needs a passing delivery, so the override costs about ${round6Number(cost)} ` +
      `versus ${recommended.provider}'s expected ${recommended.ecs}.`;
  }

  return {
    recommended: {
      provider: recommended.provider,
      price: recommended.full,
      ecs: recommended.ecs,
      pSuccess: recommended.pSuccess,
      explanation: recommended.explanation,
    },
    override: { provider: override.provider, price: override.full, score, paid, metMinimum },
    overrideCostToSuccess: round6Number(cost),
    verdict,
  };
}
