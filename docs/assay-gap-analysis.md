# Assay gap analysis

Audit date: 2026-11-07. Product name in the repo is still Mandate. This file classifies the existing code against the frozen Assay brief. No product behavior was changed for this audit.

Runtime check at audit time:

- UI listening on `localhost:5173`
- API listening on `localhost:8787`
- `GET /api/health` returns JSON (`ok: false` because `PROGRAM_ID`, `DUSDC_MINT`, and `ANTHROPIC_API_KEY` are empty and role wallets have 0 SOL)
- `npm run test:server`: 7/7 pass (`server/test/math.test.ts`)
- `npm run typecheck -w server`: fails. `server/src/chain/clients.ts` imports `bn.js` and there is no `@types/bn.js`
- `app` production build: succeeds (`vite build`)
- `anchor` CLI: not installed
- `solana` CLI: not installed
- `cargo`: present

## 1. Signed Mandate — PARTIAL

Owner signs a line-item plan once. The agent and verifier pubkeys are stored on the mandate. The agent cannot rewrite lines.

- Program: `create_mandate` in `program/programs/mandate/src/lib.rs` (owner signer, expiry, 1–8 lines, hash not stored on chain; lines are the authority).
- Server: `signMission` in `server/src/engine.ts` calls `OwnerClient.createMandate` (`server/src/chain/clients.ts`).
- UI: “Sign mandate” in `app/src/App.tsx`.
- Missing for the brief: no human wallet signature. The server holds `owner.json` and signs for the human. Copy still says Mandate, not a one-time human signature ceremony.

## 2. Program-controlled vault — COMPLETE (code) / UNVERIFIED (devnet)

`create_mandate` moves the owner’s dUSDC into the mandate token account. `settle` pays the provider from that account. `close_mandate` returns the remainder to the owner. Accounts are in `lib.rs` (`mandate_token`, `owner_token`, `provider_token`). Never executed against a deployed program in this environment.

## 3. Agent holds zero dUSDC — PARTIAL

Health row “Agent holds 0 dUSDC” is implemented in `health()` (`server/src/engine.ts`) via `dusdcBalance`. The program never transfers treasury tokens to the agent; the agent only pays SOL fees. Unverified on devnet because `DUSDC_MINT` is unset, so the row is `error`, not `pass`.

## 4. Line-item authorization — COMPLETE (code) / UNVERIFIED (chain)

`purchase` checks agent signer, open mandate, expiry, line index, category, unit-price cap, and remaining line budget (`lib.rs`). Same checks are the attack cases in `runAttacks` (`server/src/engine.ts`) and `program/tests/mandate.ts`. Local Anchor tests have not been run (`anchor` missing).

## 5. Expected Cost of Success — COMPLETE (off-chain)

`ecs()` and `quoteLine()` in `server/src/math.ts`. Laplace smoothing `(c+1)/(n+3)`, expected pay, verification fee, retry penalty. Unit tests cover no-history and half-disabled cases. Used when building quotes in `quotesFor` (`server/src/engine.ts`). Not an on-chain rule. The UI shows a raw ECS number, not the “why Deep” comparison.

## 6. Provider comparison — PARTIAL

Three server-side providers: alpha, deep, premium. Prices and claimed scores are constants in `RESEARCH_QUOTES` inside `server/src/math.ts`. `runMission` picks the eligible quote with the lowest ECS. The quotes panel lists claim, ECS, and P(success). There is no side-by-side “Alpha cheaper per attempt but worse expected cost” explanation, and no explicit selected-provider callout beyond the timeline.

## 7. Plain-language provider explanation — PARTIAL

`quoteLine` sets `explanation` to either “No proof yet — trusting the claim.” or “Proven mean verified score X over N receipts.” That is one sentence per provider, not the structured economic comparison in the brief.

## 8. Machine Contract representation — MISSING

An order account exists (`Order` in `lib.rs`: provider, claimed score, full/half amounts, half flag, score, paid, settled). Nothing in `app/src/App.tsx` renders that order as a contract (buyer, seller, purpose, quote, promise, verifier, payment curve, parent mandate, status) before execution.

## 9. Evidence-based verification — PARTIAL

`factScore` compares numeric claims to `NVIDIA_FACTS` within 2% (`server/src/math.ts`). `blendScore` is `0.7 * fact + 0.3 * rubric`. Delivery and rubric scores come from Claude (`llmDeliver`, `llmRubric` in `server/src/llm.ts`). Facts live in SQLite via `server/src/db.ts`. There is no evidence drawer, no per-claim PASS/FAIL (revenue, EPS, quarter, citation, structure, unsupported claim), and no source/tolerance display. Alpha’s bad output depends on the LLM prompt, not a deterministic fixture.

## 10. Quality-contingent settlement — COMPLETE (code) / UNVERIFIED (devnet)

`settle` in `lib.rs`: score `>= full_at` (90) pays 100%; if half is enabled and score `>= half_at` pays 50%; otherwise pays 0. Only the verifier key may call it. Server path: `VerifierClient.settle` from `runMission`. Curve is not shown in the UI before purchase.

## 11. Provider statistics — COMPLETE (code) / UNVERIFIED (devnet)

`ProviderStats` stores `n`, `c_full`, `c_half`, `c_zero`, `sum_claimed`, `sum_verified` and is updated in `settle`. Read by `readProviderStats` (`server/src/chain/clients.ts`) and `honesty()` (`server/src/engine.ts`).

## 12. Calibration reputation — PARTIAL

`honesty()` returns claimed mean, verified mean, and the three counters. Providers screen (`app/src/App.tsx`) prints those numbers. Missing: calibration gap, labels (well calibrated / systematic overclaimer / reliable but expensive), and copy framed as promises vs delivers. Stats are empty until warmup or a real mission runs.

## 13. Ignore-Assay / buy-cheapest override — MISSING

`runMission` always purchases the lowest-ECS eligible quote. No override endpoint, no “Ignore Assay — buy cheapest” control, no path that forces Alpha while recording that the human overrode the recommendation.

## 14. Counterfactual comparison — MISSING

No UI or API compares the recommended provider’s expected cost with the override’s actual score, amount paid, and retry.

## 15. Receipts — PARTIAL

`receipts()` reads the `receipts` table (`server/src/engine.ts`, `server/src/db.ts`). The Receipts tab lists provider, verified score, paid amount, and an explorer link. Missing purpose, promised quality, quoted price, verification status, parent mandate, and a “promised / proven / paid” layout.

## 16. Providers & Honesty — PARTIAL

Route and tab exist (`GET /api/providers`, “Providers & Honesty” in `App.tsx`). It is a numeric table (jobs, claimed, verified, full/half/zero counts), not a promised-vs-proven honesty view.

## 17. Attack Lab — PARTIAL

Tab, `ATTACK_CARDS` (`shared/types.ts`), `POST /api/attacks`, and `runAttacks` exist. The badge says `ATTACKS STOPPED n / 10`, which treats the overclaim case as “stopped” even though that case is meant to settle at zero. Cards do not show the explorer link that the API already returns (`explorerUrl`). Lab has not been run: no program id.

## 18. Ten attacks — COMPLETE (specified) / UNVERIFIED (executed)

All ten are named in `ATTACK_CARDS` and implemented in `runAttacks`:

| Name | Expected |
| --- | --- |
| injected_transfer | ProviderNotRegistered |
| over_unit_price | OverUnitPrice |
| loop_drain | LineBudgetExceeded |
| off_plan_purchase | NoMatchingLineItem |
| fake_verifier | NotVerifier |
| agent_settles | NotVerifier |
| double_settlement | OrderAlreadySettled |
| expired_mandate | MandateExpired |
| impostor_provider | ProviderNotRegistered |
| overclaim | paid 0 (economic, not a rejected tx) |

`program/tests/mandate.ts` covers happy path, full/half/zero payment, stats, and these failures. Not executed: `anchor` is not installed.

## 19. Real Devnet transaction links — PARTIAL

`explorerTx` in `server/src/config.ts` builds `https://explorer.solana.com/tx/{sig}?cluster=devnet`. Timeline events and attack runs attach it when a signature exists. No devnet transactions exist yet (`PROGRAM_ID` empty, program id in `program/Anchor.toml` is the Anchor placeholder `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS`).

## 20. Mission completion summary — MISSING

`closeMission` closes the mandate on chain and marks the row closed. The UI has no budget / spent / returned / providers considered / purchased / dishonest work rejected / average verified quality / attacks handled summary.

## 21. UI state handling — PARTIAL

`App.tsx` has busy and error strings, empty states (“Awaiting signature”), status pills, and SSE via `GET /api/missions/:id/events`. Still one dark terminal layout (`app/src/styles.css`). No per-screen loading/error split, no machine-contract or evidence states. Visual direction in the brief (light, Stripe/Linear) is not started, on purpose.

## 22. Setup/health checks — PARTIAL

`health()` checks signing backend, RPC, program account, IDL file, owner/agent/verifier SOL, owner dUSDC, agent dUSDC == 0, three providers registered, Anthropic key. Setup tab can refresh, register providers, and warm up 10 missions. It does not run mint or ATA creation (those are CLI scripts: `scripts/mint.ts`, `scripts/atas.ts`). Health currently reports the expected unset-env errors.

## 23. Current server startup blocker — COMPLETE

The previous crash (`import { BN } from "@coral-xyz/anchor"` in `server/src/chain/clients.ts`) is fixed. Import is `import BN from "bn.js"`. The same change is in `program/tests/mandate.ts`. `bn.js` is a dependency of `server` and `program`. Both processes stay up. Follow-up, not a boot blocker: server `tsc` fails with TS7016 because `@types/bn.js` is not installed.

## 24. Anchor build/test status — UNVERIFIED

`program/Anchor.toml` pins Anchor `0.32.1`. Program source is `program/programs/mandate/src/lib.rs`. Tests are `program/tests/mandate.ts` (`anchor test` script is `npx tsx tests/mandate.ts`). `anchor` and `solana` CLIs are not on PATH, so `anchor build` and `anchor test` have not been run. Hand-written IDL remains `server/src/chain/idl/mandate.json`.

## 25. Devnet deployment status — MISSING

`.env` has empty `PROGRAM_ID`, `DUSDC_MINT`, and `ANTHROPIC_API_KEY`. `npm run setup:keys` has been run (`.keys/*.json` exist). Mint, ATA, register, warmup, and demo-check have not been run against a deployed program. No explorer links can be real until that happens.

## Brief features with no implementation

| Feature | Status |
| --- | --- |
| Machine Contract screen | MISSING |
| Evidence drawer | MISSING |
| Calibration labels | MISSING |
| Why this provider | MISSING (only the one-line quote explanation) |
| Ignore Assay / buy cheapest | MISSING |
| Counterfactual result | MISSING |
| Honesty visual (promised vs proven) | MISSING |
| Receipt audit layout | PARTIAL (see 15) |
| Attack copy “handled” vs “stopped” | MISSING |
| Mission complete story | MISSING |
| Light trust-infrastructure UI | MISSING (deferred until P0 is green) |
| Staking | Not present. Leave it that way. |
