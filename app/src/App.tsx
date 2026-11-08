import { useCallback, useEffect, useState } from "react";
import { ConfirmBar, Logo, Pill } from "./components/ui";
import type { Counterfactual, Evidence } from "./lib/extra";
import { FIXTURES, source as api } from "./lib/source";
import {
  ATTACK_CARDS,
  DEMO_BUDGET,
  DEMO_GOAL,
  type AttackRun,
  type HealthRow,
  type Mission,
  type ProviderHonesty,
  type Quote,
  type Receipt,
} from "./lib/types";
import { MissionControl } from "./pages/MissionControl";
import { AttackLab, ProvidersPage, ReceiptsPage, SetupPage } from "./pages/Other";
import { Stage } from "./Stage";

type Tab = "mission" | "providers" | "attacks" | "receipts" | "setup";

const TABS: Array<[Tab, string]> = [
  ["mission", "mission"],
  ["providers", "providers"],
  ["attacks", "attack_lab"],
  ["receipts", "receipts"],
  ["setup", "setup"],
];

type Theme = "system" | "light" | "dark";
const THEME_KEY = "assay:theme";
const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

/** "system" follows the OS light/dark setting; light or dark pins it. */
function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>("mission");
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [chainOk, setChainOk] = useState(false);
  const [goal, setGoal] = useState(DEMO_GOAL);
  const [budget, setBudget] = useState(DEMO_BUDGET);
  const [mission, setMission] = useState<Mission | null>(null);
  const [quotes, setQuotes] = useState<Quote[][] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attacks, setAttacks] = useState<AttackRun[]>([]);
  const [providers, setProviders] = useState<ProviderHonesty[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [counterfactual, setCounterfactual] = useState<Counterfactual | null>(null);
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; go: () => void } | null>(null);
  const [stage, setStage] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h.rows);
      setChainOk(h.chainOk);
    } catch (e) {
      setHealth([]);
      setChainOk(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  // Live mode: no quotes until the mandate is signed.
  useEffect(() => {
    if (!mission?.id) return;
    if (mission.status === "awaiting_signature" || mission.status === "planned") {
      setQuotes(null);
      return;
    }
  }, [mission?.id, mission?.status]);

  useEffect(() => {
    if (!mission?.id || FIXTURES) return;
    const es = new EventSource(api.eventsUrl(mission.id));
    es.addEventListener("mission", (ev) => {
      try {
        const event = JSON.parse(ev.data);
        setMission((m) => {
          if (!m || m.id !== mission.id) return m;
          if (m.events.some((x) => x.id === event.id)) return m;
          return { ...m, events: [...m.events, event] };
        });
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [mission?.id]);

  // Evidence and counterfactual come from Ryan's endpoints. Until they exist, these quietly stay empty.
  const settledCount = mission?.events.filter((e) => e.type === "settle").length ?? 0;
  useEffect(() => {
    if (!mission?.id || settledCount === 0) return;
    api.evidence(mission.id).then((r) => setEvidence(r.evidence), () => setEvidence([]));
    if (!FIXTURES) api.counterfactual(mission.id).then((r) => r.counterfactual && setCounterfactual(r.counterfactual), () => undefined);
  }, [mission?.id, settledCount]);

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

  /** Everyone shares one owner wallet, so anything that spends asks first in live mode. */
  function guarded(text: string, go: () => void) {
    if (FIXTURES) return go();
    setPending({ text, go });
  }

  async function onPlan() {
    const res = await run("Planning…", () => api.plan(goal, budget));
    if (!res) return;
    setMission(res.mission);
    setQuotes(null);
    setEvidence([]);
    setCounterfactual(null);
  }

  async function onSign() {
    if (!mission) return;
    const m = await run("Signing…", () => api.sign(mission.id));
    if (m) {
      setMission(m);
      const q = await api.missionQuotes(m.id).catch(() => null);
      if (q) setQuotes(q.quotes);
      void loadProviders(true);
    }
  }

  async function onRunDemo() {
    const res = await run("Planning demo…", () => api.plan(DEMO_GOAL, DEMO_BUDGET));
    if (!res) return;
    setMission(res.mission);
    setGoal(DEMO_GOAL);
    setBudget(DEMO_BUDGET);
    setQuotes(null);
    setEvidence([]);
    setCounterfactual(null);
    const signed = await run("Signing…", () => api.sign(res.mission.id));
    if (!signed) return;
    setMission(signed);
    const q = await api.missionQuotes(signed.id).catch(() => null);
    if (q) setQuotes(q.quotes);
    void loadProviders(true);
    const ran = await run("Running mission…", () => api.run(signed.id));
    if (!ran) return;
    setMission(ran);
    const closed = await run("Closing…", () => api.close(ran.id));
    if (closed) setMission(closed);
    void refreshHealth();
  }

  async function onRun() {
    if (!mission) return;
    const m = await run("Running…", () => api.run(mission.id));
    if (m) setMission(m);
  }

  async function onClose() {
    if (!mission) return;
    const m = await run("Closing…", () => api.close(mission.id));
    if (m) setMission(m);
    void refreshHealth();
  }

  async function onOverride(lineIndex: number) {
    if (!mission) return;
    const res = await run("Buying the cheapest quote…", () => api.override(mission.id, lineIndex));
    if (!res) return;
    setCounterfactual(res.counterfactual);
    if (!FIXTURES) setMission(res.mission);
  }

  async function onAttacks() {
    await run("Running attacks…", async () => {
      const res = await api.attacks();
      setAttacks(res.runs);
    });
  }

  async function loadProviders(quiet = false) {
    const p = quiet ? await api.providers().catch(() => null) : await run("Loading providers…", () => api.providers());
    if (p) setProviders(p.providers);
  }

  async function loadReceipts() {
    const r = await run("Loading receipts…", () => api.receipts());
    if (r) setReceipts(r.receipts);
  }

  useEffect(() => {
    if (tab === "providers") void loadProviders();
    if (tab === "receipts") void loadReceipts();
    if (tab === "mission") void loadProviders(true);
  }, [tab]);

  // S opens Stage mode anywhere except while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "s" || e.key === "S") {
        setStage((on) => {
          if (!on) {
            void api.receipts().then((r) => setReceipts(r.receipts), () => undefined);
            void loadProviders(true);
          }
          return !on;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const missionProps = {
    mission,
    quotes,
    providers,
    health,
    attacks,
    attackTotal: ATTACK_CARDS.length,
    evidence,
    counterfactual,
    busy,
    goal,
    budget,
    setGoal,
    setBudget,
    onPlan: () => void onPlan(),
    onSign: () => guarded("Signing spends from the shared owner wallet. Post in chat before you sign.", () => void onSign()),
    onRun: () => guarded("Running buys real orders from the shared wallet. Post in chat first.", () => void onRun()),
    onClose: () => void onClose(),
    onRunDemo: () => guarded("The full demo signs, buys and settles on devnet with the shared wallet. Post in chat first.", () => void onRunDemo()),
    onOverride: (i: number) => guarded("The override buys a real order from the cheapest provider. Post in chat first.", () => void onOverride(i)),
  };

  return (
    <div className={FIXTURES ? "has-fixbar" : ""}>
      {FIXTURES && <div className="fixbar">mode = fixture &nbsp;{"// sample data, not on-chain. Explorer links are off."}</div>}
      <div className="wrap">
        <header className="top">
          <span className="logo">
            <Logo />
            Assay
          </span>
          <span className="tagline">Pay for proof, not promises.</span>
          <nav className="nav" aria-label="Pages">
            {TABS.map(([id, label]) => (
              <button key={id} className={tab === id ? "on" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)} type="button">
                {label}
              </button>
            ))}
          </nav>
          <span className="sp" />
          {FIXTURES ? (
            <Pill tone="fx">fixture</Pill>
          ) : (
            <Pill tone={chainOk ? "ok" : "bad"}>{chainOk ? "devnet connected" : "devnet not connected"}</Pill>
          )}
          <button className="btn" type="button" onClick={() => setStage(true)} title="Stage mode (S)">
            Stage
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setTheme(NEXT_THEME[theme])}
            title={theme === "system" ? "Following your system's light or dark setting" : `Pinned to ${theme}. Click to change.`}
          >
            Theme: {THEME_LABEL[theme]}
          </button>
        </header>

        {err && (
          <div className="banner err" role="alert">
            <span>{err}</span>
            <span className="sp" />
            <button className="btn link" type="button" onClick={() => setErr(null)}>
              Dismiss
            </button>
          </div>
        )}
        {busy && <div className="banner busy">{busy}</div>}
        {pending && (
          <ConfirmBar
            text={pending.text}
            onNo={() => setPending(null)}
            onYes={() => {
              const go = pending.go;
              setPending(null);
              go();
            }}
          />
        )}

        {tab === "mission" && <MissionControl key={mission?.id ?? "none"} {...missionProps} />}
        {tab === "providers" && <ProvidersPage providers={providers} onRefresh={() => void loadProviders()} />}
        {tab === "attacks" && (
          <AttackLab runs={attacks} busy={busy} onRun={() => guarded("Attacks send real devnet transactions from the shared keys. Post in chat first.", () => void onAttacks())} />
        )}
        {tab === "receipts" && <ReceiptsPage receipts={receipts} onRefresh={() => void loadReceipts()} />}
        {tab === "setup" && (
          <SetupPage
            health={health}
            busy={busy}
            msg={setupMsg}
            onRefresh={() => void refreshHealth()}
            onRegister={() =>
              guarded("Registering providers writes to devnet with the owner key. Post in chat first.", () =>
                void run("Registering…", async () => {
                  await api.register();
                  setSetupMsg("providers registered");
                  await refreshHealth();
                }),
              )
            }
            onWarmup={() =>
              guarded("Warmup runs 10 real missions with the shared wallet. Post in chat first.", () =>
                void run("Warmup…", async () => {
                  await api.warmup(10);
                  setSetupMsg("warmup started · 10 missions");
                }),
              )
            }
          />
        )}
      </div>
      {stage && <Stage {...missionProps} receipts={receipts} onExit={() => setStage(false)} />}
    </div>
  );
}
