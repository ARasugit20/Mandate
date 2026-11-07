/**
 * Calls every HTTP endpoint the app uses and prints one row per call.
 * Run with the server up: npm run dev, then npm run smoke.
 */
import { DEMO_BUDGET, DEMO_GOAL } from "../shared/types.ts";

const BASE = `http://localhost:${process.env.PORT ?? "8787"}`;

type Row = {
  endpoint: string;
  status: string;
  pass: boolean;
  error: string;
};

const rows: Row[] = [];

function errorOf(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return "";
}

async function call(
  endpoint: string,
  init: RequestInit | undefined,
  check?: (body: unknown) => string,
  expectStatus = 200,
): Promise<unknown> {
  const [method, path] = endpoint.split(" ");
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      method,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body stays a string */
    }
    const asExpected = res.status === expectStatus;
    const serverError = errorOf(body);
    const shapeError = res.ok && check ? check(body) : "";
    rows.push({
      endpoint,
      status: String(res.status),
      pass: asExpected && !shapeError && (res.ok ? !serverError : true),
      error: shapeError || (asExpected && !res.ok ? `expected ${expectStatus}: ${serverError}` : serverError),
    });
    return res.ok ? body : null;
  } catch (e) {
    rows.push({
      endpoint,
      status: "no response",
      pass: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** SSE never ends, so read the stream briefly and report what arrived. */
async function callEvents(missionId: string) {
  const endpoint = `GET /api/missions/${missionId}/events`;
  const label = "GET /api/missions/:id/events";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${BASE}${endpoint.split(" ")[1]}`, { signal: controller.signal });
    if (!res.ok || !res.body) {
      rows.push({ endpoint: label, status: String(res.status), pass: false, error: "no stream" });
      return;
    }
    const reader = res.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    void reader.cancel();
    const sawEvent = text.includes("event: mission");
    rows.push({
      endpoint: label,
      status: `${res.status} stream`,
      pass: res.ok,
      error: sawEvent ? "" : "connected, no mission event buffered",
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    rows.push({
      endpoint: label,
      status: aborted ? "200 stream" : "no response",
      pass: aborted,
      error: aborted ? "" : e instanceof Error ? e.message : String(e),
    });
  } finally {
    clearTimeout(timer);
  }
}

function need(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || !(key in body)) return `missing ${key}`;
  return "";
}

async function main() {
  const health = (await call("GET /api/health", undefined, (b) => need(b, "rows") || need(b, "chainOk"))) as
    | { rows: Array<{ name: string; status: string; detail: string }>; chainOk: boolean }
    | null;

  await call("GET /api/attacks", undefined, (b) => need(b, "cards"));
  await call("GET /api/providers", undefined, (b) => need(b, "providers"));
  await call("GET /api/receipts", undefined, (b) => need(b, "receipts"));

  const planned = (await call(
    "POST /api/plan",
    { body: JSON.stringify({ goal: DEMO_GOAL, budget: DEMO_BUDGET }) },
    (b) => need(b, "mission") || need(b, "quotes"),
  )) as { mission: { id: string } } | null;

  const anthropicReady =
    health?.rows.find((r) => r.name === "Anthropic")?.status === "pass";

  const missionId = planned?.mission.id;
  if (missionId) {
    await call(`GET /api/missions/${missionId}`, undefined, (b) => need(b, "lines"));
    await call(`GET /api/missions/${missionId}/quotes`, undefined, (b) => need(b, "quotes"));
    await callEvents(missionId);
    await call(`POST /api/missions/${missionId}/sign`, undefined, (b) => need(b, "status"));
    // Without an LLM key the run is refused before any purchase, so 400 is correct.
    await call(
      `POST /api/missions/${missionId}/run`,
      undefined,
      (b) => need(b, "status"),
      anthropicReady ? 200 : 400,
    );
    await call(`POST /api/missions/${missionId}/close`, undefined, (b) => need(b, "status"));
  } else {
    for (const path of ["", "/quotes", "/events", "/sign", "/run", "/close"]) {
      rows.push({
        endpoint: `/api/missions/:id${path}`,
        status: "skipped",
        pass: false,
        error: "plan failed, no mission id",
      });
    }
  }

  await call("GET /api/missions/does-not-exist", undefined, undefined, 404);
  await call("POST /api/setup/register", undefined, (b) => need(b, "sigs"));

  // Reference facts back the evidence score. There is no endpoint for them yet,
  // so read the local table instead.
  const { facts } = await import("../server/src/db.ts");
  const factRows = facts();
  rows.push({
    endpoint: "reference facts (db, no endpoint)",
    status: `${factRows.length} facts`,
    pass: factRows.length > 0,
    error: factRows.length ? "not exposed over HTTP" : "no reference facts stored",
  });

  const anthropic = health?.rows.find((r) => r.name === "Anthropic");
  const llmReady = anthropic?.status === "pass";
  if (llmReady) {
    await call("POST /api/warmup", { body: JSON.stringify({ n: 1 }) }, (b) => need(b, "results"));
  } else {
    rows.push({
      endpoint: "POST /api/warmup",
      status: "skipped",
      pass: false,
      error: anthropic?.detail ?? "ANTHROPIC_API_KEY not set",
    });
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const w = {
    endpoint: Math.max(8, ...rows.map((r) => r.endpoint.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };
  console.log(`${pad("ENDPOINT", w.endpoint)}  ${pad("STATUS", w.status)}  RESULT  ERROR`);
  for (const r of rows) {
    console.log(
      `${pad(r.endpoint, w.endpoint)}  ${pad(r.status, w.status)}  ${r.pass ? "pass" : "FAIL"}    ${r.error}`,
    );
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
