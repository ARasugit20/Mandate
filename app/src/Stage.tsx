import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Logo, Mark, Pill, TxLink } from "./components/ui";
import { ordersOf } from "./lib/mission";
import { FIXTURES } from "./lib/source";
import type { Receipt } from "./lib/types";
import { ChoosePanel, ContractPanel, OverridePanel, SettlePanel, type MissionProps } from "./pages/MissionControl";
import { AttackScoreboard } from "./pages/Other";

type Props = MissionProps & { receipts: Receipt[]; onExit: () => void };

/**
 * Full-screen presenter. Slides reuse the Mission Control panels at projector
 * scale, so they are exactly as live as the pages are.
 */
export function Stage(p: Props) {
  const [i, setI] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const orders = useMemo(() => ordersOf(p.mission), [p.mission]);
  const signed = !!p.mission && !["planned", "awaiting_signature"].includes(p.mission.status);
  const injected = p.attacks.find((a) => a.name === "injected_transfer");

  const slides: Array<[string, ReactNode]> = [
    ["the choice", <ChoosePanel key="c" {...p} orders={orders} lineIdx={lineIdx} setLineIdx={setLineIdx} signed={signed} />],
    ["the contract and payment", <ContractPanel key="k" {...p} orders={orders} lineIdx={lineIdx} setLineIdx={setLineIdx} signed={signed} />],
    ["the liar is paid $0", p.counterfactual ? <OverridePanel key="o" {...p} lineIdx={lineIdx} signed={signed} /> : <SettlePanel key="s" {...p} orders={orders} />],
    [
      "the injection is blocked",
      <>
        <span className="code hd">
          agent.purchase(provider: ATTACKER) <i>{"// hidden in the task text"}</i>
        </span>
        <h2>Hidden text told the agent to pay an attacker.</h2>
        <p className="lead">The agent followed it. The program refused, because the attacker isn't a registered provider. No rule was relaxed and no money moved.</p>
        {!injected ? (
          <div className="empty">Run the Attack Lab to load this result.</div>
        ) : (
          <div className="row" style={{ gap: 28, alignItems: "baseline" }}>
            <span className={`d ${injected.outcome === "expected" ? "paid" : "rej"}`} style={{ fontSize: "clamp(40px, 4vw, 72px)" }}>
              =&gt; {injected.actual ?? injected.expected} <Mark ok={injected.outcome === "expected"} size={36} />
            </span>
            <TxLink tx={injected.tx} href={injected.explorerUrl} label="rejected tx" />
          </div>
        )}
      </>,
    ],
    [
      "the attack lab",
      <>
        <span className="code hd">attacks.run_all()</span>
        <h2>The AI can be wrong. The rules still hold.</h2>
        <p className="lead">Ten attempts to cheat, each a real devnet transaction. The program blocks nine; the verifier pays the tenth nothing.</p>
        <AttackScoreboard runs={p.attacks} />
      </>,
    ],
  ];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setI((n) => Math.min(n + 1, slides.length - 1));
      } else if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
      else if (e.key === "Escape") p.onExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length, p]);

  return (
    <div className="stage" role="dialog" aria-label="Stage mode">
      <div className="row">
        <span className="logo" style={{ fontSize: 26 }}>
          <Logo />
          Assay
        </span>
        <span className="tagline">Pay for proof, not promises.</span>
        <span className="sp" />
        {FIXTURES ? <Pill tone="fx">fixture · not on-chain</Pill> : <Pill tone="ok">solana devnet</Pill>}
        <button className="btn" type="button" onClick={p.onExit}>
          Exit
        </button>
      </div>
      <div className="stage-slide" key={i}>
        <section className="panel">{slides[i]![1]}</section>
      </div>
      <div className="stage-foot">
        <div className="sdots">
          {slides.map((_, n) => (
            <i key={n} className={n === i ? "on" : ""} />
          ))}
        </div>
        <span>
          {String(i + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")} · {slides[i]![0]} · ← → to move, esc to exit
        </span>
      </div>
    </div>
  );
}
