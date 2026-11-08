import {
  ATTACK_CARDS,
  DEMO_BUDGET,
  DEMO_GOAL,
  type AttackRun,
  type Decision,
  type HealthResponse,
  type LinePlan,
  type Mission,
  type MissionEvent,
  type ProviderHonesty,
  type Quote,
  type Receipt,
} from "./types";
import type { Counterfactual, Evidence } from "./extra";

// Typed sample data for VITE_FIXTURES=1. None of this is on chain, so every
// tx here is a placeholder string and txUrl() refuses to link it.

const SEC = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=10-K";

export const FX_LINES: LinePlan[] = [
  { index: 0, category: 0, categoryName: "research", budget: "0.400000", maxUnitPrice: "0.100000", minScore: 85 },
  { index: 1, category: 1, categoryName: "analysis", budget: "0.300000", maxUnitPrice: "0.100000", minScore: 80 },
  { index: 2, category: 2, categoryName: "data", budget: "0.200000", maxUnitPrice: "0.060000", minScore: 75 },
  { index: 3, category: 3, categoryName: "writing", budget: "0.100000", maxUnitPrice: "0.050000", minScore: 90 },
];

function quote(
  provider: Quote["provider"],
  claimedScore: number,
  full: string,
  cap: string,
  pSuccess: string,
  ecs: string,
  explanation: string,
): Quote {
  const eligible = Number(full) <= Number(cap);
  return {
    provider,
    claimedScore,
    full,
    half: (Number(full) / 2).toFixed(6),
    halfEnabled: true,
    eligible,
    ineligibleReason: eligible ? null : "OverUnitPrice",
    ecs: eligible ? ecs : null,
    pSuccess: eligible ? pSuccess : null,
    expectedPay: eligible ? (Number(full) * 0.8).toFixed(6) : null,
    explanation: eligible ? explanation : "OverUnitPrice — price left unchanged, quote ineligible.",
  };
}

export const FX_QUOTES: Quote[][] = FX_LINES.map((l) => {
  const scale = Number(l.maxUnitPrice) / 0.1;
  const p = (n: number) => (n * scale).toFixed(6);
  return [
    quote("alpha", 95, p(0.05), l.maxUnitPrice, "18.0%", p(0.29), "Cheapest per try, but most of its work fails verification."),
    quote("deep", 88, p(0.08), l.maxUnitPrice, "91.0%", p(0.092), "Close to what it claims, so one try usually passes."),
    quote("premium", 93, p(0.14), l.maxUnitPrice, "95.0%", p(0.15), "Accurate, but priced above most line caps."),
  ];
});

const SCORES = [92, 86, 91, 93];
const T0 = Date.parse("2026-11-07T21:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function ev(id: number, s: number, type: string, act: MissionEvent["act"], message: string, tx: string | null): MissionEvent {
  return { id, missionId: "fx-mission", ts: at(s), type, act, message, tx, explorerUrl: null };
}

const base: Mission = {
  id: "fx-mission",
  chainMissionId: "1731013200",
  goal: DEMO_GOAL,
  budget: DEMO_BUDGET,
  missionHash: "fixture-hash",
  status: "awaiting_signature",
  mandatePda: null,
  createTx: null,
  closeTx: null,
  lines: FX_LINES,
  quotes: [],
  decisions: [],
  events: [],
};

export function fxPlanned(): Mission {
  return { ...base, events: [ev(1, 0, "plan", 1, "Plan ready for signature", null)] };
}

export function fxSigned(): Mission {
  const m = fxPlanned();
  return {
    ...m,
    status: "signed",
    mandatePda: "Fx7MandatePda1111111111111111111111111111",
    createTx: "fixture-create",
    events: [...m.events, ev(2, 4, "create", 1, "Mandate created on chain", "fixture-create")],
  };
}

export function fxSettled(): Mission {
  const m = fxSigned();
  const events = [...m.events];
  const decisions: Decision[] = [];
  let id = 3;
  let s = 8;
  FX_LINES.forEach((l, i) => {
    const q = FX_QUOTES[i]![1]!;
    const act = (Math.min(i + 1, 3) as 1 | 2 | 3);
    decisions.push({ lineIndex: l.index, provider: "deep", quote: q });
    events.push(ev(id++, s++, "quotes", act, `Quotes received · ${l.categoryName}`, null));
    events.push(ev(id++, s++, "decision", act, `deep chosen · ECS ${q.ecs}`, null));
    events.push(ev(id++, s++, "purchase", act, "Purchase submitted", `fixture-purchase-${i}`));
    events.push(ev(id++, (s += 6), "settle", act, `Settled score ${SCORES[i]}`, `fixture-settle-${i}`));
  });
  return { ...m, status: "settled", decisions, quotes: FX_QUOTES.flat(), events };
}

export function fxClosed(): Mission {
  const m = fxSettled();
  return {
    ...m,
    status: "closed",
    closeTx: "fixture-close",
    events: [...m.events, ev(99, 60, "close", 3, "Mandate closed, vault returned", "fixture-close")],
  };
}

export const FX_EVIDENCE: Evidence[] = [
  {
    orderId: "0",
    lineIndex: 0,
    provider: "deep",
    claims: [
      { key: "revenue_ttm_b", label: "Revenue, trailing 12 months ($B)", seller: "130.5", reference: "130.497", tolerance: "±2%", pass: true, sourceUrl: SEC },
      { key: "gross_margin", label: "Gross margin", seller: "75.0%", reference: "74.99%", tolerance: "±2%", pass: true, sourceUrl: SEC },
      { key: "data_center_pct", label: "Data center share of revenue", seller: "88%", reference: "88%", tolerance: "±2%", pass: true, sourceUrl: SEC },
    ],
    structure: { ok: true, detail: "All required sections present" },
    factScore: 100,
    rubricScore: 74,
    finalScore: 92,
  },
  ...[1, 2, 3].map((i) => ({
    orderId: String(i),
    lineIndex: i,
    provider: "deep" as const,
    claims: [],
    structure: { ok: true, detail: "All required sections present" },
    factScore: null,
    rubricScore: SCORES[i]!,
    finalScore: SCORES[i]!,
  })),
  {
    orderId: "4",
    lineIndex: 0,
    provider: "alpha",
    claims: [
      { key: "revenue_ttm_b", label: "Revenue, trailing 12 months ($B)", seller: "148.0", reference: "130.497", tolerance: "±2%", pass: false, sourceUrl: SEC },
      { key: "gross_margin", label: "Gross margin", seller: "75.0%", reference: "74.99%", tolerance: "±2%", pass: true, sourceUrl: SEC },
      { key: "data_center_pct", label: "Data center share of revenue", seller: "88%", reference: "88%", tolerance: "±2%", pass: true, sourceUrl: SEC },
    ],
    structure: { ok: false, detail: "Missing risks and valuation sections" },
    factScore: 67,
    rubricScore: 48,
    finalScore: 61,
  },
];

export const FX_COUNTERFACTUAL: Counterfactual = {
  lineIndex: 0,
  recommended: { provider: "deep", score: 92, paid: "0.080000", quoted: "0.080000" },
  chosen: { provider: "alpha", score: 61, paid: "0.000000", quoted: "0.050000", tx: "fixture-override" },
  retryNeeded: true,
  retryProvider: "deep",
};

export const FX_PROVIDERS: ProviderHonesty[] = [
  { provider: "alpha", n: 12, claimedMean: 95, verifiedMean: 63.4, cFull: 0, cHalf: 2, cZero: 10 },
  { provider: "deep", n: 14, claimedMean: 88.1, verifiedMean: 87.6, cFull: 6, cHalf: 7, cZero: 1 },
  { provider: "premium", n: 3, claimedMean: 93, verifiedMean: 92.3, cFull: 3, cHalf: 0, cZero: 0 },
];

export const FX_RECEIPTS: Receipt[] = [
  { orderId: "4", missionId: "fx-mission", provider: "alpha", claimed: 95, verified: 61, paid: "0.000000", tx: "fixture-override" },
  ...FX_LINES.map((l, i) => ({
    orderId: String(i),
    missionId: "fx-mission",
    provider: "deep" as const,
    claimed: 88,
    verified: SCORES[i]!,
    paid: (SCORES[i]! >= 90 ? Number(FX_QUOTES[i]![1]!.full) : Number(FX_QUOTES[i]![1]!.full) / 2).toFixed(6),
    tx: `fixture-settle-${l.index}`,
  })).reverse(),
];

export const FX_ATTACKS: AttackRun[] = ATTACK_CARDS.map((c) => ({
  name: c.name,
  title: c.title,
  expected: c.expected,
  actual: c.expected,
  outcome: "expected",
  tx: `fixture-${c.name}`,
  explorerUrl: null,
  logs: [],
}));

export const FX_HEALTH: HealthResponse = {
  ok: true,
  chainOk: true,
  rows: [
    { name: "Signing backend", status: "pass", detail: "fixture" },
    { name: "RPC reachable", status: "pass", detail: "fixture" },
    { name: "Program found at PROGRAM_ID", status: "pass", detail: "fixture" },
    { name: "Owner dUSDC", status: "pass", detail: "1.000000" },
    { name: "Agent holds 0 dUSDC", status: "pass", detail: "0.000000" },
    { name: "Providers registered", status: "pass", detail: "alpha, deep, premium" },
  ],
};
