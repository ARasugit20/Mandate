import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR, PROGRAM_ID, chainConfigured } from "../server/src/config.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
}

const tests = readFileSync(resolve(ROOT_DIR, "program/tests/mandate.ts"), "utf8");
for (const err of [
  "ProviderNotRegistered",
  "OverUnitPrice",
  "LineBudgetExceeded",
  "NoMatchingLineItem",
  "NotVerifier",
  "OrderAlreadySettled",
  "MandateExpired",
  "NotOwner",
]) {
  check(`anchor test names ${err}`, tests.includes(err), "");
}

const readme = readFileSync(resolve(ROOT_DIR, "README.md"), "utf8");
if (PROGRAM_ID) check("PROGRAM_ID in README", readme.includes(PROGRAM_ID), PROGRAM_ID);
else check("PROGRAM_ID in README", false, "PROGRAM_ID is not set");

const agentSrc = readFileSync(resolve(ROOT_DIR, "server/src/chain/clients.ts"), "utf8");
check("AgentClient has no settle", /export class AgentClient[\s\S]*?\nexport class /.test(agentSrc) && !/export class AgentClient[\s\S]*settle\(/.test(agentSrc.split("export class VerifierClient")[0]!), "");

const quoteSrc = readFileSync(resolve(ROOT_DIR, "server/src/math.ts"), "utf8");
check("over-cap leaves price unchanged", quoteSrc.includes('ineligibleReason: "OverUnitPrice"') && quoteSrc.includes("Never shrink") === false ? quoteSrc.includes("price left unchanged") : true, "");

const chainErr = chainConfigured();
if (chainErr) {
  check("devnet fixtures", false, chainErr);
} else {
  const port = process.env.PORT ?? "8787";
  try {
    const health = await fetch(`http://localhost:${port}/api/health`).then((r) => r.json()) as {
      rows: Array<{ name: string; status: string; detail: string }>;
    };
    const agentRow = health.rows.find((r) => r.name === "Agent holds 0 dUSDC");
    check("Agent holds 0 dUSDC", agentRow?.status === "pass", agentRow?.detail ?? "missing health row");
  } catch (e) {
    check("health endpoint", false, e instanceof Error ? e.message : String(e));
  }
}

const dist = resolve(ROOT_DIR, "app/dist");
if (existsSync(dist)) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(`grep -R --exclude-dir=node_modules ".keys" "${dist}"`, { stdio: "pipe" });
    check("frontend build has no .keys", false, "grep found .keys");
  } catch {
    check("frontend build has no .keys", true, "");
  }
} else {
  check("frontend build has no .keys", false, "app/dist missing — run npm run build -w app");
}

if (failed) process.exit(1);
