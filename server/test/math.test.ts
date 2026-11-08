import assert from "node:assert/strict";
import test from "node:test";
import {
  blendScore,
  ecs,
  factScore,
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

test("fact score 2% window and blend", () => {
  const facts = [{ key: "revenue_ttm_b", value: 100 }];
  assert.equal(factScore([{ key: "revenue_ttm_b", value: 101.5 }], facts), 100);
  assert.equal(factScore([{ key: "revenue_ttm_b", value: 104 }], facts), 0);
  assert.equal(factScore([{ key: "unknown", value: 1 }], facts), null);
  assert.equal(blendScore(null, 80), 80);
  assert.equal(blendScore(100, 0), 70);
});

test("fact score accepts ratios given as percent", () => {
  const facts = [{ key: "gross_margin", value: 0.7499 }];
  assert.equal(factScore([{ key: "gross_margin", value: 75 }], facts), 100);
  assert.equal(factScore([{ key: "gross_margin", value: 0.75 }], facts), 100);
  assert.equal(factScore([{ key: "gross_margin", value: 78.4 }], facts), 0);
});
