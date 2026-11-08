import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bench, flowSteps, totalsAt } from "../components/Bench";
import { Mark, TxLink } from "../components/ui";
import { CountUp, CurveChart, ProofScale, Seal } from "../components/viz";
import type { Counterfactual, Evidence } from "../lib/extra";
import { fmt, fmtTime, micro, shortKey } from "../lib/format";
import { cheapest, ordersOf, recommended, successRate, summary, type OrderView } from "../lib/mission";
import { FIXTURES } from "../lib/source";
import type { AttackRun, HealthRow, LinePlan, Mission, ProviderHonesty, Quote } from "../lib/types";

export type MissionProps = {
  mission: Mission | null;
  quotes: Quote[][] | null;
  providers: ProviderHonesty[];
  health: HealthRow[];
  attacks: AttackRun[];
  attackTotal: number;
  evidence: Evidence[];
  counterfactual: Counterfactual | null;
  busy: string | null;
  goal: string;
  budget: string;
  setGoal: (v: string) => void;
  setBudget: (v: string) => void;
  onPlan: () => void;
  onSign: () => void;
  onRun: () => void;
  onClose: () => void;
  onRunDemo: () => void;
  onOverride: (lineIndex: number) => void;
};

const BEATS: Array<[string, string]> = [
  ["Sign once", "One mandate sets every limit."],
  ["Choose by proof", "Cost per verified success."],
  ["Lock the contract", "Terms checked before money moves."],
  ["Ignore Assay", "Buy the cheapest and see."],
  ["Read the evidence", "Why each score is what it is."],
  ["Settle", "Paid in full, half, or nothing."],
  ["Close", "What the mission cost."],
];

type Kind = "full" | "half" | "zero";
const kindOf = (paid: number, full: number): Kind => (paid === 0 ? "zero" : paid < full ? "half" : "full");
const toneOf = (k: Kind) => (k === "zero" ? "rej" : k === "half" ? "part" : "paid");

export function MissionControl(p: MissionProps) {
  const { mission, counterfactual: cf } = p;
  const orders = useMemo(() => ordersOf(mission), [mission]);
  const steps = useMemo(() => flowSteps(mission, orders, cf), [mission, orders, cf]);
  const [beat, setBeat] = useState(() => (mission ? (cf ? 3 : mission.status === "closed" ? 6 : 0) : 0));
  const [lineIdx, setLineIdx] = useState(0);
  // The story follows the money flow until someone picks a step themselves.
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
  }, [steps.length]);
  const [tot, setTot] = useState(() => totalsAt(micro(mission?.budget ?? p.budget), steps, steps.length - 1));

  const signed = !!mission && !["planned", "awaiting_signature"].includes(mission.status);
  const done = [
    signed,
    orders.length > 0,
    orders.some((o) => o.purchaseTx),
    !!cf,
    orders.some((o) => o.score != null),
    mission?.status === "settled" || mission?.status === "closed",
    mission?.status === "closed",
  ];

  const panels: ReactNode[] = [
    <SignPanel key="0" {...p} orders={orders} />,
    <ChoosePanel key="1" {...p} orders={orders} lineIdx={lineIdx} setLineIdx={setLineIdx} signed={signed} />,
    <ContractPanel key="2" {...p} orders={orders} lineIdx={lineIdx} setLineIdx={setLineIdx} signed={signed} />,
    <OverridePanel key="3" {...p} lineIdx={lineIdx} signed={signed} />,
    <EvidencePanel key="4" {...p} orders={orders} />,
    <SettlePanel key="5" {...p} orders={orders} />,
    <ClosePanel key="6" {...p} orders={orders} />,
  ];

  return (
    <>
      <div className="head">
        <div>
          <span className="code">
            mission.goal <i>=</i>
          </span>
          <h1>{mission?.goal ?? p.goal}</h1>
          <p>One signed mandate. The agent holds nothing and can only buy inside the rules. Sellers are paid for what the verifier proves.</p>
        </div>
        <div className="totals">
          <div className="tot">
            <span className="code">mandate.budget</span>
            <b>{fmt(micro(mission?.budget ?? p.budget))}</b>
          </div>
          <div className="tot">
            <span className="code">paid.total</span>
            <b className="paid">
              <CountUp value={tot.paid / 1e6} digits={3} />
            </b>
          </div>
          <div className="tot">
            <span className="code">vault.balance</span>
            <b className="gold">
              <CountUp value={Math.max(tot.vault, 0) / 1e6} digits={3} />
            </b>
          </div>
        </div>
      </div>

      <Bench
        mission={mission}
        steps={steps}
        quotes={p.quotes?.[0] ?? null}
        providers={p.providers}
        budgetHint={p.budget}
        onBeat={(b) => follow.current && setBeat(b)}
        onTotals={setTot}
        onReplay={() => (follow.current = true)}
      />

      <div className="story">
        <nav className="beats" aria-label="Story">
          {BEATS.map(([t, s], i) => (
            <button key={t} type="button" className={`beat ${i === beat ? "on" : ""} ${done[i] ? "done" : "pending"}`} onClick={() => {
                follow.current = false;
                setBeat(i);
              }}
              aria-current={i === beat}
            >
              <span className="k">{done[i] ? <Mark ok /> : String(i + 1).padStart(2, "0")}</span>
              <span>
                <b>{t}</b>
                <span className="s">{s}</span>
              </span>
            </button>
          ))}
          <div className="beats-foot">
            <span>
              <span className="kbd">S</span> stage mode
            </span>
          </div>
        </nav>
        <section className="panel" aria-live="polite">
          {panels[beat]}
        </section>
      </div>
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function LineTabs({ lines, value, onChange }: { lines: LinePlan[]; value: number; onChange: (i: number) => void }) {
  return (
    <div className="tabs" role="tablist">
      {lines.map((l) => (
        <button key={l.index} type="button" role="tab" aria-selected={value === l.index} className={value === l.index ? "on" : ""} onClick={() => onChange(l.index)}>
          <b>{l.categoryName}</b>
          <span>
            cap {fmt(micro(l.maxUnitPrice))} · min {l.minScore}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- 1 · Sign ---------- */

function SignPanel(p: MissionProps & { orders: OrderView[] }) {
  const { mission, orders } = p;
  const owner = p.health.find((r) => r.name === "Owner dUSDC");
  const agent = p.health.find((r) => r.name === "Agent holds 0 dUSDC");
  const status = mission?.status;
  if (!mission) {
    return (
      <>
        <span className="code hd">mission.plan(goal, budget)</span>
        <h2>Write the goal. Set the budget.</h2>
        <p className="lead">Assay splits the budget into line items, each with a price cap and a minimum quality score. You sign those rules once; the agent works inside them.</p>
        <div className="field">
          <label htmlFor="goal">goal</label>
          <textarea id="goal" rows={2} value={p.goal} onChange={(e) => p.setGoal(e.target.value)} />
        </div>
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="budget">budget (dUSDC)</label>
          <input id="budget" type="text" value={p.budget} onChange={(e) => p.setBudget(e.target.value)} />
        </div>
        <div className="actions">
          <button className="btn pri lg" type="button" disabled={!!p.busy} onClick={p.onPlan}>
            Plan mission
          </button>
          <button className="btn lg" type="button" disabled={!!p.busy} onClick={p.onRunDemo}>
            Run the full demo
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <span className="code hd">
        mandate.sign(owner) <i>{"// once"}</i>
      </span>
      <h2>Sign once. The agent never holds money.</h2>
      <p className="lead">The owner approves the rules, not every purchase. Each line has a budget, a unit price cap and a minimum score; the program rejects anything outside them.</p>
      <div className="tw">
        <table className="t">
          <thead>
            <tr>
              <th>line</th>
              <th className="r">budget</th>
              <th className="r">unit_cap</th>
              <th className="r">min_score</th>
              <th className="r">used</th>
            </tr>
          </thead>
          <tbody>
            {mission.lines.map((l) => {
              const used = orders.filter((o) => o.line.index === l.index).reduce((a, o) => a + (o.paidUnits ?? o.fullUnits), 0);
              return (
                <tr key={l.index}>
                  <td className="serif cap">{l.categoryName}</td>
                  <td className="r m">{fmt(micro(l.budget))}</td>
                  <td className="r m">{fmt(micro(l.maxUnitPrice))}</td>
                  <td className="r m">{l.minScore}</td>
                  <td className="r m">{used ? fmt(used) : <span className="dim">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="wallets">
        <div>
          <span className="code">owner.vault</span>
          <b>{owner?.status === "pass" ? Number(owner.detail).toFixed(3) : "—"}</b>
          <small>{owner?.status === "pass" ? "dUSDC the mandate draws on" : (owner?.detail ?? "Check Setup")}</small>
        </div>
        <div>
          <span className="code">agent.balance</span>
          <b className="dim">{agent?.status === "pass" ? Number(agent.detail).toFixed(3) : "—"}</b>
          <small>{agent?.status === "pass" ? "Always zero. It can only ask the program to pay." : (agent?.detail ?? "Check Setup")}</small>
        </div>
      </div>
      <div className="actions">
        {status === "awaiting_signature" && (
          <button className="btn pri lg" type="button" disabled={!!p.busy} onClick={p.onSign}>
            Sign mandate
          </button>
        )}
        {(status === "signed" || status === "running") && (
          <button className="btn pri lg" type="button" disabled={!!p.busy} onClick={p.onRun}>
            Run mission
          </button>
        )}
        {status === "settled" && (
          <button className="btn pri lg" type="button" disabled={!!p.busy} onClick={p.onClose}>
            Close mission
          </button>
        )}
        {mission.mandatePda && (
          <span className="code">
            mandate <i>=</i> {shortKey(mission.mandatePda)}
          </span>
        )}
        <TxLink tx={mission.createTx} label="mandate tx" />
      </div>
    </>
  );
}

/* ---------- 2 · Choose ---------- */

export function ProviderRow({ name, quote, stat, min, pick, capText }: { name: string; quote?: Quote; stat?: ProviderHonesty; min?: number; pick?: boolean; capText?: string }) {
  const inel = quote ? !quote.eligible : false;
  const claim = quote?.claimedScore ?? stat?.claimedMean ?? null;
  const proof = stat?.verifiedMean ?? null;
  const gap = claim != null && proof != null ? claim - proof : null;
  const sr = quote ? (successRate(quote) ?? (stat?.n ? (stat.cFull + stat.cHalf) / stat.n : null)) : stat?.n ? (stat.cFull + stat.cHalf) / stat.n : null;
  return (
    <div className={`pv ${pick ? "pick" : ""} ${inel ? "inel" : ""}`}>
      <div>
        <h3>{name}</h3>
        {pick ? (
          <span className="chip a">assay.pick</span>
        ) : inel ? (
          <span className="chip r">{quote?.ineligibleReason ?? "ineligible"}</span>
        ) : stat && stat.n < 5 ? (
          <span className="tl dim">too few jobs to judge</span>
        ) : gap != null && gap >= 10 ? (
          <span className="tl rej">overclaims by {gap.toFixed(0)}</span>
        ) : gap != null ? (
          <span className="tl paid">calibrated</span>
        ) : (
          <span className="tl dim">no track record</span>
        )}
      </div>
      <ProofScale claimed={claim} verified={proof} min={min} />
      <div className="cost">
        {quote ? (
          quote.ecs ? (
            <>
              <b>{fmt(micro(quote.ecs))}</b>
              <span>per verified success</span>
              <span className="m">
                {fmt(micro(quote.full))} ÷ {sr != null ? sr.toFixed(2) : "?"}
              </span>
            </>
          ) : (
            <>
              <b className="dim">—</b>
              <span>{capText ?? "over the unit cap"}</span>
              <span>never scaled down</span>
            </>
          )
        ) : (
          <>
            <b>{sr != null ? `${Math.round(sr * 100)}%` : "—"}</b>
            <span>success rate</span>
            <span className="m">{stat?.n ?? 0} jobs verified</span>
          </>
        )}
      </div>
    </div>
  );
}

export function ChoosePanel(p: MissionProps & { orders: OrderView[]; lineIdx: number; setLineIdx: (i: number) => void; signed: boolean }) {
  const { mission } = p;
  const head = <span className="code hd">quotes.sort(by: cost_per_verified_success)</span>;
  if (!mission || !p.signed) {
    return (
      <>
        {head}
        <h2>Cheapest per try is not cheapest per success.</h2>
        <Empty>Quotes appear once the mandate is signed.</Empty>
      </>
    );
  }
  const line = mission.lines.find((l) => l.index === p.lineIdx) ?? mission.lines[0]!;
  const qs = p.quotes?.[line.index] ?? [];
  const rec = recommended(qs);
  const cheap = cheapest(qs);
  const picked = p.orders.find((o) => o.line.index === line.index)?.decision.provider ?? rec?.provider;
  return (
    <>
      {head}
      <h2>Cheapest per try is not cheapest per success.</h2>
      <p className="lead">Each provider's promise is set against what the verifier has measured on chain. Assay buys from whoever has the lowest expected cost of a passing delivery.</p>
      <LineTabs lines={mission.lines} value={line.index} onChange={p.setLineIdx} />
      {qs.length === 0 ? (
        <Empty>No quotes for this line yet.</Empty>
      ) : (
        qs.map((q) => (
          <ProviderRow
            key={q.provider}
            name={q.provider}
            quote={q}
            stat={p.providers.find((s) => s.provider === q.provider)}
            min={line.minScore}
            pick={q.provider === picked}
            capText={`${fmt(micro(q.full))} is over the ${fmt(micro(line.maxUnitPrice))} cap`}
          />
        ))
      )}
      {rec && (
        <p className="verdict">
          {cheap && cheap !== rec && cheap.ecs
            ? `${cap(cheap.provider)} costs less per try, but one passing delivery from it costs about ${fmt(micro(cheap.ecs))}. ${cap(rec.provider)} costs ${fmt(micro(rec.ecs))}.`
            : rec.explanation}
        </p>
      )}
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- 3 · Contract ---------- */

export function ContractPanel(p: MissionProps & { orders: OrderView[]; lineIdx: number; setLineIdx: (i: number) => void; signed: boolean }) {
  const { mission } = p;
  const head = (
    <span className="code hd">
      order.purchase() <i>{"// terms checked on chain"}</i>
    </span>
  );
  if (!mission || !p.signed) {
    return (
      <>
        {head}
        <h2>The contract is fixed before money moves.</h2>
        <Empty>The contract is drafted once a provider is chosen.</Empty>
      </>
    );
  }
  const line = mission.lines.find((l) => l.index === p.lineIdx) ?? mission.lines[0]!;
  const order = p.orders.find((o) => o.line.index === line.index) ?? null;
  const quote = order?.decision.quote ?? recommended(p.quotes?.[line.index] ?? []);
  const bought = !!order?.purchaseTx;
  const settled = order?.score != null;
  const kind = settled ? kindOf(order!.paidUnits ?? 0, order!.fullUnits) : null;
  return (
    <>
      {head}
      <h2>The contract is fixed before money moves.</h2>
      <p className="lead">The program checks every term when the agent buys. If one fails, the transaction is rejected and nothing leaves the vault.</p>
      <LineTabs lines={mission.lines} value={line.index} onChange={p.setLineIdx} />
      {!quote ? (
        <Empty>No eligible quote for this line.</Empty>
      ) : (
        <div className="doc">
          <div className="doc-l">
            <div className="serial">
              <span>
                order #{mission.chainMissionId}/{line.index}
                {order ? `/${order.seq}` : ""}
              </span>
              <span className={settled ? toneOf(kind!) : bought ? "gold" : "dim"}>{settled ? "settled" : bought ? "escrowed" : "proposed"}</span>
            </div>
            <dl className="terms">
              {(
                [
                  ["buyer", "agent"],
                  ["seller", quote.provider],
                  ["purpose", line.categoryName],
                  ["price", `${fmt(micro(quote.full))} dUSDC`],
                  ["promised", String(quote.claimedScore)],
                  ["minimum", String(line.minScore)],
                  ["verifier", "verifier_key"],
                  ["mandate", shortKey(mission.mandatePda)],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="checks">
              {[
                "provider.registered",
                `line.category == ${line.categoryName}`,
                `price ${fmt(micro(quote.full))} <= cap ${fmt(micro(line.maxUnitPrice))}`,
                "line.remaining >= price",
                "vault -> escrow",
              ].map((c) => (
                <span key={c} className={bought ? "ok" : ""}>
                  <i>{bought ? <Mark ok /> : "·"}</i>
                  {c}
                </span>
              ))}
            </div>
            <div className="doc-foot">
              <TxLink tx={order?.purchaseTx} label="purchase tx" />
            </div>
          </div>
          <div className="doc-r">
            <h4>Payment curve</h4>
            <p className="dim" style={{ margin: "4px 0 0", fontSize: 14 }}>
              90 and above pays in full.{line.minScore < 90 ? ` ${line.minScore} to 89 pays half.` : ""} Below {line.minScore} pays nothing.
            </p>
            <CurveChart min={line.minScore} score={order?.score ?? null} />
            {settled && (
              <div className="doc-foot">
                <span className="muted" style={{ fontSize: 15 }}>
                  Scored <b className="d">{order!.score}</b>. Paid <span className="m">{fmt(order!.paidUnits ?? 0)}</span> of{" "}
                  <span className="m">{fmt(order!.fullUnits)}</span>.
                  <br />
                  <TxLink tx={order!.settleTx} label="settle tx" />
                </span>
                <Seal score={order!.score!} kind={kind!} size={104} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- 4 · Override ---------- */

export function OverridePanel(p: MissionProps & { lineIdx: number; signed: boolean }) {
  const { mission, counterfactual: cf } = p;
  const status = mission?.status;
  // Live overrides need an open mandate; fixtures can replay any time after signing.
  const open = FIXTURES ? p.signed : status === "signed" || status === "running" || status === "settled";
  const line = mission?.lines.find((l) => l.index === p.lineIdx) ?? mission?.lines[0];
  const cheap = line ? cheapest(p.quotes?.[line.index] ?? []) : null;
  const zero = cf ? micro(cf.chosen.paid) === 0 : false;
  return (
    <>
      <span className="code hd">
        override(line: "{line?.categoryName ?? "…"}", provider: "{cheap?.provider ?? "…"}")
      </span>
      <h2>What if you ignore Assay?</h2>
      <p className="lead">Same line, same rules, bought from the cheapest provider instead. The verifier doesn't know or care who chose it.</p>
      <div className="actions" style={{ marginTop: 0, marginBottom: 26 }}>
        <button className="btn red lg" type="button" disabled={!open || !!p.busy || !cheap} onClick={() => line && p.onOverride(line.index)}>
          {cheap && line ? `Buy ${line.categoryName} from ${cheap.provider} instead` : "Buy the cheapest instead"}
        </button>
        <span className="code">
          <i>{open ? `// ${cheap ? fmt(micro(cheap.full)) : "—"} a try, same checks, same verifier` : "// available while the mandate is open"}</i>
        </span>
      </div>
      {!cf ? (
        <Empty>Run the override to see the counterfactual next to Assay's pick.</Empty>
      ) : (
        <>
          <div className="face">
            <div>
              <span className="code">assay.pick</span>
              <h3>{cf.recommended.provider}</h3>
              <div className="sc paid">
                <CountUp value={cf.recommended.score} />
              </div>
              <dl>
                <dt>quoted</dt>
                <dd>{fmt(micro(cf.recommended.quoted))}</dd>
                <dt>paid</dt>
                <dd className="paid">{fmt(micro(cf.recommended.paid))}</dd>
                <dt>retry</dt>
                <dd>false</dd>
              </dl>
            </div>
            <div className="vs">vs</div>
            <div>
              <span className="code">
                you.pick <i>{"// cheapest"}</i>
              </span>
              <h3>{cf.chosen.provider}</h3>
              <div className={`sc ${zero ? "rej" : "part"}`}>
                <CountUp value={cf.chosen.score} />
              </div>
              <dl>
                <dt>quoted</dt>
                <dd>{fmt(micro(cf.chosen.quoted))}</dd>
                <dt>paid</dt>
                <dd className={zero ? "rej" : ""}>{fmt(micro(cf.chosen.paid))}</dd>
                <dt>retry</dt>
                <dd className={cf.retryNeeded ? "rej" : ""}>{cf.retryNeeded ? `true → ${cf.retryProvider ?? "pick"}` : "false"}</dd>
              </dl>
              <TxLink tx={cf.chosen.tx} label="override tx" />
              <Seal score={cf.chosen.score} kind={kindOf(micro(cf.chosen.paid), micro(cf.chosen.quoted))} />
            </div>
          </div>
          <p className="verdict">
            {zero
              ? `Saving ${fmt(micro(cf.recommended.quoted) - micro(cf.chosen.quoted))} bought a ${cf.chosen.score}. ${cap(cf.chosen.provider)} was paid nothing, the money went back to the vault, and the line still had to be bought again.`
              : `${cap(cf.chosen.provider)} scored ${cf.chosen.score} and was paid ${fmt(micro(cf.chosen.paid))} of ${fmt(micro(cf.chosen.quoted))}.`}
          </p>
        </>
      )}
    </>
  );
}

/* ---------- 5 · Evidence ---------- */

type EvItem = { key: string; title: string; provider: string; lineIndex: number; score: number; min: number; kind: Kind };

/** Percent difference between what the seller said and the reference, when both are numbers. */
function delta(seller: string, reference: string): string | null {
  const a = parseFloat(seller);
  const b = parseFloat(reference);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const d = ((a - b) / Math.abs(b)) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function EvidencePanel(p: MissionProps & { orders: OrderView[] }) {
  const { mission, counterfactual: cf } = p;
  const items: EvItem[] = [];
  if (cf && mission) {
    const line = mission.lines.find((l) => l.index === cf.lineIndex);
    items.push({ key: "cf", title: `${cf.chosen.provider} · override`, provider: cf.chosen.provider, lineIndex: cf.lineIndex, score: cf.chosen.score, min: line?.minScore ?? 0, kind: kindOf(micro(cf.chosen.paid), micro(cf.chosen.quoted)) });
  }
  for (const o of p.orders) {
    if (o.score == null) continue;
    items.push({ key: String(o.seq), title: `${o.line.categoryName} · ${o.decision.provider}`, provider: o.decision.provider, lineIndex: o.line.index, score: o.score, min: o.line.minScore, kind: kindOf(o.paidUnits ?? 0, o.fullUnits) });
  }
  const [sel, setSel] = useState(0);
  const it = items[Math.min(sel, items.length - 1)];
  const ev = it ? p.evidence.find((e) => e.lineIndex === it.lineIndex && e.provider === it.provider && e.finalScore === it.score) : undefined;
  return (
    <>
      <span className="code hd">
        verifier.grade({it?.provider ?? "…"}) <i>=&gt; {it?.score ?? "…"}</i>
      </span>
      <h2>{it ? `Why ${it.provider} scored ${it.score}.` : "Every score comes with evidence."}</h2>
      <p className="lead">The verifier checks each factual claim against a reference source, then blends it with a quality rubric. Only the final score is written on chain; this is how it got there.</p>
      {items.length === 0 ? (
        <Empty>Evidence appears as each delivery is verified.</Empty>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {items.map((x, i) => (
              <button key={x.key} type="button" role="tab" aria-selected={i === sel} className={i === sel ? "on" : ""} onClick={() => setSel(i)}>
                <b className={toneOf(x.kind)}>{x.score}</b>
                <span>{x.title}</span>
              </button>
            ))}
          </div>
          {!ev ? (
            <Empty>{FIXTURES ? "No evidence recorded for this order." : "Waiting on the evidence endpoint. The final score is on chain; the claim-by-claim breakdown lands with Ryan's API."}</Empty>
          ) : (
            <>
              {ev.claims.length > 0 ? (
                <div className="tw">
                  <table className="t">
                    <thead>
                      <tr>
                        <th />
                        <th>claim</th>
                        <th className="r">seller said</th>
                        <th className="r">reference</th>
                        <th className="r">delta</th>
                        <th>tolerance</th>
                        <th>source</th>
                        <th className="r">result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ev.claims.map((c, i) => (
                        <tr key={c.key}>
                          <td className="ln">{i + 1}</td>
                          <td>{c.label}</td>
                          <td className={`r m ${c.pass ? "" : "rej"}`}>{c.seller}</td>
                          <td className="r m">{c.reference}</td>
                          <td className={`r m ${c.pass ? "dim" : "rej"}`}>{delta(c.seller, c.reference) ?? "—"}</td>
                          <td className="m">{c.tolerance}</td>
                          <td>
                            {c.sourceUrl ? (
                              <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                                source ↗
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="r">
                            <span className={`res ${c.pass ? "ok" : "no"}`}>{c.pass ? "pass" : "fail"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>No reference facts apply to this line, so the score is the rubric alone.</Empty>
              )}
              <div className="math">
                <div className={ev.structure.ok ? "ok" : "no"}>
                  <small>structure</small>
                  <b>{ev.structure.ok ? "pass" : "fail"}</b>
                  <em>{ev.structure.detail}</em>
                </div>
                {ev.factScore != null && (
                  <>
                    <div>
                      <small>facts</small>
                      <b>{ev.factScore}</b>
                      <em>
                        {ev.claims.filter((c) => c.pass).length} of {ev.claims.length} within tolerance
                      </em>
                    </div>
                    <div className="op">× 0.7 +</div>
                  </>
                )}
                <div>
                  <small>rubric</small>
                  <b>{ev.rubricScore}</b>
                  <em>{ev.factScore != null ? "quality of the write-up" : "used alone"}</em>
                </div>
                {ev.factScore != null && <div className="op">× 0.3 =</div>}
                <div className="fin">
                  <small>score</small>
                  <b>{ev.finalScore}</b>
                  <em>{it && ev.finalScore < it.min ? `below the ${it.min} minimum` : "written on chain"}</em>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/* ---------- 6 · Settle ---------- */

export function SettlePanel(p: MissionProps & { orders: OrderView[] }) {
  const { mission, counterfactual: cf } = p;
  type Row = { key: string; title: string; score: number; committed: number; paid: number; tx: string | null };
  const rows: Row[] = [];
  if (cf) rows.push({ key: "cf", title: `${cf.chosen.provider} · override`, score: cf.chosen.score, committed: micro(cf.chosen.quoted), paid: micro(cf.chosen.paid), tx: cf.chosen.tx });
  for (const o of p.orders) {
    if (o.paidUnits == null) continue;
    rows.push({ key: String(o.seq), title: `${o.line.categoryName} · ${o.decision.provider}`, score: o.score!, committed: o.fullUnits, paid: o.paidUnits, tx: o.settleTx });
  }
  const head = (
    <span className="code hd">
      escrow.settle(score) <i>{"// the curve decides"}</i>
    </span>
  );
  if (!mission || rows.length === 0) {
    return (
      <>
        {head}
        <h2>Money moves the way the curve allows.</h2>
        <Empty>Nothing settled yet.</Empty>
      </>
    );
  }
  const budget = micro(mission.budget);
  const paid = rows.reduce((a, r) => a + r.paid, 0);
  const max = Math.max(...rows.map((r) => r.committed), 1);
  return (
    <>
      {head}
      <h2>Money moves the way the curve allows.</h2>
      <p className="lead">Every order is escrowed first. The verifier's score decides how much reaches the seller; the rest goes straight back to the owner's vault.</p>
      <div className="split">
        <div className="bar">
          <i style={{ flex: Math.max(paid, 1), background: "var(--paid)" }} />
          <i style={{ flex: Math.max(budget - paid, 1), background: "var(--rule-2)" }} />
        </div>
        <div className="row">
          <span className="paid">paid {fmt(paid)}</span>
          <span className="dim">of {fmt(budget)}</span>
          <span className="gold">returned {fmt(budget - paid)}</span>
        </div>
      </div>
      <div className="fl hd">
        <span>order</span>
        <span>committed → paid | returned</span>
        <span className="r">score</span>
        <span className="r">paid</span>
        <span />
      </div>
      {rows.map((r) => {
        const k = kindOf(r.paid, r.committed);
        return (
          <div key={r.key} className="fl">
            <b>
              {r.title}
              {k === "zero" && <span className="zero">$0</span>}
            </b>
            <div className="bar" style={{ width: `${Math.max((r.committed / max) * 100, 16)}%` }}>
              {r.paid > 0 && <i className="p" style={{ flex: r.paid }} />}
              {r.committed - r.paid > 0 && <i className="rt" style={{ flex: r.committed - r.paid }} />}
            </div>
            <span className={`sc ${toneOf(k)}`}>{r.score}</span>
            <span className="r m">
              {fmt(r.paid)} <span className="dim">/ {fmt(r.committed)}</span>
            </span>
            <TxLink tx={r.tx} label="settle tx" />
          </div>
        );
      })}
      <div className="legend">
        <span>
          <i style={{ background: "var(--paid)" }} />
          paid to seller
        </span>
        <span>
          <i style={{ background: "var(--rule-2)" }} />
          returned to vault
        </span>
      </div>
    </>
  );
}

/* ---------- 7 · Close ---------- */

function ClosePanel(p: MissionProps & { orders: OrderView[] }) {
  const { mission, counterfactual: cf } = p;
  const head = (
    <span className="code hd">
      mission.close() <i>{"// vault returned"}</i>
    </span>
  );
  if (!mission) {
    return (
      <>
        {head}
        <h2>What the mission cost.</h2>
        <Empty>Run a mission to see the totals.</Empty>
      </>
    );
  }
  const s = summary(mission, p.orders, p.attacks, p.attackTotal);
  const rejected = s.rejected + (cf && micro(cf.chosen.paid) === 0 ? 1 : 0);
  const closed = mission.status === "closed";
  return (
    <>
      {head}
      <p className="close-line">
        {closed ? "Spent" : "So far, spent"} {fmt(s.spent)} of {fmt(s.budget)}.{" "}
        {rejected > 0 ? (
          <>
            Refused to pay for <em>{rejected === 1 ? "one dishonest delivery" : `${rejected} dishonest deliveries`}</em>.
          </>
        ) : (
          "Every delivery earned its pay."
        )}{" "}
        {s.attacks.ran ? `Handled ${s.attacks.handled} of ${s.attacks.total} attacks.` : ""}
      </p>
      <div className="facts">
        <div>
          <span className="code">vault.returned</span>
          <b className="gold">{fmt(s.returned)}</b>
        </div>
        <div>
          <span className="code">providers.considered</span>
          <b>
            {s.considered} <span className="dim" style={{ fontSize: 22 }}>/ {s.purchased} bought</span>
          </b>
        </div>
        <div>
          <span className="code">quality.avg</span>
          <b>{s.avgQuality != null ? s.avgQuality.toFixed(1) : "—"}</b>
        </div>
        <div>
          <span className="code">tx.count</span>
          <b className={FIXTURES ? "dim" : ""}>{FIXTURES ? "live only" : s.txCount}</b>
        </div>
      </div>
      <div className="actions">
        {mission.status === "settled" && (
          <button className="btn pri lg" type="button" disabled={!!p.busy} onClick={p.onClose}>
            Close mission
          </button>
        )}
        <TxLink tx={mission.closeTx} label="close tx" />
      </div>
      <details className="log">
        <summary>event log · {mission.events.length} events</summary>
        {mission.events.map((ev) => (
          <div key={ev.id} className="tl">
            <time>{fmtTime(ev.ts)}</time>
            <span>{ev.message}</span>
            {ev.tx ? <TxLink tx={ev.tx} href={ev.explorerUrl} label="tx" /> : <span />}
          </div>
        ))}
      </details>
    </>
  );
}

