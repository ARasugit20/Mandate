import { Mark, Pill, TxLink } from "../components/ui";
import { CountUp } from "../components/viz";
import { fmt, micro } from "../lib/format";
import { attackCounts, honestyLabel } from "../lib/mission";
import { FIXTURES } from "../lib/source";
import { ATTACK_CARDS, type AttackRun, type HealthRow, type ProviderHonesty, type Receipt } from "../lib/types";
import { ProviderRow } from "./MissionControl";

/* ---------- Providers & Honesty ---------- */

export function ProvidersPage({ providers, onRefresh }: { providers: ProviderHonesty[]; onRefresh: () => void }) {
  const total = providers.reduce((a, p) => a + p.n, 0);
  return (
    <>
      <div className="head">
        <div>
          <span className="code">providers.honesty()</span>
          <h1>Promises, against proof.</h1>
          <p>Every provider's average claim next to what the verifier measured, read from on-chain stats. A label appears only after five verified jobs.</p>
        </div>
        <button className="btn" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {providers.length === 0 ? (
        <div className="empty">No provider stats yet. Settle a mission to fill this in.</div>
      ) : (
        <>
          <div className="ledger">
            {providers.map((p) => {
              const label = honestyLabel(p);
              const tone = label.tone === "ok" ? "paid" : label.tone === "bad" ? "rej" : label.tone === "warn" ? "part" : "dim";
              return (
                <div key={p.provider}>
                  <span className="code">{p.provider}</span>
                  <b className="d" style={{ fontSize: 24, letterSpacing: "-0.02em" }}>
                    <span className={tone}>{label.text}</span>
                  </b>
                  <span className="m dim" style={{ fontSize: 12.5 }}>
                    {p.cFull} full · {p.cHalf} half · {p.cZero} zero of {p.n}
                  </span>
                  {p.n > 0 && (
                    <div className="mix" aria-hidden="true">
                      <i style={{ flex: p.cFull || 0.0001, background: "var(--paid)" }} />
                      <i style={{ flex: p.cHalf || 0.0001, background: "var(--part)" }} />
                      <i style={{ flex: p.cZero || 0.0001, background: "var(--rej)" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <section className="panel" style={{ marginTop: 28, minHeight: 0 }}>
            <span className="code hd">
              claim − proof <i>{`// ${total} verified jobs on chain`}</i>
            </span>
            <h2>The gap is the whole story.</h2>
            <p className="lead">The tick is what a provider says it will deliver. The bar is what it actually delivers, on average. Hatching is the difference you would have paid for and not received.</p>
            {providers.map((p) => (
              <ProviderRow key={p.provider} name={p.provider} stat={p} />
            ))}
          </section>
        </>
      )}
    </>
  );
}

/* ---------- Receipts ---------- */

/** Quoted price isn't on the receipt yet; recover it from the curve when the payment pins it down. */
function quotedFrom(r: Receipt): string {
  const paid = micro(r.paid);
  if (paid === 0) return "—";
  return fmt(r.verified >= 90 ? paid : paid * 2);
}

export function ReceiptsPage({ receipts, onRefresh }: { receipts: Receipt[]; onRefresh: () => void }) {
  const paid = receipts.reduce((a, r) => a + micro(r.paid), 0);
  const zero = receipts.filter((r) => micro(r.paid) === 0).length;
  return (
    <>
      <div className="head">
        <div>
          <span className="code">orders.where(settled)</span>
          <h1>Every order, settled on chain.</h1>
          <p>Promised is what the seller claimed. Proven is what the verifier scored. Paid is what the curve allowed.</p>
        </div>
        <div className="totals">
          <div className="tot">
            <span className="code">receipts</span>
            <b>{receipts.length}</b>
          </div>
          <div className="tot">
            <span className="code">paid.total</span>
            <b className="paid">{fmt(paid)}</b>
          </div>
          <div className="tot">
            <span className="code">rejected</span>
            <b className="rej">{zero}</b>
          </div>
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 12 }}>
        <button className="btn" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {receipts.length === 0 ? (
        <div className="empty">No settled receipts yet.</div>
      ) : (
        <section className="panel" style={{ minHeight: 0, padding: "30px 36px" }}>
          <div className="tw">
            <table className="t" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>order</th>
                  <th>provider</th>
                  <th className="r">promised</th>
                  <th className="r">proven</th>
                  <th className="r">quoted</th>
                  <th className="r">paid</th>
                  <th>status</th>
                  <th>mission</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => {
                  const p = micro(r.paid);
                  const st = p === 0 ? (["rejected", "rej"] as const) : r.verified >= 90 ? (["paid", "paid"] as const) : (["half", "part"] as const);
                  return (
                    <tr key={`${r.missionId}-${r.orderId}`}>
                      <td className="m">#{r.orderId}</td>
                      <td className="serif cap">{r.provider}</td>
                      <td className="r score dim">{r.claimed}</td>
                      <td className={`r score ${st[1]}`}>{r.verified}</td>
                      <td className="r m">{quotedFrom(r)}</td>
                      <td className={`r m ${st[1]}`}>{fmt(p)}</td>
                      <td className={`m ${st[1]}`}>{st[0]}</td>
                      <td className="m dim" title={r.missionId}>
                        {r.missionId.length > 10 ? `${r.missionId.slice(0, 8)}…` : r.missionId}
                      </td>
                      <td>
                        <TxLink tx={r.tx} href={r.explorerUrl} label="settle tx" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/* ---------- Attack Lab ---------- */

export function AttackScoreboard({ runs, busy, onRun }: { runs: AttackRun[]; busy?: string | null; onRun?: () => void }) {
  const c = attackCounts(runs, ATTACK_CARDS.length);
  return (
    <div className="scoreboard">
      <div className="sb">
        <span className="code">blocked</span>
        <b className="paid">{c.ran ? <CountUp value={c.blocked} /> : "—"}</b>
        <span className="dim">rejected by the program</span>
      </div>
      <div className="sb">
        <span className="code">punished</span>
        <b className="part">{c.ran ? <CountUp value={c.punished} /> : "—"}</b>
        <span className="dim">paid $0 by the verifier</span>
      </div>
      <div className="sb">
        <span className="code">handled</span>
        <b>
          {c.ran ? <CountUp value={c.handled} /> : "—"}
          <small>/{c.total}</small>
        </b>
        <span className="dim">ended as expected</span>
      </div>
      {onRun && (
        <div className="sb-run">
          <button className="btn pri lg" type="button" disabled={!!busy} onClick={onRun}>
            Run all attacks
          </button>
          <span className="code">
            <i>{"// real devnet transactions"}</i>
          </span>
        </div>
      )}
    </div>
  );
}

export function AttackCase({ card, run }: { card: (typeof ATTACK_CARDS)[number]; run: AttackRun | undefined }) {
  const punished = card.name === "overclaim";
  const ok = run?.outcome === "expected";
  return (
    <article className="case">
      <span className="code">
        {card.name} <i>{`// ${card.tag.toLowerCase()}`}</i>
      </span>
      <h3>{card.title}</h3>
      <p>{card.body}</p>
      <span className="exp">
        {card.actor.toLowerCase().replace(" ", "_")} expects {card.expected}
      </span>
      <div className="out">
        {!run ? (
          <span className="dim">not run</span>
        ) : ok ? (
          <span className={punished ? "part" : "paid"}>
            =&gt; {punished ? "paid 0" : (run.actual ?? card.expected)} <Mark ok />
          </span>
        ) : (
          <span className="rej">
            =&gt; {run.outcome === "pending" ? "pending" : (run.actual ?? "no error")} {run.outcome !== "pending" && <Mark ok={false} />}
          </span>
        )}
        {run && <TxLink tx={run.tx} href={run.explorerUrl} label="tx" />}
      </div>
    </article>
  );
}

export function AttackLab({ runs, busy, onRun }: { runs: AttackRun[]; busy: string | null; onRun: () => void }) {
  const c = attackCounts(runs, ATTACK_CARDS.length);
  return (
    <>
      <div className="head">
        <div>
          <span className="code">attacks.run_all()</span>
          <h1>The AI can be wrong. The rules still hold.</h1>
          <p>
            {c.ran
              ? `${c.blocked} blocked · ${c.punished} economically punished · ${c.handled}/${c.total} handled.`
              : "Ten ways an agent or a provider could try to cheat. Each one is a real devnet transaction the program must reject, or a payment the verifier must zero out."}
          </p>
        </div>
      </div>
      <AttackScoreboard runs={runs} busy={busy} onRun={onRun} />
      <div className="cases">
        {ATTACK_CARDS.map((card) => (
          <AttackCase key={card.name} card={card} run={runs.find((r) => r.name === card.name)} />
        ))}
      </div>
    </>
  );
}

/* ---------- Setup ---------- */

const SECRETS = ["SOLANA_RPC_URL", "PROGRAM_ID", "DUSDC_MINT", "OWNER_SECRET_KEY", "AGENT_SECRET_KEY", "VERIFIER_SECRET_KEY", "PROVIDER_*_PUBKEY", "GEMINI_API_KEY"];
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function SetupPage(p: { health: HealthRow[]; busy: string | null; msg: string | null; onRefresh: () => void; onRegister: () => void; onWarmup: () => void }) {
  const pass = p.health.filter((r) => r.status === "pass").length;
  return (
    <>
      <div className="head">
        <div>
          <span className="code">health.check()</span>
          <h1>Keys stay on the server.</h1>
          <p>The agent holds SOL for fees and never holds dUSDC. Everything below is read live from the API and devnet.</p>
        </div>
        <div className="totals">
          <div className="tot">
            <span className="code">checks.pass</span>
            <b className={p.health.length && pass === p.health.length ? "paid" : "rej"}>
              {pass}
              <span className="dim">/{p.health.length || "—"}</span>
            </b>
          </div>
        </div>
      </div>
      <div className="cols">
        <section>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <span className="code">health.rows</span>
            <button className="btn" type="button" onClick={p.onRefresh}>
              Refresh
            </button>
          </div>
          {p.health.length === 0 ? (
            <div className="empty">No health data. Is the API running on 8787?</div>
          ) : (
            <div className="health">
              {p.health.map((row) => (
                <div key={row.name} className="hrow">
                  <span className="k">{key(row.name)}</span>
                  <span className="v">{row.detail}</span>
                  <Pill tone={row.status === "pass" ? "ok" : row.status === "fail" ? "bad" : "warn"}>{row.status}</Pill>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="panel" style={{ minHeight: 0 }}>
          <span className="code hd">env.secrets</span>
          <h2 style={{ fontSize: 30 }}>Names only, never values.</h2>
          <div className="secrets">
            {SECRETS.map((s) => (
              <code key={s}>{s}</code>
            ))}
          </div>
          <div className="row">
            <button className="btn" type="button" disabled={!!p.busy} onClick={p.onRegister}>
              Register providers
            </button>
            <button className="btn" type="button" disabled={!!p.busy} onClick={p.onWarmup}>
              Warm up 10 missions
            </button>
          </div>
          {p.msg && <p className="paid m" style={{ fontSize: 13 }}>{p.msg}</p>}
          {FIXTURES && (
            <p className="code" style={{ marginTop: 14 }}>
              <i>{"// fixture mode: these buttons don't touch the chain"}</i>
            </p>
          )}
        </section>
      </div>
    </>
  );
}
