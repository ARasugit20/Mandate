# Mandate

Pay for proof, not promises. An owner signs a small purchase plan. An agent may only `purchase` inside it. A verifier is the only key that `settle`s. Payment follows a verified score, not the seller’s claim. Token is our own devnet SPL mint, **dUSDC** (6 decimals).

Solana Hackathon · AI Track. Devnet only. No mainnet funds.

Spec and task board came from the [Assay](https://cursor.com/agents/bc-c4f7a084-4ef7-461f-aa28-65d0bc7c282a) cloud agent. **This repo is the real build** — local Vite UI, Anchor program, Node server. An old Base44 mock was layout inspiration only.

## Read these first

1. [`docs/composer-build-plan.md`](docs/composer-build-plan.md) — gated build (A → F)
2. [`notes.md`](notes.md) — MND task board
3. [`docs/ui-audit.md`](docs/ui-audit.md) — what the mock faked vs live mode

## Layout

```
app/        Vite + React (Mission Control, Attack Lab, Setup, Providers, Receipts)
program/    Anchor 0.32.1 (`programs/mandate`, `tests/mandate.ts`)
server/     Hono + SQLite + SSE + chain clients + engine
scripts/    keys, mint, atas, register, warmup, demo-check
shared/     API types shared with the app
.keys/      gitignored role keypairs (server-only)
```

## Quick start

```bash
npm install
cp .env.example .env   # fill SOLANA_RPC_URL, PROGRAM_ID, DUSDC_MINT, ANTHROPIC_API_KEY after deploy
npm run setup:keys
npm run dev              # server :8787 + app :5173
```

Gate A/B (toolchain + program):

```bash
# Install Solana CLI + Anchor 0.32.1, then:
cd program && anchor test
# deploy to devnet, set PROGRAM_ID in .env, copy fresh IDL to server/src/chain/idl/mandate.json
npm run setup:mint
npm run setup:atas
npm run setup:register
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run test:server` | ECS / verify math unit tests |
| `npm run test:program` | Localnet mandate + attack tests |
| `npm run warmup` | 10 real missions (server must be up) |
| `npm run demo:check` | Acceptance checklist |

## Architecture

```mermaid
flowchart LR
  Owner -->|create/register/close| Program
  Agent -->|purchase only| Program
  Verifier -->|settle only| Program
  App -->|REST + SSE| Server
  Server -->|signs| Program
  Server -->|plan/deliver/verify| LLM
```

## Limits (honest)

- Verifier key is team-held (demo).
- LLM “providers” Alpha / Deep / Premium are server prompts, not third-party wallets.
- Provider registry is per-owner on chain.
- Default program id in repo is local placeholder until devnet deploy.
