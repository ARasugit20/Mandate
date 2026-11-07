# Mandate — Composer build plan

Pay for proof, not promises. An owner signs a small purchase plan. An agent may only `purchase` inside it. A verifier is the only key that `settle`s. Payment follows a verified score, not the seller’s claim. Token is our own devnet SPL mint, dUSDC, 6 decimals.

Deadline pressure: ship a working devnet demo. Gates run in order and do not mark done if the check fails.

Base44 was a throwaway mock for layout ideas. This repo owns `app/`. Do not export, embed, or depend on Base44.

## Product UI we are building

Dark local Vite app. Copy and structure follow the mock:

- Mission Control: goal, $1 budget, Plan / Run demo, live timeline, three quote cards (Alpha / Deep / Premium) with claim, ECS, p(success), E(pay).
- Attack Lab: all 10 attacks visible (two rows of five). Header `n / 10` from real runs only. Each card names the program error.
- Setup: health rows are `pass`, `fail`, or an explicit error. Include **Agent dUSDC = 0**. Secret *names* only. Register providers and Warm up 10 missions.
- Providers & Honesty and Receipts: live data, empty until warmup/missions exist.

Live-mode rules:

1. Quotes, timeline, and “Alpha chosen” stay empty until a real plan exists. No fixture panels.
2. Setup never shows a dash for unknown chain.
3. Every tx link is a devnet Explorer URL returned by the server. Never invent a signature.

## Repo

```
app/        Vite + React frontend (src/lib/api.ts + src/lib/types.ts is the API contract)
program/    Anchor workspace (programs/mandate, tests/)
server/     Node 20 + TypeScript + Hono + better-sqlite3 + SSE
scripts/    keys, mint, atas, register, warmup, demo-check
.keys/      gitignored keypairs, server-only
shared/     types used by app and server
```

Do not change the API contract on one side only.

## Non-negotiables

1. No fake signatures, balances, or honesty scores. Unconfigured chain calls return an error or `unknown`.
2. Three roles: `owner` (create, register, close), `agent` (only `purchase`; SOL for fees; never a dUSDC ATA), `verifier` (only `settle`). Keys in `.keys/*.json`.
3. Only `server/src/chain/*` signs. `AgentClient` has no `settle` method.
4. Program stays under ~450 lines. No instructions beyond the five below.

## Gate A — Toolchain (Linux or macOS)

Pin Anchor **0.32.1** in `Anchor.toml` and the JS client. `solana config set --url devnet`.

`scripts/keys.ts` creates, if missing: owner, agent, verifier, alpha, deep, premium, attacker, impostor. Print pubkeys.

Fund owner, agent, verifier with devnet SOL. If `solana airdrop` is rate-limited, print the three pubkeys and stop with `NEED_SOL`. Do not pretend the balance is funded. Gate B (localnet tests) does not need this airdrop.

**Check:** `rustc`, `solana`, and `anchor` versions print. After funding, each role key has at least 0.5 SOL.

## Gate B — Program (localnet first)

Accounts: `Mandate`, `Line`, `Order`, `ProviderStats` (lines max 6, categories 0–3).

PDAs: `["mandate", owner, mission_id le]`, vault = ATA of the mandate PDA, `["order", mandate, order_id le]`, `["provider", owner, provider]`.

Error names (constraints / `has_one`, not a generic ConstraintSeeds):

`NotAgent`, `NotVerifier`, `NotOwner`, `MandateExpired`, `MandateClosed`, `NoMatchingLineItem`, `OverUnitPrice`, `LineBudgetExceeded`, `ProviderNotRegistered`, `OrderAlreadySettled`, `InvalidScore`, `PendingOrders`.

1. `create_mandate` — owner. `expires_at > now`, 1–6 lines, sum of line budgets = total. Init mandate + vault, `transfer_checked` total into the vault.
2. `register_provider` — owner. Init `ProviderStats`.
3. `purchase` — signer is `mandate.agent`. Reserve `full_amount` on the line (`committed`). No token move. `full_at = 90`. `half_at = line.min_score`. Half is disabled when `min_score >= 90`.
4. `settle` — signer is `mandate.verifier`. Pay full if score ≥ 90, else half if half is enabled and score ≥ `half_at`, else 0. Move tokens only when pay > 0. Update line, mandate, order, provider stats. Emit `Settled`.
5. `close_mandate` — owner, and every line `committed == 0`. Sweep vault to owner. `closed = true`.

Tests in `program/tests/mandate.ts` via `anchor test` on **localnet**:

Happy path: create, register alpha/deep/premium, purchase, settle 93 (full), 80 (half), 61 (zero, funds stay), stats match, close returns the rest.

Attacks, exact error on the failing tx:

1. Attacker as provider → `ProviderNotRegistered`
2. Price above cap → `OverUnitPrice`
3. Repeat until the line overflows → `LineBudgetExceeded` on that tx
4. Bad `line_index` → `NoMatchingLineItem`
5. Random key settles → `NotVerifier`
6. Agent settles → `NotVerifier`
7. Second settle → `OrderAlreadySettled`
8. Mandate with `now+3s`, wait 5s, purchase → `MandateExpired`
9. Impostor provider → `ProviderNotRegistered`
10. Agent closes → `NotOwner`

Also: claimed 95, settled 61 → paid 0, stats updated.

**Check:** `anchor test` exits 0. Then deploy to devnet and copy IDL to `server/src/chain/idl/mandate.json`.

## Gate C — Devnet fixtures

`.env`: `SOLANA_RPC_URL`, `PROGRAM_ID`, `DUSDC_MINT`, `ANTHROPIC_API_KEY`, `PORT=8787`, `VERIFICATION_FEE=0.02`, `RETRY_PENALTY=0.03`.

- `mint.ts`: create dUSDC if unset, mint 100 to owner, print mint.
- `atas.ts`: ATAs for owner, alpha, deep, premium, attacker, impostor. No agent ATA.
- `register.ts`: register alpha, deep, premium only.
- `demo-check.ts`: one PASS/FAIL line per acceptance item.

**Check:** owner balance 100 dUSDC, three ProviderStats PDAs exist, agent dUSDC is 0 (no account, or balance 0).

## Gate D — Server

Match `app/src/lib/types.ts`. CORS for the Vite origin.

- `chain/`: `OwnerClient`, `AgentClient`, `VerifierClient`. `sendAndConfirm`. `sendExpectFail` (`skipPreflight: true`, confirm, read logs, return the Anchor error name). `readProviderStats`, `readMandate`.
- SQLite tables for missions, lines, quotes, decisions, orders, deliveries, verifications, events, attack runs, reference facts.
- SSE: every step writes a `MissionEvent` and publishes it.
- LLM: Anthropic, JSON validated with zod, one retry. Model ids in env, defaulting to current Haiku / Sonnet / Opus. Alpha = smallest, Deep = middle, Premium = largest, planner and rubric = middle. If a model 404s, stop and name the id; do not silently collapse all three to one model.
- `plan`: 3–4 lines, `minScore` in {75, 80, 85, 90}, budgets rescaled to the owner budget, 6 decimal places, `missionHash = sha256(goal + canonical lines)`.
- `quotes`: research defaults Alpha 95 @ 0.03, Deep 92 @ 0.08, Premium 98 @ 0.20; other categories use a fixed multiplier. Half = 50% of full, only if `minScore < 90`. Never shrink a quote to fit the cap. Over cap → `eligible: false`, `ineligibleReason: "OverUnitPrice"`.
- `ecs`: Laplace counts on that provider’s real settled receipts only.

```
P_full = (c_full + 1) / (n + 3)
P_half = (c_half + 1) / (n + 3)   # 0 if half disabled
P_zero = 1 - P_full - P_half
p = P_full + P_half
E = full*P_full + half*P_half
ECS = (E + VERIFICATION_FEE + RETRY_PENALTY*(1-p)) / p
```

Pick lowest ECS among eligible quotes. Explanation cites **proven** mean verified score, or “No proof yet — trusting the claim.” when that provider has fewer than 3 receipts.

- `deliver`: Alpha prompt constant `DEMO_ADVERSARY` (confident, invents numbers). Output `{ markdown, claims }`.
- `verify`: `factScore` in code, match reference facts within 2%, else null. `rubricScore` from the LLM. `final = factScore == null ? rubric : round(0.7*fact + 0.3*rubric)`.
- `runMission`: per line, at most 2 purchases. If verified < minScore and the line still has room, re-quote with updated history. `act` is 1, 2, or 3. Owner closes via endpoint, not automatically.
- `warmup`: N real missions, providers round-robin, not ECS. No history row without a confirmed settle tx.
- `attacks`: the 10 lab cases through `sendExpectFail`. Overclaim is a real Alpha purchase settled low. `outcome: "unexpected"` when the error name differs. Return tx signature and logs.

Demo mission: goal `Research NVIDIA and write a short investment brief`, budget `1` dUSDC, research line `maxUnitPrice = 0.10` so Premium is ineligible at $0.20.

**Check:** curl each route. One CLI mission prints create, purchase, settle, and close with Explorer links. Attack table prints expected vs actual.

## Gate E — Frontend

`app/.env.local`: `VITE_API_URL=http://localhost:8787`. Root scripts: `dev`, `test:program`, `setup`, `warmup`, `demo:check`.

**Check:** plan → sign → run shows three acts from SSE, and Explorer links resolve. `grep` the production build for `.keys` and secret key bytes; must be empty.

## Gate F — Stage

`warmup` 10. Providers & Honesty shows Alpha’s gap from those receipts (claimed high, verified lower). README: pitch, owner/agent/verifier diagram, how to run, attack table, limits (team-held verifier, team-run LLM providers, per-owner registry), program id.

## Acceptance (`npm run demo:check`)

Each line prints PASS or FAIL. FAIL stops the script with exit 1.

- `anchor test` includes all 10 errors by name
- Program id on devnet matches `PROGRAM_ID` and the README
- One mission has real create, purchase, settle, and close signatures
- Agent dUSDC is 0; `AgentClient` source has no settle instruction
- One Alpha settle paid 0 and ProviderStats moved
- An over-cap quote is ineligible and its price is unchanged
- A post-warmup explanation string contains a proven score, not only the claim
- Attack lab endpoint returns 10 expected outcomes and 10 signatures
- Frontend build contains no key material
