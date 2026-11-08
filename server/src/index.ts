import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { ATTACK_CARDS, DEMO_BUDGET, DEMO_GOAL } from "../../shared/types.ts";
import { OwnerClient } from "./chain/clients.ts";
import { PORT, chainConfigured, explorerTx, loadKey } from "./config.ts";
import "./db.ts";
import {
  closeMission,
  getMission,
  health,
  honesty,
  planMission,
  quotesFor,
  receipts,
  recoverMission,
  recoverStuck,
  runAttacks,
  runMission,
  signMission,
  warmup,
} from "./engine.ts";
import { eventsFor, subscribe } from "./sse.ts";

const app = new Hono();
app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  // Anchor and web3.js reject with plain objects; String() would hide them.
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Any uncaught route error becomes JSON so the UI can show the reason. */
app.onError((e, c) => c.json({ error: message(e) }, 500));

app.get("/api/health", async (c) => {
  try {
    return c.json(await health());
  } catch (e) {
    return c.json({ error: message(e) }, 500);
  }
});

app.post("/api/plan", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { goal?: string; budget?: string };
    const mission = await planMission(body.goal || DEMO_GOAL, body.budget || DEMO_BUDGET);
    const quotes = await quotesFor(mission.lines);
    return c.json({ mission, quotes });
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.post("/api/missions/:id/sign", async (c) => {
  try {
    return c.json(await signMission(c.req.param("id")));
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.post("/api/missions/:id/run", async (c) => {
  try {
    return c.json(await runMission(c.req.param("id")));
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.post("/api/missions/:id/close", async (c) => {
  try {
    return c.json(await closeMission(c.req.param("id")));
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.post("/api/missions/:id/recover", async (c) => {
  try {
    return c.json(await recoverMission(c.req.param("id")));
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

/** Settle open orders on every mission a failed run left in `running`. */
app.post("/api/recover", async (c) => {
  try {
    return c.json({ results: await recoverStuck() });
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.get("/api/missions/:id", (c) => {
  try {
    return c.json(getMission(c.req.param("id")));
  } catch (e) {
    return c.json({ error: message(e) }, 404);
  }
});

app.get("/api/missions/:id/quotes", async (c) => {
  try {
    const mission = getMission(c.req.param("id"));
    return c.json({ quotes: await quotesFor(mission.lines) });
  } catch (e) {
    return c.json({ error: message(e) }, 404);
  }
});

app.get("/api/missions/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    for (const ev of eventsFor(id)) {
      await stream.writeSSE({ event: "mission", data: JSON.stringify(ev) });
    }
    await new Promise<void>((resolve) => {
      const unsub = subscribe(id, (ev) => {
        void stream.writeSSE({ event: "mission", data: JSON.stringify(ev) });
      });
      stream.onAbort(() => {
        unsub();
        resolve();
      });
    });
  });
});

app.post("/api/warmup", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { n?: number };
  try {
    return c.json({ results: await warmup(body.n ?? 10) });
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.post("/api/attacks", async (c) => {
  try {
    return c.json({ cards: ATTACK_CARDS, runs: await runAttacks() });
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.get("/api/attacks", (c) => c.json({ cards: ATTACK_CARDS }));

app.get("/api/providers", async (c) => {
  try {
    return c.json({ providers: await honesty() });
  } catch (e) {
    return c.json({ error: message(e) }, 400);
  }
});

app.get("/api/receipts", (c) => {
  try {
    const rows = receipts().map((r) => ({ ...r, explorerUrl: explorerTx(r.tx) }));
    return c.json({ receipts: rows });
  } catch (e) {
    return c.json({ error: message(e) }, 500);
  }
});

app.post("/api/setup/register", async (c) => {
  const err = chainConfigured();
  if (err) return c.json({ error: err }, 400);
  const owner = new OwnerClient();
  const sigs = [];
  for (const name of ["alpha", "deep", "premium"] as const) {
    try {
      sigs.push({ name, tx: await owner.registerProvider(loadKey(name).publicKey) });
    } catch (e) {
      // Re-registering is a no-op, so report it instead of failing the batch.
      sigs.push({ name, tx: null, note: message(e) });
    }
  }
  return c.json({ sigs });
});

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Mandate server http://localhost:${PORT}`);
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other API process and retry.`);
  } else {
    console.error(`Server failed to start: ${e.message}`);
  }
  process.exit(1);
});

/** A rejected background promise must not take the API down mid-demo. */
process.on("unhandledRejection", (reason) => {
  console.error(`Unhandled rejection: ${message(reason)}`);
});
