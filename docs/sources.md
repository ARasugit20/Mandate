# Where this repo’s contents came from

Assay is the Cursor Cloud Agent that curated Mandate before this GitHub checkout existed.

- Cloud agent: [Assay](https://cursor.com/agents/bc-c4f7a084-4ef7-461f-aa28-65d0bc7c282a) (`bc-c4f7a084-4ef7-461f-aa28-65d0bc7c282a`)
- Agent store (local sync): `~/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/bc-c4f7a084-4ef7-461f-aa28-65d0bc7c282a/files`
- Base44 UI: https://pay-mandate-proof.base44.app
- Base44 editor: https://app.base44.com/apps/6aee2cc64ec5eebfbace61f2

Copied into this repo:

| Here | From Assay |
| --- | --- |
| `docs/composer-build-plan.md` | `docs/composer-build-plan.md` (authoritative spec, Gates A–F) |
| `notes.md` | `notes.md` (MND-1 … MND-11 task board) |
| `docs/ui/*.png` | Assay’s three UI screenshots of the Base44 preview |

Not in Assay’s store yet (do not invent them):

- `internal/program-interface.md`
- `internal/mandate-idl.json`
- `internal/api-contract.md`
- Base44 export (`app/src/lib/api.ts`, `app/src/lib/types.ts`)

A parallel cloud worker, [Mandate server and scripts (fork)](https://cursor.com/agents/bc-77c8093d-e81c-497a-95ff-5f9d037d5c85), was launched from Assay to implement Gate C and Gate D. Reconcile against it before duplicating that work.

This GitHub repo (`ARasugit20/Mandate`) is the one Assay’s MND-5 was waiting on.
