import type { ReactNode } from "react";
import { fmt, txUrl } from "../lib/format";
import { FIXTURES } from "../lib/source";

export type Tone = "ok" | "warn" | "bad" | "acc" | "fx" | "muted";

export function Pill({ tone = "muted", dot = true, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`pill ${tone === "muted" ? "" : tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/**
 * The only way the app renders a transaction link. In fixture mode it renders
 * nothing at all; the banner already says there are no transactions.
 */
export function TxLink({ tx, href, label = "explorer" }: { tx: string | null | undefined; href?: string | null; label?: string }) {
  if (FIXTURES) return null;
  const url = href ?? txUrl(tx);
  if (!url) return <span className="txlink off">{label}: pending</span>;
  return (
    <a className="txlink" href={url} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  );
}

export function Money({ units, digits = 3 }: { units: number; digits?: number }) {
  return (
    <span>
      <span className="m">{fmt(units, digits)}</span> <span className="dim">dUSDC</span>
    </span>
  );
}

/** Live actions spend from the shared owner wallet, so they ask first. */
export function ConfirmBar({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="banner confirm" role="alert">
      <span>{text}</span>
      <span className="sp" />
      <button className="btn" type="button" onClick={onNo}>
        Cancel
      </button>
      <button className="btn pri" type="button" onClick={onYes}>
        I posted in chat, go
      </button>
    </div>
  );
}

/** Tick and cross drawn as SVG; IBM Plex has no glyph for them. */
export function Mark({ ok, size = 12 }: { ok: boolean; size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 12 12" aria-label={ok ? "passed" : "failed"} role="img">
      <path d={ok ? "M2.2 6.4l2.4 2.4 5.2-5.6" : "M3 3l6 6M9 3l-6 6"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="0.75" />
      <path d="M10.5 16.5l4 4 7-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
