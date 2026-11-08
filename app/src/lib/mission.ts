import { micro, payout, pct } from "./format";
import type { AttackRun, Decision, LinePlan, Mission, ProviderHonesty, Quote } from "./types";

export type OrderView = {
  seq: number;
  line: LinePlan;
  decision: Decision;
  purchaseTx: string | null;
  settleTx: string | null;
  score: number | null;
  fullUnits: number;
  paidUnits: number | null;
};

/**
 * Rebuild each purchase from the event stream. The engine logs decision →
 * purchase → settle per attempt, and decisions are stored in the same order.
 */
export function ordersOf(mission: Mission | null): OrderView[] {
  if (!mission) return [];
  const out: OrderView[] = [];
  for (const ev of mission.events) {
    if (ev.type === "purchase") {
      const decision = mission.decisions[out.length];
      const line = decision ? mission.lines.find((l) => l.index === decision.lineIndex) : undefined;
      if (!decision || !line) continue;
      out.push({
        seq: out.length,
        line,
        decision,
        purchaseTx: ev.tx,
        settleTx: null,
        score: null,
        fullUnits: micro(decision.quote.full),
        paidUnits: null,
      });
    } else if (ev.type === "settle") {
      const open = out.find((o) => o.score == null);
      const m = /score (\d+)/i.exec(ev.message);
      if (!open || !m) continue;
      open.score = Number(m[1]);
      open.settleTx = ev.tx;
      open.paidUnits = payout(open.fullUnits, open.score, open.line.minScore);
    }
  }
  return out;
}

/** Same rule the engine uses: lowest expected cost of a verified success wins. */
export function recommended(qs: Quote[]): Quote | null {
  const eligible = qs.filter((q) => q.eligible && q.ecs);
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => micro(a.ecs) - micro(b.ecs))[0] ?? null;
}

export function cheapest(qs: Quote[]): Quote | null {
  const eligible = qs.filter((q) => q.eligible);
  return [...eligible].sort((a, b) => micro(a.full) - micro(b.full))[0] ?? null;
}

export function successRate(q: Quote): number | null {
  return pct(q.pSuccess);
}

export type HonestyLabel = { text: string; tone: "ok" | "warn" | "bad" | "muted" };

/** Labels only once the numbers can carry them. */
export function honestyLabel(p: ProviderHonesty | undefined): HonestyLabel {
  if (!p || p.n < 5 || p.claimedMean == null || p.verifiedMean == null) return { text: "Not enough jobs yet", tone: "muted" };
  const gap = p.claimedMean - p.verifiedMean;
  if (gap >= 10) return { text: "Systematic overclaimer", tone: "bad" };
  if (gap >= 4) return { text: "Overclaims a little", tone: "warn" };
  if (gap <= -4) return { text: "Underpromises", tone: "ok" };
  return { text: "Well calibrated", tone: "ok" };
}

export function attackCounts(runs: AttackRun[], total: number) {
  const handled = runs.filter((r) => r.outcome === "expected");
  const punished = handled.filter((r) => r.name === "overclaim").length;
  return { blocked: handled.length - punished, punished, handled: handled.length, total, ran: runs.length > 0 };
}

export function summary(mission: Mission | null, orders: OrderView[], runs: AttackRun[], total: number) {
  const budget = micro(mission?.budget);
  const settled = orders.filter((o) => o.paidUnits != null);
  const spent = settled.reduce((a, o) => a + (o.paidUnits ?? 0), 0);
  const scores = settled.map((o) => o.score ?? 0);
  const txs = new Set<string>();
  for (const ev of mission?.events ?? []) if (ev.tx) txs.add(ev.tx);
  if (mission?.createTx) txs.add(mission.createTx);
  if (mission?.closeTx) txs.add(mission.closeTx);
  return {
    budget,
    spent,
    returned: Math.max(budget - spent, 0),
    considered: new Set(mission?.quotes.map((q) => q.provider) ?? []).size,
    purchased: new Set(orders.map((o) => o.decision.provider)).size,
    rejected: settled.filter((o) => o.paidUnits === 0).length,
    avgQuality: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    attacks: attackCounts(runs, total),
    txCount: txs.size,
  };
}
