import assert from "node:assert/strict";
import test from "node:test";
import {
  blendScore,
  buildVerification,
  checkClaims,
  ecs,
  factScore,
  formatDusdc,
  missionHash,
  parseDusdc,
  payoutFor,
  quoteLine,
  rescaleBudgets,
} from "../src/math.ts";
import type { LinePlan, RefFact } from "../../shared/types.ts";

test("parse/format dUSDC 6 dp", () => {
  assert.equal(formatDusdc(parseDusdc("1")), "1.000000");
  assert.equal(formatDusdc(parseDusdc("0.03")), "0.030000");
  assert.equal(parseDusdc("1.000000"), 1_000_000n);
});

test("Laplace ECS with no history", () => {
  const r = ecs({
    n: 0,
    cFull: 0,
    cHalf: 0,
    full: 0.03,
    half: 0.015,
    halfEnabled: true,
    verificationFee: 0.02,
    retryPenalty: 0.03,
  });
  assert.equal(r.pFull, 1 / 3);
  assert.equal(r.pHalf, 1 / 3);
  assert.ok(Math.abs(r.p - 2 / 3) < 1e-12);
  const expected =
    (0.03 * (1 / 3) + 0.015 * (1 / 3) + 0.02 + 0.03 * (1 - 2 / 3)) / (2 / 3);
  assert.ok(Math.abs(r.ecs - expected) < 1e-12);
});

test("half disabled when minScore >= 90", () => {
  const r = ecs({
    n: 0,
    cFull: 0,
    cHalf: 0,
    full: 0.03,
    half: 0,
    halfEnabled: false,
    verificationFee: 0.02,
    retryPenalty: 0.03,
  });
  assert.equal(r.pHalf, 0);
});

test("rescale budgets to owner total", () => {
  const lines: LinePlan[] = [
    { index: 0, category: 0, categoryName: "research", budget: "2.000000", maxUnitPrice: "0.10", minScore: 85 },
    { index: 1, category: 2, categoryName: "data", budget: "2.000000", maxUnitPrice: "0.08", minScore: 80 },
  ];
  const out = rescaleBudgets(lines, "1.000000");
  const sum = parseDusdc(out[0]!.budget) + parseDusdc(out[1]!.budget);
  assert.equal(sum, parseDusdc("1.000000"));
});

test("mission hash is stable", () => {
  const lines: LinePlan[] = [
    { index: 0, category: 0, categoryName: "research", budget: "1.000000", maxUnitPrice: "0.10", minScore: 85 },
  ];
  assert.equal(missionHash("g", lines), missionHash("g", lines));
  assert.notEqual(missionHash("g", lines), missionHash("h", lines));
});

test("over-cap quote stays ineligible and price unchanged", () => {
  const q = quoteLine({
    category: 0,
    maxUnitPrice: "0.100000",
    minScore: 85,
    provider: "premium",
    n: 0,
    cFull: 0,
    cHalf: 0,
    meanVerified: null,
    verificationFee: 0.02,
    retryPenalty: 0.03,
  });
  assert.equal(q.eligible, false);
  assert.equal(q.ineligibleReason, "OverUnitPrice");
  assert.equal(q.full, "0.200000");
  assert.equal(q.ecs, null);
});

test("claims are normalised before grading", () => {
  const facts: RefFact[] = [
    { key: "gross_margin", label: "GM", value: 0.75, unit: "fraction", tolerance: 0.02 },
  ];
  // A provider answering 75 means 75%, not 7500%. Both forms must grade alike.
  assert.equal(checkClaims([{ key: "gross_margin", value: 0.75 }], facts)[0]!.points, 100);
  assert.equal(checkClaims([{ key: "gross_margin", value: 75 }], facts)[0]!.points, 100);
});

test("fact credit decays instead of cliffing to zero", () => {
  const facts: RefFact[] = [
    { key: "revenue_ttm_b", label: "Rev", value: 100, unit: "billion_usd", tolerance: 0.02 },
  ];
  const score = (v: number) => checkClaims([{ key: "revenue_ttm_b", value: v }], facts)[0]!.points;
  assert.equal(score(101.5), 100); // inside tolerance
  const near = score(104); // 4% off: partial, not zero
  assert.ok(near > 0 && near < 100, `expected partial credit, got ${near}`);
  assert.ok(score(104) > score(108), "credit must fall as error grows");
  assert.equal(score(140), 0); // far beyond the window
  assert.equal(factScore(checkClaims([{ key: "unknown", value: 1 }], facts)), null);
});

test("blend weights fact at 0.7", () => {
  assert.equal(blendScore(null, 80), 80);
  assert.equal(blendScore(100, 0), 70);
  assert.equal(blendScore(0, 95), 29); // the score the broken verifier kept producing
});

test("an accurate, well-sourced brief can reach a full payment", () => {
  const facts: RefFact[] = [
    { key: "revenue_ttm_b", label: "Rev", value: 130.497, unit: "billion_usd", tolerance: 0.02 },
    { key: "gross_margin", label: "GM", value: 0.7499, unit: "fraction", tolerance: 0.02 },
  ];
  const checks = checkClaims(
    [
      { key: "revenue_ttm_b", value: 130.5 },
      { key: "gross_margin", value: 75.0 },
    ],
    facts,
  );
  const v = buildVerification(checks, { score: 88, reasoning: "thin on risk" });
  assert.equal(v.factScore, 100);
  assert.ok(v.finalScore >= 90, `expected a full-payment score, got ${v.finalScore}`);
  const payout = payoutFor({ score: v.finalScore, fullAmount: 30_000n, minScore: 85 });
  assert.equal(payout.tier, "full");
  assert.equal(payout.paid, "0.030000");
});

test("payout mirrors the on-chain settle branch", () => {
  const full = 80_000n;
  assert.equal(payoutFor({ score: 93, fullAmount: full, minScore: 85 }).tier, "full");
  // 86 clears the line minimum but not the 90 full bar, so half is released.
  const half = payoutFor({ score: 86, fullAmount: full, minScore: 85 });
  assert.equal(half.tier, "half");
  assert.equal(half.paid, "0.040000");
  // 75 is under the 80 minimum, so nothing is released. This is correct, not a bug.
  const zero = payoutFor({ score: 75, fullAmount: full, minScore: 80 });
  assert.equal(zero.tier, "zero");
  assert.equal(zero.paid, "0.000000");
  // A line demanding 90 has no half tier at all.
  assert.equal(payoutFor({ score: 89, fullAmount: full, minScore: 90 }).halfEnabled, false);
});
