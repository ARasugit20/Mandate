import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import {
  ATTACK_CARDS,
  DEMO_BUDGET,
  DEMO_GOAL,
  type AttackRun,
  type HealthRow,
  type Mission,
  type Quote,
} from "./lib/types";

type Tab = "mission" | "providers" | "attacks" | "receipts" | "setup";

function statusClass(s: HealthRow["status"]) {
  return s === "pass" ? "pass" : s === "fail" ? "fail" : "error";
}

function fmtTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>("mission");
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [healthOk, setHealthOk] = useState(false);
  const [goal, setGoal] = useState(DEMO_GOAL);
  const [budget, setBudget] = useState(DEMO_BUDGET);
  const [mission, setMission] = useState<Mission | null>(null);
  const [quotes, setQuotes] = useState<Quote[][] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attacks, setAttacks] = useState<AttackRun[]>([]);
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.providers>>["providers"]>([]);
  const [receipts, setReceipts] = useState<Awaited<ReturnType<typeof api.receipts>>["receipts"]>([]);
  const [setupMsg, setSetupMsg] = useState<string | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h.rows);
      setHealthOk(h.ok);
    } catch (e) {
      setHealth([]);
      setHealthOk(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    if (!mission?.id) return;
    if (mission.status === "awaiting_signature" || mission.status === "planned") {
      setQuotes(null);
      return;
    }
  }, [mission?.id, mission?.status]);

  useEffect(() => {
    if (!mission?.id) return;
    const es = new EventSource(api.eventsUrl(mission.id));
    es.addEventListener("mission", (ev) => {
      try {
        const event = JSON.parse(ev.data);
        setMission((m) => {
          if (!m || m.id !== mission.id) return m;
          const events = [...m.events, event];
          return { ...m, events };
        });
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [mission?.id]);

  const showLivePanels = useMemo(() => {
    if (!mission) return false;
    return ["signed", "running", "settled", "closed"].includes(mission.status);
  }, [mission]);

  const attackStopped = attacks.filter((a) => a.outcome === "expected" || a.outcome === "unexpected").length;

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function onPlan() {
    const res = await run("Planning…", () => api.plan(goal, budget));
    if (!res) return;
    setMission(res.mission);
    setQuotes(null);
  }

  async function onSign() {
    if (!mission) return;
    const m = await run("Signing…", () => api.sign(mission.id));
    if (m) {
      setMission(m);
      const q = await api.missionQuotes(m.id).catch(() => null);
      if (q) setQuotes(q.quotes);
    }
  }

  async function onRunDemo() {
    const res = await run("Planning demo…", () => api.plan(DEMO_GOAL, DEMO_BUDGET));
    if (!res) return;
    setMission(res.mission);
    setGoal(DEMO_GOAL);
    setBudget(DEMO_BUDGET);
    setQuotes(null);
    const signed = await run("Signing…", () => api.sign(res.mission.id));
    if (!signed) return;
    setMission(signed);
    const ran = await run("Running mission…", () => api.run(signed.id));
    if (ran) setMission(ran);
    const closed = await run("Closing…", () => api.close(ran!.id));
    if (closed) setMission(closed);
    void refreshHealth();
  }

  async function onRun() {
    if (!mission) return;
    const m = await run("Running…", () => api.run(mission.id));
    if (m) setMission(m);
  }

  async function loadProviders() {
    const p = await api.providers();
    setProviders(p.providers);
  }

  async function loadReceipts() {
    const r = await api.receipts();
    setReceipts(r.receipts);
  }

  useEffect(() => {
    if (tab === "providers") void loadProviders();
    if (tab === "receipts") void loadReceipts();
  }, [tab]);

  const flatQuotes = quotes?.[0] ?? mission?.quotes.slice(0, 3) ?? [];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="mark" />
          <div>
            <h1>MANDATE</h1>
            <p>Pay for proof, not promises.</p>
          </div>
        </div>
        <nav>
          {(
            [
              ["mission", "Mission Control"],
              ["providers", "Providers & Honesty"],
              ["attacks", "Attack Lab"],
              ["receipts", "Receipts"],
              ["setup", "Setup"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)} type="button">
              {label}
            </button>
          ))}
        </nav>
        <div className="track">
          TRACK
          <br />
          Solana Hackathon · AI Track
          <br />
          Devnet only. No mainnet funds.
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <span className={`badge ${healthOk ? "ok" : ""}`}>
            {healthOk ? "DEVNET CONNECTED" : "DEVNET NOT CONNECTED"}
          </span>
          <div className="roles">
            <span>
              <span className="dot o" />
              OWNER
            </span>
            <span>
              <span className="dot a" />
              AGENT
            </span>
            <span>
              <span className="dot v" />
              VERIFIER
            </span>
          </div>
          {mission && (
            <span className="badge" style={{ borderColor: "#3a3a44", background: "#121318", color: "#aab" }}>
              {mission.status.replaceAll("_", " ").toUpperCase()}
            </span>
          )}
        </header>

        <div className="content">
          {err && <p className="err">{err}</p>}
          {busy && <p className="lede">… {busy}</p>}

          {tab === "mission" && (
            <>
              <h2 className="hero">
                Owner-signed purchase plan. <em>Agent purchases. Verifier settles.</em>
              </h2>
              <p className="lede">
                Live mode: quotes and timeline stay empty until you plan and sign a real mandate. No fixture data.
              </p>
              <div className="grid3">
                <section className="card">
                  <h3>Mission brief</h3>
                  <label htmlFor="goal">Goal</label>
                  <textarea id="goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
                  <label htmlFor="budget">Budget (dUSDC)</label>
                  <input id="budget" type="text" value={budget} onChange={(e) => setBudget(e.target.value)} />
                  <button className="btn" type="button" disabled={!!busy} onClick={() => void onPlan()}>
                    Plan mission
                  </button>
                  <button className="btn ghost" type="button" disabled={!!busy} onClick={() => void onRunDemo()}>
                    Run demo mission
                  </button>
                  {mission && (
                    <>
                      <button
                        className="btn"
                        type="button"
                        disabled={!!busy || mission.status !== "awaiting_signature"}
                        onClick={() => void onSign()}
                      >
                        Sign mandate
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy || (mission.status !== "signed" && mission.status !== "running")}
                        onClick={() => void onRun()}
                      >
                        Run mission
                      </button>
                    </>
                  )}
                  {mission && mission.lines.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <h3>Purchase plan</h3>
                      {mission.lines.map((l) => (
                        <div key={l.index} className="plan-row">
                          <span>
                            {l.categoryName.toUpperCase()} · min {l.minScore}
                          </span>
                          <span>{l.budget} dUSDC</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="card">
                  <h3>Live timeline</h3>
                  {!showLivePanels && <p className="empty">Awaiting signature — no timeline yet.</p>}
                  {showLivePanels && (
                    <div className="timeline">
                      {(mission?.events ?? []).length === 0 && <p className="empty">No events yet.</p>}
                      {mission?.events.map((ev) => (
                        <div key={ev.id} className="ev">
                          <time>{fmtTime(ev.ts)}</time>
                          {ev.message}
                          {ev.explorerUrl && (
                            <>
                              {" "}
                              <a href={ev.explorerUrl} target="_blank" rel="noreferrer">
                                explorer
                              </a>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="card">
                  <h3>Quotes</h3>
                  {!showLivePanels && <p className="empty">Awaiting signature — no quotes yet.</p>}
                  {showLivePanels &&
                    (flatQuotes.length ? (
                      flatQuotes.map((q) => (
                        <div key={q.provider} className="quote">
                          <header>
                            <strong>{q.provider}</strong>
                            {!q.eligible && <span className="pill">ineligible</span>}
                          </header>
                          <div className="metrics">
                            <div>
                              <span>Claim</span>
                              {q.claimedScore}
                            </div>
                            <div>
                              <span>ECS</span>
                              {q.ecs ?? "—"}
                            </div>
                            <div>
                              <span>P(success)</span>
                              {q.pSuccess ?? "—"}
                            </div>
                          </div>
                          <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>{q.explanation}</p>
                        </div>
                      ))
                    ) : (
                      <p className="empty">Run the mission to load quotes.</p>
                    ))}
                </section>
              </div>
            </>
          )}

          {tab === "attacks" && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 className="hero" style={{ marginBottom: 0 }}>
                  Attack lab
                </h2>
                <span className="badge ok">ATTACKS STOPPED {attackStopped} / 10</span>
              </div>
              <p className="lede">Each card is a real devnet transaction the program should reject, or economic punishment.</p>
              <button
                className="btn"
                style={{ maxWidth: 220, marginBottom: 16 }}
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run("Running attacks…", async () => {
                    const res = await api.attacks();
                    setAttacks(res.runs);
                  })
                }
              >
                Run all attacks
              </button>
              <div className="attacks">
                {ATTACK_CARDS.map((card) => {
                  const run = attacks.find((a) => a.name === card.name);
                  return (
                    <article key={card.name} className="card attack">
                      <div className="tag">{card.tag}</div>
                      <h3 style={{ margin: "6px 0", fontSize: 15, color: "var(--text)" }}>{card.title}</h3>
                      <p style={{ fontSize: 12, color: "var(--muted)" }}>{card.body}</p>
                      <p style={{ fontSize: 11, color: "var(--orange)" }}>Expected: {card.expected}</p>
                      {run && (
                        <p className={run.outcome === "expected" ? "pass" : "fail"} style={{ fontSize: 12 }}>
                          Got: {run.actual ?? "pending"}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          )}

          {tab === "setup" && (
            <>
              <h2 className="hero">Setup</h2>
              <p className="lede">Keys live in the backend only. Agent holds SOL for fees, never dUSDC.</p>
              <div className="grid3" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <section className="card health">
                  <h3>Health</h3>
                  <button className="btn ghost" type="button" onClick={() => void refreshHealth()}>
                    Refresh
                  </button>
                  {health.map((row) => (
                    <div key={row.name} className="row">
                      <span>{row.name}</span>
                      <span className={statusClass(row.status)}>
                        {row.status} · {row.detail}
                      </span>
                    </div>
                  ))}
                </section>
                <section className="card">
                  <h3>Secrets (names only)</h3>
                  <div className="secrets">
                    {[
                      "SOLANA_RPC_URL",
                      "PROGRAM_ID",
                      "DUSDC_MINT",
                      "OWNER_SECRET_KEY",
                      "AGENT_SECRET_KEY",
                      "VERIFIER_SECRET_KEY",
                      "PROVIDER_*_PUBKEY",
                      "ANTHROPIC_API_KEY",
                    ].map((s) => (
                      <code key={s}>{s}</code>
                    ))}
                  </div>
                  <button
                    className="btn"
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void run("Registering…", async () => {
                        await api.register();
                        setSetupMsg("Providers registered.");
                        await refreshHealth();
                      })
                    }
                  >
                    Register providers
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      void run("Warmup…", async () => {
                        await api.warmup(10);
                        setSetupMsg("Warmup started (10 missions).");
                      })
                    }
                  >
                    Warm up 10 missions
                  </button>
                  {setupMsg && <p className="pass">{setupMsg}</p>}
                </section>
              </div>
            </>
          )}

          {tab === "providers" && (
            <>
              <h2 className="hero">Providers &amp; Honesty</h2>
              <button className="btn ghost" style={{ maxWidth: 160 }} type="button" onClick={() => void loadProviders()}>
                Refresh
              </button>
              <div className="attacks" style={{ marginTop: 16 }}>
                {providers.map((p) => (
                  <article key={p.provider} className="card">
                    <h3 style={{ margin: 0 }}>{p.provider}</h3>
                    <p style={{ fontSize: 13, color: "var(--muted)" }}>
                      n={p.n} · claimed mean {p.claimedMean?.toFixed(1) ?? "—"} · verified mean{" "}
                      {p.verifiedMean?.toFixed(1) ?? "—"}
                    </p>
                    <p style={{ fontSize: 12 }}>
                      full {p.cFull} · half {p.cHalf} · zero {p.cZero}
                    </p>
                  </article>
                ))}
              </div>
            </>
          )}

          {tab === "receipts" && (
            <>
              <h2 className="hero">Receipts</h2>
              <button className="btn ghost" style={{ maxWidth: 160 }} type="button" onClick={() => void loadReceipts()}>
                Refresh
              </button>
              {receipts.length === 0 && <p className="empty">No settled receipts yet.</p>}
              {receipts.map((r) => (
                <div key={r.orderId} className="plan-row">
                  <span>
                    {r.provider} · claimed {r.claimed} · verified {r.verified} · paid {r.paid}
                  </span>
                  <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                    tx
                  </a>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
