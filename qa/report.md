# QA report card

Date: 2026-11-07. Devnet. Program `D2cW4yDMEP8aCxLEtuqifxJavNWYom2Nmx3GdSNRUsEG`, mint `HshAdQKWTHjLNfsF7PwN8E5NvXDpzDHEcybhbcE2fd15`. No features added.

## Grade

| Area | Status |
| --- | --- |
| Mission Control | works, minus the purchase step |
| Providers & Honesty | works, no data yet |
| Attack Lab | works, 10/10 on real devnet |
| Receipts | works, empty until a mission settles |
| Setup | works |
| Server stability | works |
| Endpoints | 14/15, the miss needs an API key |
| Full demo mission | blocked, no API key |

Everything that does not need an LLM key is green. One real purchase has never completed, because delivery and scoring are the only steps that require the key.

## Checks run

| Check | Result |
| --- | --- |
| `npm run test:server` | 7/7 pass |
| `tsc` server | clean |
| `tsc` app | clean |
| `npm run build -w app` | builds |
| `anchor test` (localnet) | happy path and all 10 attack cases pass |
| `npm run smoke` | 14/15 |
| `npm run qa:pages` | 5 pages, 0 console errors |
| `POST /api/attacks` (devnet) | 10/10 as expected, 10 Explorer links |

## Bugs found and fixed

These were real defects, not configuration.

**1. Attack Lab aborted on the first case.** `sendExpectFail` in `server/src/chain/send.ts` assumed `connection.confirmTransaction` returns the transaction error. web3.js rejects with the raw `TransactionError` instead, so the promise threw and the whole run died before any card reported. The API answered `{"error":"[object Object]"}`. Fixed by treating rejection as the expected outcome rather than a crash.

**2. Program errors came back as `unknown`.** Logs are not available the instant a transaction confirms, so `errorNameFromLogs` saw an empty array. Added a short retry and `errorNameFromTransactionError`, which maps the Anchor error code through the IDL's error table. A failure is now named even when logs are late.

**3. The fake verifier attack could not reach the program.** `settleExpectFail` in `server/src/chain/clients.ts` made the freshly generated impostor keypair the fee payer. With no SOL the transaction never executed, so the result was `unknown` rather than `NotVerifier`. A funded key now pays the fee while the impostor still signs the `verifier` account. The authorization check is unchanged: the program still compares the signing `verifier` account against `mandate.verifier`, and paying a fee grants no authority.

**4. Errors on non-`Error` objects printed `[object Object]`.** Anchor and web3.js reject with plain objects. `server/src/index.ts` now serializes them, and all seven routes share one serializer instead of repeating `e instanceof Error ? ... : String(e)`.

**5. A failed delivery could orphan committed funds forever.** `runMission` purchased on chain *before* calling the LLM. With no API key the purchase committed vault funds, delivery threw, and the order was left unsettled. `close_mandate` then failed with `PendingOrders` permanently, because only the verifier can release a commitment and the server has no resume path. `runMission` now refuses up front when `ANTHROPIC_API_KEY` is missing, so no order is created that cannot be settled. Four missions from before this fix are still stuck in `running`; see the known issues below.

**6. Register providers failed every time after the first.** `POST /api/setup/register` aborted the batch when a provider was already registered, which is the normal state. Re-registering is now reported per provider instead of failing.

**7. The UI could crash after a failed run.** `onRunDemo` in `app/src/App.tsx` used `ran!.id` after a run that may have returned undefined. Guarded.

**8. Provider and receipt loads had no error path.** `loadProviders` and `loadReceipts` called the API outside the `run()` wrapper, so a failure produced an unhandled rejection and no message. Both now report through the same error banner.

**9. Server typecheck failed.** `bn.js` had no type declarations after the earlier import fix. Added `@types/bn.js`.

## Stability requirements

**Never crash on a missing key or failed step.** Every route returns JSON. `app.onError` catches anything uncaught, and `process.on("unhandledRejection")` keeps a rejected background promise from taking the process down mid-demo. Verified:

```
POST /api/plan  {"goal":"Research Tesla"}
HTTP 400  {"error":"ANTHROPIC_API_KEY not set"}
```

**That exact message in the UI.** Confirmed in `qa/mission-control-error.png`: the banner reads `ANTHROPIC_API_KEY not set`. The string is identical end to end, since `server/src/llm.ts` throws exactly that text.

**The pill reflects only RPC and program.** `health()` returns a separate `chainOk` computed from `CHAIN_HEALTH_ROWS` in `shared/types.ts` (`RPC reachable`, `Program found at PROGRAM_ID`). `app/src/App.tsx` reads `chainOk` for the badge and no longer reads `ok`. Current state proves the split: `chainOk: true` with `ok: false`, and the pill reads DEVNET CONNECTED while the Anthropic row shows its error.

**One UI, one API, loud on a taken port.** `npm run dev` runs exactly one of each. The API exits 1 with `Port 8787 is already in use. Stop the other API process and retry.` Vite uses `strictPort: true`, so 5173 fails rather than silently sliding to 5174. Verified by starting a second API against the running one.

## Page by page

Screenshots in `qa/`. No console errors on any page.

**Mission Control — works, minus the purchase step.** `qa/mission-control.png`. Plan, sign, and close all execute against devnet with real Explorer links. Run is refused without an API key. The purchase plan, live timeline, and quotes panels render, and empty states read "Awaiting signature". Known gaps, all from the Assay brief rather than bugs: no Machine Contract view before execution, no evidence drawer, no "why this provider" explanation, no Ignore Assay override, no mission-complete summary.

**Providers & Honesty — works, no data yet.** `qa/providers-honesty.png`. All three providers render from on-chain `ProviderStats` with `n=0`, since no mission has settled. Three sequential RPC reads make the load slow enough to need a wait in automation. No empty state explaining that zeros mean "no verified history". No calibration gap or labels, which the brief asks for.

**Attack Lab — works, 10/10 on real devnet.** `qa/attack-lab.png`. Every card shows `Got` matching `Expected`: `ProviderNotRegistered`, `OverUnitPrice`, `LineBudgetExceeded`, `NoMatchingLineItem`, `NotVerifier` twice, `OrderAlreadySettled`, `MandateExpired`, `ProviderNotRegistered`, and overclaim settling at `paid 0`. Each run has a devnet signature and Explorer URL in the API response. Two accuracy problems remain, both copy and display rather than logic, and both already scoped in the Assay brief:

- The badge reads "ATTACKS STOPPED 10 / 10". Nine were blocked by the program; the overclaim was *not* blocked. It settled on chain and paid zero. The honest framing is 9 blocked, 1 economically punished, 10/10 handled.
- Cards drop the `explorerUrl` the API already returns, so the claim "a real devnet transaction" is not clickable.

**Receipts — works, empty until a mission settles.** `qa/receipts.png`. Renders "No settled receipts yet", which is accurate: the receipt row is written only after a verified settlement in `runMission`, and no mission has reached settlement. Attack Lab settlements intentionally do not create receipts. Per the brief the row should also show purpose, promised quality, quoted price, and parent mandate.

**Setup — works.** `qa/setup.png`. All eleven health rows report real state. Refresh and Register providers both succeed. Warm up needs an API key.

## End-to-end

**No LLM key is set, so the run stops before the purchase.** This is now deliberate, not a crash: purchasing would commit vault funds that only the verifier can release, so `runMission` refuses first. The rest of the lifecycle is real.

```
plan   : mission 61c512f9-0982-44bb-bb55-68a3fe30b1ca
sign   : HTTP 200 ok
run    : HTTP 400 ANTHROPIC_API_KEY not set
close  : HTTP 200 ok
status : closed
```

| Step | Transaction |
| --- | --- |
| Mandate created | [5iX67Fh…AfRbbE](https://explorer.solana.com/tx/5iX67FhXvv23xAKgmCFVGqMG4vkWTk8yE7kFsXmvCuWuymZNrr8hVbv1TBpJWxwaXDmJEApCn5sS4sfdQaAfRbbE?cluster=devnet) |
| Mandate closed, vault returned | [5TgsHFR…2uMvfz](https://explorer.solana.com/tx/5TgsHFRxP6inJ7J4a3t3kGKjogNuJ8nGLhGpRo2HaZ21hKEREze43wch544FxxagHwDoLTfn6uBpTHqZbL2uMvfz?cluster=devnet) |

Plus 10 attack transactions from the devnet Attack Lab run, each with an Explorer link in the `POST /api/attacks` response.

So the chain path is proven: the owner signs a mandate, funds enter the program vault, the program rejects every unauthorized purchase, a lying provider is paid zero, and closing returns the remainder. The only unproven link is paying a provider for *good* work, which needs the key.

Run `qa/e2e.ts` again once a key is set and it will walk plan, sign, run, settle, and close and print every signature.

## Key dependency versus real bug

| Item | Cause |
| --- | --- |
| `POST /api/warmup` fails | API key |
| `POST /api/missions/:id/run` returns 400 | API key |
| Custom goals cannot be planned | API key |
| Receipts empty | API key, downstream of run |
| Provider stats all `n=0` | API key, downstream of run |
| Verified quality and calibration unproven | API key |
| Items 1 through 9 above | real bugs, fixed |
| "ATTACKS STOPPED" wording | real inaccuracy, not fixed |
| Attack cards missing Explorer links | real gap, not fixed |
| Locked vault funds from open mandates | real gap, not fixed |
| Role SOL threshold brittle | real gap, not fixed |

## Known issues not fixed

Each is a product or design change rather than a stability fix, so none were touched in this pass.

**Attack Lab leaks vault funds.** Every run creates roughly nine mandates and never closes them. The owner started at 100 dUSDC and now holds 64, with the rest locked in 33 open mandates. Most are closable, but nothing calls `close_mandate` for them. Fix: close each mandate at the end of `runAttacks`, except the one with a deliberately unsettled order.

**Four missions are stuck in `running`.** These predate fix 5. Each has an on-chain order that was purchased but never settled, so `close_mandate` returns `PendingOrders`. The verifier key can still settle them, which would release the commitment, but no code path does it. Fix: a resume step that settles or zero-settles orphaned orders. Worth having regardless, because any mid-mission LLM failure recreates this.

**"ATTACKS STOPPED 10 / 10" overstates the result.** See Attack Lab above. Fix: derive the count from outcomes and label the overclaim as economically punished.

**Attack cards do not link transactions.** The API returns `explorerUrl`; `app/src/App.tsx` ignores it. Fix: render the link the card already has.

**Role SOL threshold is brittle.** `health()` fails any role below 0.5 SOL, so a role funded with exactly 0.5 fails after its first fee. Both the agent and the verifier failed this way during QA and needed topping up. Fix: lower the threshold to roughly 0.05 SOL, which is still far above what a demo spends.

**Reference facts have no endpoint.** The three NVIDIA facts that drive `factScore` live only in SQLite. The evidence drawer in the brief needs them over HTTP. `scripts/smoke.ts` reads the table directly and reports this.

**The owner signature is server-held.** `signMission` signs with `.keys/owner.json`, so "the human signs once" is not a wallet action. Known and documented in the README limits.

## Files added

- `scripts/smoke.ts`, `npm run smoke` — calls every endpoint and prints the table above
- `scripts/qa-pages.ts`, `npm run qa:pages` — Playwright sweep, screenshots to `qa/`
- `qa/e2e.ts` — walks one mission and prints transactions
- `qa/probe.ts` — isolates a single purchase, used to find bugs 1 through 3
- `qa/*.png` — one screenshot per page, plus the error banner
