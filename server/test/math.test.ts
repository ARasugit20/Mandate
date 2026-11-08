import assert from "node:assert/strict";
import test from "node:test";
import {
  checkClaims,
  checkStructure,
  counterfactual,
  finalScore,
  percentPassed,
  ecs,
  formatDusdc,
  missionHash,
  parseDusdc,
  quoteLine,
  rescaleBudgets,
} from "../src/math.ts";
import type { LinePlan } from "../../shared/types.ts";

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

const REFS = [
  { key: "revenue_q_b", label: "Revenue", value: 96.221, period: "2026-07-26", sourceUrl: "https://www.sec.gov/x" },
  { key: "gross_margin", label: "Gross margin", value: 0.7498, period: "2026-07-26", sourceUrl: "https://www.sec.gov/x" },
];

test("claims pass within 2% of the reference, fail outside it", () => {
  const rows = checkClaims(
    [
      { key: "revenue_q_b", value: 97.5, period: "2026-07-26" }, // 1.3% off
      { key: "gross_margin", value: 0.78, period: "2026-07-26" }, // 4% off
    ],
    REFS,
  );
  assert.equal(rows[0]!.pass, true);
  assert.equal(rows[1]!.pass, false);
  assert.equal(rows[0]!.referenceValue, 96.221);
  assert.equal(rows[0]!.tolerance, 0.02);
  assert.equal(rows[0]!.source, "https://www.sec.gov/x");
  assert.equal(percentPassed(rows), 50);
});

test("a correct value for the wrong period fails", () => {
  const [row] = checkClaims([{ key: "revenue_q_b", value: 96.221, period: "2026-04-26" }], REFS);
  assert.equal(row!.pass, false);
  assert.match(row!.reason, /wrong period/);
});

test("a missing claim fails, and percent is read as a fraction", () => {
  const rows = checkClaims([{ key: "gross_margin", value: 74.98, period: "2026-07-26" }], REFS);
  assert.equal(rows[0]!.pass, false);
  assert.equal(rows[0]!.reason, "not claimed");
  assert.equal(rows[1]!.pass, true);
});

test("structure checks and final score", () => {
  const good = "NVIDIA quarter ended 2026-07-26. Source: 10-Q at sec.gov. Risk: export limits. ".repeat(5);
  assert.equal(percentPassed(checkStructure(good)), 100);
  assert.equal(percentPassed(checkStructure("Revenue was huge.")), 0);
  assert.equal(finalScore(100, 100, 90), 99);
  assert.equal(finalScore(0, 0, 100), 15);
});

test("counterfactual: failed override costs its pay, the fee, and a retry", () => {
  const deep = quoteLine({ category: 0, maxUnitPrice: "0.25", minScore: 85, provider: "deep", n: 0, cFull: 0, cHalf: 0, meanVerified: null, verificationFee: 0.02, retryPenalty: 0.03 });
  const alpha = quoteLine({ category: 0, maxUnitPrice: "0.25", minScore: 85, provider: "alpha", n: 0, cFull: 0, cHalf: 0, meanVerified: null, verificationFee: 0.02, retryPenalty: 0.03 });
  const cf = counterfactual({ recommended: deep, override: alpha, score: 40, paid: "0.000000", minScore: 85, verificationFee: 0.02 });
  assert.equal(cf.override.metMinimum, false);
  assert.equal(cf.overrideCostToSuccess, (0.02 + Number(deep.ecs)).toFixed(6));
  assert.match(cf.verdict, /below the 85 minimum/);

  const passed = counterfactual({ recommended: deep, override: alpha, score: 95, paid: "0.030000", minScore: 85, verificationFee: 0.02 });
  assert.equal(passed.overrideCostToSuccess, "0.050000");
});

test("explanations cite receipts, never the claim", () => {
  const none = quoteLine({ category: 0, maxUnitPrice: "0.25", minScore: 85, provider: "alpha", n: 0, cFull: 0, cHalf: 0, meanVerified: null, verificationFee: 0.02, retryPenalty: 0.03 });
  assert.doesNotMatch(none.explanation, /claim/i);
  const proven = quoteLine({ category: 0, maxUnitPrice: "0.25", minScore: 85, provider: "alpha", n: 2, cFull: 0, cHalf: 0, meanVerified: 52, verificationFee: 0.02, retryPenalty: 0.03 });
  assert.match(proven.explanation, /Proven: mean verified score 52\.0 over 2 settled receipts/);
});
