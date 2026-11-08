import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Counterfactual } from "../lib/extra";
import { fmt, micro } from "../lib/format";
import type { OrderView } from "../lib/mission";
import { PROVIDERS, type Mission, type ProviderHonesty, type ProviderName, type Quote } from "../lib/types";
import { shareFor } from "./viz";

/** One movement on the bench. Beats map each step to a story panel. */
export type FlowStep = {
  k: "sign" | "pick" | "buy" | "grade" | "pay" | "close";
  text: string;
  beat: number;
  prov?: ProviderName;
  amt?: number;
  paid?: number;
  score?: number;
  min?: number;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Turn the mission's event stream (plus the override, if any) into bench steps. */
export function flowSteps(mission: Mission | null, orders: OrderView[], cf: Counterfactual | null): FlowStep[] {
  if (!mission) return [];
  const steps: FlowStep[] = [];
  let decision = 0;
  let bought = 0;
  let cfDone = !cf;
  const cfSteps = (): FlowStep[] => {
    if (!cf) return [];
    const line = mission.lines.find((l) => l.index === cf.lineIndex);
    const min = line?.minScore ?? 0;
    const amt = micro(cf.chosen.quoted);
    const paid = micro(cf.chosen.paid);
    return [
      { k: "buy", beat: 3, prov: cf.chosen.provider, amt, text: `Override: buy ${line?.categoryName ?? "this line"} from ${cf.chosen.provider} at ${fmt(amt)} instead.` },
      { k: "grade", beat: 4, prov: cf.chosen.provider, score: cf.chosen.score, min, text: `Verifier scores ${cf.chosen.provider} ${cf.chosen.score}${cf.chosen.score < min ? `, below the ${min} minimum` : ""}.` },
      {
        k: "pay",
        beat: 5,
        prov: cf.chosen.provider,
        amt,
        paid,
        text: paid === 0 ? `${cap(cf.chosen.provider)} paid $0. All ${fmt(amt)} returned to the vault.` : `${fmt(paid)} paid to ${cf.chosen.provider}.`,
      },
    ];
  };
  for (const ev of mission.events) {
    if (ev.type === "create") {
      steps.push({ k: "sign", beat: 0, text: `Mandate signed. ${fmt(micro(mission.budget))} dUSDC locked under ${mission.lines.length} line items.` });
    } else if (ev.type === "decision") {
      const d = mission.decisions[decision++];
      if (!d) continue;
      const line = mission.lines.find((l) => l.index === d.lineIndex);
      steps.push({ k: "pick", beat: 1, prov: d.provider, text: `${cap(line?.categoryName ?? "line")}: ${d.provider} chosen at ${fmt(micro(d.quote.ecs))} per verified success.` });
    } else if (ev.type === "purchase") {
      const o = orders[bought++];
      if (!o) continue;
      steps.push({ k: "buy", beat: 2, prov: o.decision.provider, amt: o.fullUnits, text: `Purchase ${fmt(o.fullUnits)} escrowed. Every rule checked on chain.` });
    } else if (ev.type === "settle") {
      const o = orders.find((x) => x.settleTx === ev.tx) ?? orders.find((x) => x.score != null && !steps.some((s) => s.k === "pay" && s.prov === x.decision.provider && s.amt === x.fullUnits));
      if (!o || o.score == null) continue;
      const paid = o.paidUnits ?? 0;
      const half = paid > 0 && paid < o.fullUnits;
      steps.push({ k: "grade", beat: 4, prov: o.decision.provider, score: o.score, min: o.line.minScore, text: `Verifier scores ${o.decision.provider} ${o.score} on ${o.line.categoryName}.` });
      steps.push({
        k: "pay",
        beat: 5,
        prov: o.decision.provider,
        amt: o.fullUnits,
        paid,
        text: paid === 0 ? `${cap(o.decision.provider)} paid $0. ${fmt(o.fullUnits)} back to the vault.` : half ? `Half pay: ${fmt(paid)} to ${o.decision.provider}, ${fmt(o.fullUnits - paid)} back to the vault.` : `${fmt(paid)} released to ${o.decision.provider}.`,
      });
      if (!cfDone) {
        steps.push(...cfSteps());
        cfDone = true;
      }
    } else if (ev.type === "close") {
      if (!cfDone) {
        steps.push(...cfSteps());
        cfDone = true;
      }
      steps.push({ k: "close", beat: 6, text: "Mission closed. Everything unspent is back in the owner's vault." });
    }
  }
  if (!cfDone) steps.push(...cfSteps());
  return steps;
}

type Totals = { vault: number; escrow: number; paid: number; grades: Partial<Record<ProviderName, { score: number; kind: "full" | "half" | "zero" }>> };

export function totalsAt(budget: number, steps: FlowStep[], idx: number): Totals {
  const t: Totals = { vault: budget, escrow: 0, paid: 0, grades: {} };
  for (let i = 0; i <= idx && i < steps.length; i++) {
    const s = steps[i]!;
    if (s.k === "buy") {
      t.vault -= s.amt ?? 0;
      t.escrow += s.amt ?? 0;
    } else if (s.k === "pay") {
      t.escrow -= s.amt ?? 0;
      t.paid += s.paid ?? 0;
      t.vault += (s.amt ?? 0) - (s.paid ?? 0);
    } else if (s.k === "grade" && s.prov) {
      const share = shareFor(s.score ?? 0, s.min ?? 0);
      t.grades[s.prov] = { score: s.score ?? 0, kind: share === 1 ? "full" : share > 0 ? "half" : "zero" };
    }
  }
  return t;
}

// Fixed drawing geometry, in viewBox units.
const W = 1200;
const H = 430;
const BOX = {
  vault: [40, 150, 220, 150],
  mandate: [300, 150, 220, 150],
  escrow: [570, 170, 180, 110],
  verifier: [560, 20, 200, 84],
  alpha: [850, 30, 310, 100],
  deep: [850, 165, 310, 100],
  premium: [850, 300, 310, 100],
} as const;
const provY = (p: ProviderName) => BOX[p][1] + BOX[p][3] / 2;
const PATH = {
  buy: "M260,225 H570",
  grade: "M660,170 V104",
  refund: "M660,280 C660,405 150,405 150,300",
  pay: (p: ProviderName) => `M750,225 C805,225 795,${provY(p)} 850,${provY(p)}`,
};

/** A token travelling along a wire. Remounted per step so it replays. */
function Coin({ d, color, label, ms, delay = 0 }: { d: string; color: string; label?: string; ms: number; delay?: number }) {
  const path = useRef<SVGPathElement>(null);
  const g = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    const p = path.current;
    const el = g.current;
    if (!p || !el) return;
    const L = p.getTotalLength();
    let raf = 0;
    const t0 = performance.now() + delay;
    const step = (t: number) => {
      const k = Math.max(0, Math.min((t - t0) / ms, 1));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const pt = p.getPointAtLength(e * L);
      el.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      el.style.opacity = k >= 1 ? "0" : "1";
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [d, ms, delay]);
  return (
    <>
      <path ref={path} d={d} fill="none" stroke="none" />
      <g ref={g} className="coin" style={{ opacity: 0 }}>
        <circle r={7} fill={color} />
        {label && (
          <text y={-16} textAnchor="middle" fill="var(--ink)">
            {label}
          </text>
        )}
      </g>
    </>
  );
}

type Props = {
  mission: Mission | null;
  steps: FlowStep[];
  quotes: Quote[] | null;
  providers: ProviderHonesty[];
  budgetHint: string;
  onBeat: (beat: number) => void;
  onTotals: (t: Totals) => void;
  onReplay?: () => void;
};

export function Bench({ mission, steps, quotes, providers, budgetHint, onBeat, onTotals, onReplay }: Props) {
  const [idx, setIdx] = useState(steps.length - 1);
  const [running, setRunning] = useState(false);
  const [animate, setAnimate] = useState(false);
  const prevLen = useRef(steps.length);
  const prevTexts = useRef(steps.map((s) => s.text));
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // New steps arriving live: if we were caught up, play them in.
  useEffect(() => {
    const was = prevLen.current;
    const before = prevTexts.current;
    prevLen.current = steps.length;
    prevTexts.current = steps.map((s) => s.text);
    // Steps can be inserted mid-stream (the override lands after the first settle), so replay from the first change.
    const firstNew = steps.findIndex((s, i) => before[i] !== s.text);
    if (steps.length > was && firstNew >= 0 && firstNew < was) {
      setAnimate(true);
      setIdx(firstNew - 1);
      setRunning(true);
      return;
    }
    if (steps.length === 0) {
      setIdx(-1);
      setRunning(false);
    } else if (steps.length > was && idx >= was - 1) {
      setAnimate(true);
      setRunning(true);
    } else if (steps.length < was) {
      setIdx(steps.length - 1);
    }
  }, [steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return;
    if (idx >= steps.length - 1) {
      setRunning(false);
      return;
    }
    const t = window.setTimeout(() => setIdx((i) => i + 1), idx < 0 ? 300 : reduce ? 500 : 1500);
    return () => window.clearTimeout(t);
  }, [running, idx, steps.length, reduce]);

  useEffect(() => {
    if (running && idx >= 0 && steps[idx]) onBeat(steps[idx]!.beat);
  }, [idx, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const budget = micro(mission?.budget ?? budgetHint);
  const tot = useMemo(() => totalsAt(budget, steps, idx), [budget, steps, idx]);
  useEffect(() => onTotals(tot), [tot]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = idx >= 0 ? steps[idx] : undefined;
  const prev = idx > 0 ? steps[idx - 1] : undefined;
  const live = (k: FlowStep["k"], prov?: ProviderName) => cur?.k === k && (!prov || cur.prov === prov);
  const lines = mission?.lines.slice(0, 4) ?? [];

  function replay() {
    onReplay?.();
    setAnimate(true);
    setIdx(-1);
    setRunning(true);
  }
  function jump(i: number) {
    setAnimate(false);
    setRunning(false);
    setIdx(i);
    if (steps[i]) onBeat(steps[i]!.beat);
  }

  const node = (k: keyof typeof BOX, hot: boolean, dim = false) => {
    const [x, y, w, h] = BOX[k];
    return <rect className="card" x={x} y={y} width={w} height={h} rx={2} data-hot={hot} data-dim={dim} />;
  };

  return (
    <section className="bench" aria-label="Live money flow">
      <div className="flow-scroll">
      <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Money moves from the owner vault through the mandate to escrow, then to the provider or back to the vault depending on the verifier's score">
        <g className="grid-bg">
          {Array.from({ length: W / 40 + 1 }, (_, i) => (
            <line key={`x${i}`} x1={i * 40} y1={0} x2={i * 40} y2={H} />
          ))}
          {Array.from({ length: Math.floor(H / 40) + 1 }, (_, i) => (
            <line key={`y${i}`} x1={0} y1={i * 40} x2={W} y2={i * 40} />
          ))}
        </g>

        <path className={`wire ${live("buy") ? "live" : ""}`} d={PATH.buy} />
        <path className={`wire ${live("grade") ? "live" : ""}`} d={PATH.grade} />
        <path className={`wire ${live("pay") && (cur?.paid ?? 0) < (cur?.amt ?? 0) ? "live" : ""}`} d={PATH.refund} />
        {PROVIDERS.map((p) => (
          <path key={p} className={`wire ${live("pay", p) && (cur?.paid ?? 0) > 0 ? "live" : ""}`} d={PATH.pay(p)} />
        ))}

        <g className={live("sign") || live("close") ? "hot" : ""}>
          {node("vault", live("sign") || live("close"))}
          <text className="lbl" x={62} y={182}>
            vault.balance
          </text>
          <text className="big" x={62} y={224}>
            {fmt(Math.max(tot.vault, 0))}
          </text>
          <text className="sub" x={62} y={248}>
            dUSDC under mandate
          </text>
          <text className="sub m" x={62} y={280}>
            agent.balance = 0.000
          </text>
        </g>

        <g className={live("pick") || live("buy") ? "hot" : ""}>
          {node("mandate", live("pick") || live("buy"))}
          <text className="lbl" x={322} y={182}>
            mandate.rules[{lines.length || 0}]
          </text>
          {lines.length === 0 ? (
            <text className="sub" x={322} y={214}>
              Plan a mission to set the rules.
            </text>
          ) : (
            lines.map((l, i) => (
              <g key={l.index}>
                <text className="sub" x={322} y={210 + i * 22} style={{ textTransform: "capitalize" }}>
                  {l.categoryName}
                </text>
                <text className="sub m" x={430} y={210 + i * 22}>
                  {fmt(micro(l.budget)).slice(1)}
                </text>
                <text className="sub m" x={500} y={210 + i * 22} textAnchor="end">
                  ≥{l.minScore}
                </text>
              </g>
            ))
          )}
        </g>

        <g className={live("buy") || live("grade") || live("pay") ? "hot" : ""}>
          {node("escrow", live("buy") || live("grade"))}
          <text className="lbl" x={592} y={202}>
            escrow.held
          </text>
          <text className="big" x={592} y={244}>
            {fmt(Math.max(tot.escrow, 0))}
          </text>
          <text className="sub" x={592} y={266}>
            held until graded
          </text>
        </g>

        <g className={live("grade") ? "hot" : ""}>
          {node("verifier", live("grade"))}
          <text className="lbl" x={582} y={50}>
            verifier.settle()
          </text>
          <text className="sub" x={582} y={80}>
            {live("grade") ? `score = ${cur?.score}` : "only key that can pay"}
          </text>
          {live("grade") && (
            <circle className="pulse" cx={736} cy={46} r={7} fill={(cur?.score ?? 0) >= (cur?.min ?? 0) ? "var(--paid)" : "var(--rej)"} />
          )}
        </g>

        {PROVIDERS.map((p) => {
          const [x, y, w] = BOX[p];
          const q = quotes?.find((qq) => qq.provider === p);
          const s = providers.find((pp) => pp.provider === p);
          const claim = q?.claimedScore ?? (s?.claimedMean != null ? Math.round(s.claimedMean) : null);
          const proof = s?.verifiedMean != null ? Math.round(s.verifiedMean) : null;
          const bx = x + 22;
          const bw = w - 44;
          const by = y + 58;
          const hot = cur?.prov === p;
          return (
            <g key={p} className={hot ? "hot" : ""} opacity={q && !q.eligible ? 0.6 : 1}>
              {node(p, hot)}
              <text className="ttl" x={bx} y={y + 36}>
                {p}
              </text>
              <text className="sub m" x={x + w - 22} y={y + 34} textAnchor="end">
                {q ? (q.eligible ? `${fmt(micro(q.full))}/try` : "over cap") : ""}
              </text>
              <rect className="bar-bg" x={bx} y={by + 4} width={bw} height={2} />
              {proof != null && <rect x={bx} y={by + 3} width={(bw * proof) / 100} height={4} fill="var(--ink)" />}
              {proof != null && claim != null && claim > proof + 3 && (
                <rect x={bx + (bw * proof) / 100} y={by + 3} width={(bw * (claim - proof)) / 100} height={4} fill="var(--rej)" opacity={0.5} />
              )}
              {claim != null && <rect x={bx + (bw * claim) / 100 - 0.5} y={by - 4} width={1} height={18} fill="var(--gold)" />}
              <text className="sub m" x={bx} y={by + 32}>
                {claim != null ? `claims ${claim}` : "no quote"}
                {"  →  "}
                {proof != null ? `proves ${proof}` : "no proof yet"}
              </text>
            </g>
          );
        })}

        {PROVIDERS.map((p) => {
          const g = tot.grades[p];
          if (!g) return null;
          const [x, y, w, h] = BOX[p];
          const col = g.kind === "zero" ? "var(--rej)" : g.kind === "half" ? "var(--part)" : "var(--paid)";
          const fresh = cur?.k === "grade" && cur.prov === p && animate;
          return (
            <g key={`h-${p}`} transform={`translate(${x + w - 46},${y + h - 6})`}>
              <g className={`hallmark ${fresh ? "slam" : ""}`} transform="rotate(-10)">
                <circle r={30} fill="var(--paper)" stroke={col} strokeWidth={1.5} />
                <circle r={25} fill="none" stroke={col} strokeWidth={0.75} />
                <text y={5} textAnchor="middle" fill={col} fontSize={20} fontWeight={500} fontFamily="IBM Plex Sans, Helvetica Neue, sans-serif">
                  {g.score}
                </text>
                <text y={18} textAnchor="middle" fill={col} fontSize={8.5} fontFamily="IBM Plex Mono, monospace">
                  {g.kind === "zero" ? "$0" : g.kind === "half" ? "HALF" : "PAID"}
                </text>
              </g>
            </g>
          );
        })}

        <text className="note" x={405} y={420} textAnchor="middle">
          {"// refund path: unspent or failed work returns to the vault"}
        </text>

        {animate && running && cur?.k === "buy" && (
          <Coin key={`b${idx}`} d={PATH.buy} color="var(--gold)" label={fmt(cur.amt ?? 0)} ms={1000} />
        )}
        {animate && running && cur?.k === "pay" && cur.prov && (cur.paid ?? 0) > 0 && (
          <Coin key={`p${idx}`} d={PATH.pay(cur.prov)} color="var(--paid)" label={fmt(cur.paid ?? 0)} ms={1000} />
        )}
        {animate && running && cur?.k === "pay" && (cur.amt ?? 0) > (cur.paid ?? 0) && (
          <Coin key={`r${idx}`} d={PATH.refund} color={(cur.paid ?? 0) === 0 ? "var(--rej)" : "var(--gold)"} label={fmt((cur.amt ?? 0) - (cur.paid ?? 0))} ms={1300} />
        )}
        {animate && running && cur?.k === "grade" && prev?.k === "buy" && <Coin key={`g${idx}`} d={PATH.grade} color="var(--ink)" ms={700} />}
      </svg>
      </div>

      <div className="ticker">
        <button className="btn pri" type="button" onClick={replay} disabled={steps.length === 0}>
          {running ? "Playing…" : idx < 0 ? "Play mission" : "Replay"}
        </button>
        <div className="now" aria-live="polite">
          {cur ? cur.text : mission ? "Press play to watch the money move." : "Plan a mission. Every movement here becomes a devnet transaction in live mode."}
        </div>
        <div className="scrub" aria-label="Steps">
          {steps.map((s, i) => (
            <button key={i} type="button" className={i < idx ? "d" : i === idx ? "c" : ""} title={s.text} aria-label={`Step ${i + 1}: ${s.text}`} onClick={() => jump(i)}>
              <i />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
