/**
 * Walks one demo mission as far as the current configuration allows and prints
 * every real transaction with an Explorer link.
 */
import { llmKey, llmMissingMessage } from "../server/src/config.ts";
import { DEMO_BUDGET, DEMO_GOAL } from "../shared/types.ts";

const BASE = `http://localhost:${process.env.PORT ?? "8787"}`;

async function post(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: DEMO_GOAL, budget: DEMO_BUDGET }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function main() {
  console.log(`LLM key: ${llmKey() ? "set" : "NOT set"}`);

  const planned = await post("/api/plan");
  const mission = planned.body.mission as { id: string; chainMissionId: string } | undefined;
  if (!mission) {
    console.log("plan failed:", planned.body.error);
    return;
  }
  console.log(`plan        : mission ${mission.id}`);

  const signed = await post(`/api/missions/${mission.id}/sign`);
  console.log(`sign        : HTTP ${signed.status} ${signed.body.error ?? "ok"}`);

  const ran = await post(`/api/missions/${mission.id}/run`);
  console.log(`run         : HTTP ${ran.status} ${ran.body.error ?? "ok"}`);

  const closed = await post(`/api/missions/${mission.id}/close`);
  console.log(`close       : HTTP ${closed.status} ${closed.body.error ?? "ok"}`);

  const final = (await (await fetch(`${BASE}/api/missions/${mission.id}`)).json()) as {
    status: string;
    events: Array<{ type: string; message: string; tx: string | null; explorerUrl: string | null }>;
  };
  console.log(`\nfinal status: ${final.status}`);
  console.log("transactions:");
  for (const ev of final.events) {
    if (ev.tx) console.log(`  ${ev.type.padEnd(10)} ${ev.message}\n    ${ev.explorerUrl}`);
  }
  if (!final.events.some((e) => e.tx)) console.log("  none recorded");

  if (!llmKey()) {
    console.log(
      `\nStopped before the purchase: ${llmMissingMessage()}, so delivery and\n` +
        "verification cannot run. Purchasing first would commit vault funds that\n" +
        "only the verifier can release, so the run is refused up front.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
