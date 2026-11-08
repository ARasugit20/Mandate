import { useEffect, useRef, useState } from "react";

/** Counts up to a number when it changes. Respects reduced motion. */
export function CountUp({ value, digits = 0, ms = 700 }: { value: number; digits?: number; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min((t - start) / ms, 1);
      setShown(a + (value - a) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{shown.toFixed(digits)}</>;
}

/**
 * Claim vs proof on one 0–100 rule: the claim tick above, the verified bar
 * below, the gap between them hatched, and the line minimum dashed in gold.
 */
export function ProofScale({ claimed, verified, min }: { claimed: number | null; verified: number | null; min?: number }) {
  const gap = claimed != null && verified != null ? claimed - verified : 0;
  return (
    <div className="scale" aria-label={`Claims ${claimed ?? "unknown"}, proves ${verified ?? "unknown"}`}>
      <div className="trk" />
      {verified != null && <div className="ver" style={{ width: `${verified}%` }} />}
      {verified != null && gap > 3 && <div className="gap" style={{ left: `${verified}%`, width: `${gap}%` }} />}
      {min != null && <div className="min" style={{ left: `${min}%` }} title={`Line minimum ${min}`} />}
      {claimed != null && (
        <span className="mk" style={{ left: `${claimed}%` }}>
          claims {Math.round(claimed)}
        </span>
      )}
      {verified != null ? (
        <span className="mk v" style={{ left: `${verified}%` }}>
          proves {Math.round(verified)}
        </span>
      ) : (
        <span className="mk v" style={{ left: "0%", transform: "none" }}>
          no verified jobs yet
        </span>
      )}
    </div>
  );
}

/** Payout share for a score, the same curve the program enforces. */
export function shareFor(score: number, min: number) {
  if (score >= 90) return 1;
  if (min < 90 && score >= min) return 0.5;
  return 0;
}

/** The payment curve as a step chart, with the verified score plotted on it. */
export function CurveChart({ min, score }: { min: number; score: number | null }) {
  const W = 460;
  const H = 214;
  const l = 44;
  const r = 14;
  const t = 34;
  const b = 30;
  const x = (s: number) => l + ((Math.max(50, Math.min(100, s)) - 50) / 50) * (W - l - r);
  const y = (v: number) => t + (1 - v) * (H - t - b);
  const half = min < 90;
  const path = half
    ? `M${x(50)},${y(0)} H${x(min)} V${y(0.5)} H${x(90)} V${y(1)} H${x(100)}`
    : `M${x(50)},${y(0)} H${x(90)} V${y(1)} H${x(100)}`;
  const sc = score == null ? null : shareFor(score, min);
  const ticks = [50, min, 90, 100].filter((v, i, a) => a.indexOf(v) === i);
  const right = score != null && x(score) > W * 0.6;
  return (
    <svg className="cc" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Payment curve, minimum ${min}${score != null ? `, scored ${score}` : ""}`}>
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line className="gl" x1={l} x2={W - r} y1={y(v)} y2={y(v)} />
          <text className="tl" x={l - 8} y={y(v) + 4} textAnchor="end">
            {v * 100}%
          </text>
        </g>
      ))}
      <rect className="z" x={x(50)} y={t} width={x(min) - x(50)} height={H - t - b} />
      {half && <rect className="h" x={x(min)} y={t} width={x(90) - x(min)} height={H - t - b} />}
      <rect className="f" x={x(90)} y={t} width={x(100) - x(90)} height={H - t - b} />
      <path className="ln" d={path} />
      {ticks.map((v) => (
        <text key={v} className="tl" x={x(v)} y={H - 8} textAnchor="middle">
          {v}
        </text>
      ))}
      {score != null && sc != null && (
        <g>
          <line className="drop" x1={x(score)} x2={x(score)} y1={t} y2={H - b} />
          <circle className="dot" cx={x(score)} cy={y(sc)} r={8} />
          <text className="lab" x={right ? x(score) - 12 : x(score) + 12} y={y(sc) - 14} textAnchor={right ? "end" : "start"}>
            score {score} → pays {sc * 100}%
          </text>
        </g>
      )}
    </svg>
  );
}

/** Engraved hallmark. Green when paid in full, ochre at half, oxblood when rejected. */
export function Seal({ score, kind, size }: { score: number; kind: "full" | "half" | "zero"; size?: number }) {
  const col = kind === "zero" ? "var(--rej)" : kind === "half" ? "var(--part)" : "var(--paid)";
  const word = kind === "zero" ? "REJECTED" : kind === "half" ? "HALF PAY" : "ASSAYED";
  const id = `arc-${kind}-${score}`;
  return (
    <svg className="seal" viewBox="0 0 120 120" role="img" aria-label={`${word} ${score}`} style={size ? { width: size, height: size } : undefined}>
      <defs>
        <path id={id} d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0" />
      </defs>
      <circle cx="60" cy="60" r="57" fill="var(--paper)" stroke={col} strokeWidth="1.5" />
      <circle cx="60" cy="60" r="51" fill="none" stroke={col} strokeWidth="0.75" />
      <circle cx="60" cy="60" r="34" fill="none" stroke={col} strokeWidth="0.75" />
      <text fontSize="8.6" letterSpacing="1.2" fontFamily="IBM Plex Mono, monospace" fill={col}>
        <textPath href={`#${id}`}>{`${word} · VERIFIER KEY · ${word} · DEVNET ·`}</textPath>
      </text>
      <text x="60" y="70" textAnchor="middle" fill={col} fontSize="30" fontWeight="400" fontFamily="IBM Plex Sans, Helvetica Neue, sans-serif">
        {score}
      </text>
    </svg>
  );
}
