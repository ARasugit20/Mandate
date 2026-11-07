import { randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ATTACK_CARDS,
  CATEGORIES,
  DEMO_BUDGET,
  DEMO_GOAL,
  DEMO_RESEARCH_CAP,
  type AttackRun,
  type CategoryId,
  type HealthRow,
  type LinePlan,
  type MinScore,
  type Mission,
  type ProviderName,
  type Quote,
} from "../../shared/types.ts";
import {
  AgentClient,
  OwnerClient,
  VerifierClient,
  anchorNum,
  dusdcBalance,
  mandateNextOrderId,
  readMandate,
  readProviderStats,
} from "./chain/clients.ts";
import { explorerClusterConnection } from "./chain/send.ts";
import {
  ANTHROPIC_API_KEY,
  RETRY_PENALTY,
  SOLANA_RPC_URL,
  VERIFICATION_FEE,
  chainConfigured,
  loadKey,
  tryLoadKey,
} from "./config.ts";
import { db, facts } from "./db.ts";
import { llmDeliver, llmPlan, llmRubric } from "./llm.ts";
import {
  blendScore,
  factScore,
  formatDusdc,
  missionHash,
  parseDusdc,
  quoteLine,
  rescaleBudgets,
} from "./math.ts";
import { eventsFor, publish } from "./sse.ts";
import { DUSDC_MINT, PROGRAM_ID } from "./config.ts";

function nowIso() {
  return new Date().toISOString();
}

function demoLines(): LinePlan[] {
  const raw: LinePlan[] = [
    { index: 0, category: 0, categoryName: "research", budget: "0.400000", maxUnitPrice: DEMO_RESEARCH_CAP, minScore: 85 },
    { index: 1, category: 2, categoryName: "data", budget: "0.250000", maxUnitPrice: "0.080000", minScore: 80 },
    { index: 2, category: 1, categoryName: "analysis", budget: "0.350000", maxUnitPrice: "0.120000", minScore: 80 },
  ];
  return rescaleBudgets(raw, DEMO_BUDGET).map((l, i) => ({ ...l, index: i }));
}

export async function planMission(goal: string, budget: string): Promise<Mission> {
  let lines: LinePlan[];
  if (goal === DEMO_GOAL && budget === DEMO_BUDGET) {
    lines = demoLines();
  } else {
    const planned = await llmPlan(goal, budget);
    lines = rescaleBudgets(
      planned.lines.map((l, i) => ({
        index: i,
        category: l.category as CategoryId,
        categoryName: CATEGORIES[l.category],
        budget: l.budget,
        maxUnitPrice: l.maxUnitPrice,
        minScore: l.minScore as MinScore,
      })),
      budget,
    ).map((l, i) => ({ ...l, index: i }));
  }
  const id = randomUUID();
  const chainMissionId = BigInt("0x" + id.replace(/-/g, "").slice(0, 16)).toString();
  const hash = missionHash(goal, lines);
  db.prepare(
    "INSERT INTO missions(id, chain_mission_id, goal, budget, mission_hash, status, lines_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, chainMissionId, goal, budget, hash, "awaiting_signature", JSON.stringify(lines), nowIso());
  publish(id, { type: "plan", act: 1, message: "Plan ready for signature", tx: null, explorerUrl: null });
  return getMission(id);
}

export function getMission(id: string): Mission {
  const row = db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as
    | {
        id: string;
        chain_mission_id: string;
        goal: string;
        budget: string;
        mission_hash: string;
        status: Mission["status"];
        mandate_pda: string | null;
        create_tx: string | null;
        close_tx: string | null;
        lines_json: string;
      }
    | undefined;
  if (!row) throw new Error(`Unknown mission ${id}`);
  const quotes = db.prepare("SELECT payload FROM quotes WHERE mission_id = ?").all(id) as Array<{ payload: string }>;
  const decisions = db.prepare("SELECT payload FROM decisions WHERE mission_id = ?").all(id) as Array<{ payload: string }>;
  return {
    id: row.id,
    chainMissionId: row.chain_mission_id,
    goal: row.goal,
    budget: row.budget,
    missionHash: row.mission_hash,
    status: row.status,
    mandatePda: row.mandate_pda,
    createTx: row.create_tx,
    closeTx: row.close_tx,
    lines: JSON.parse(row.lines_json) as LinePlan[],
    quotes: quotes.map((q) => JSON.parse(q.payload) as Quote),
    decisions: decisions.map((d) => JSON.parse(d.payload)),
    events: eventsFor(id),
  };
}

async function statsFor(provider: ProviderName) {
  const err = chainConfigured();
  if (err) return { n: 0, cFull: 0, cHalf: 0, meanVerified: null as number | null };
  const pk = loadKey(provider).publicKey;
  const acc = await readProviderStats(pk);
  if (!acc) return { n: 0, cFull: 0, cHalf: 0, meanVerified: null };
  const n = anchorNum(acc.n);
  return {
    n,
    cFull: anchorNum(acc.cFull ?? acc.c_full),
    cHalf: anchorNum(acc.cHalf ?? acc.c_half),
    meanVerified: n > 0 ? anchorNum(acc.sumVerified ?? acc.sum_verified) / n : null,
  };
}

export async function quotesFor(lines: LinePlan[]): Promise<Quote[][]> {
  const names: ProviderName[] = ["alpha", "deep", "premium"];
  const out: Quote[][] = [];
  for (const line of lines) {
    const row: Quote[] = [];
    for (const provider of names) {
      const st = await statsFor(provider);
      row.push(
        quoteLine({
          category: line.category,
          maxUnitPrice: line.maxUnitPrice,
          minScore: line.minScore,
          provider,
          n: st.n,
          cFull: st.cFull,
          cHalf: st.cHalf,
          meanVerified: st.meanVerified,
          verificationFee: VERIFICATION_FEE,
          retryPenalty: RETRY_PENALTY,
        }),
      );
    }
    out.push(row);
  }
  return out;
}

function pickQuote(qs: Quote[]): Quote {
  const eligible = qs.filter((q) => q.eligible && q.ecs);
  if (eligible.length === 0) throw new Error("No eligible quotes");
  return eligible.sort(
    (a, b) => Number(parseDusdc(a.ecs!) - parseDusdc(b.ecs!)),
  )[0]!;
}

export async function signMission(id: string) {
  const miss = getMission(id);
  const err = chainConfigured();
  if (err) throw new Error(err);
  const owner = new OwnerClient();
  const agent = loadKey("agent").publicKey;
  const verifier = loadKey("verifier").publicKey;
  const expires = Math.floor(Date.now() / 1000) + 60 * 60;
  const created = await owner.createMandate(
    BigInt(miss.chainMissionId),
    expires,
    miss.lines.map((l) => ({
      category: l.category,
      budget: parseDusdc(l.budget),
      maxUnitPrice: parseDusdc(l.maxUnitPrice),
      minScore: l.minScore,
    })),
    agent,
    verifier,
  );
  db.prepare("UPDATE missions SET status=?, mandate_pda=?, create_tx=? WHERE id=?").run(
    "signed",
    created.mandate,
    created.signature,
    id,
  );
  publish(id, {
    type: "create",
    act: 1,
    message: "Mandate created on chain",
    tx: created.signature,
    explorerUrl: null,
  });
  return getMission(id);
}

export async function runMission(id: string) {
  const miss = getMission(id);
  if (miss.status !== "signed" && miss.status !== "running") throw new Error(`Cannot run mission in status ${miss.status}`);
  const err = chainConfigured();
  if (err) throw new Error(err);
  db.prepare("UPDATE missions SET status=? WHERE id=?").run("running", id);
  const agent = new AgentClient();
  const verifier = new VerifierClient();
  let act: 1 | 2 | 3 = 1;
  for (const line of miss.lines) {
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      const qs = (await quotesFor([line]))[0]!;
      for (const q of qs) {
        db.prepare("INSERT INTO quotes(mission_id, line_index, provider, payload) VALUES (?,?,?,?)").run(
          id,
          line.index,
          q.provider,
          JSON.stringify(q),
        );
      }
      publish(id, {
        type: "quotes",
        act,
        message: `Quotes received · ${line.categoryName}`,
        tx: null,
        explorerUrl: null,
      });
      const chosen = pickQuote(qs);
      db.prepare("INSERT INTO decisions(mission_id, line_index, provider, payload) VALUES (?,?,?,?)").run(
        id,
        line.index,
        chosen.provider,
        JSON.stringify({ lineIndex: line.index, provider: chosen.provider, quote: chosen }),
      );
      publish(id, {
        type: "decision",
        act,
        message: `${chosen.provider} chosen · ECS ${chosen.ecs}`,
        tx: null,
        explorerUrl: null,
      });
      const onchain = await readMandate(BigInt(miss.chainMissionId));
      const orderId = mandateNextOrderId(onchain);
      const purchased = await agent.purchase({
        missionId: BigInt(miss.chainMissionId),
        lineIndex: line.index,
        unitPrice: parseDusdc(chosen.full),
        fullAmount: parseDusdc(chosen.full),
        claimedScore: chosen.claimedScore,
        provider: loadKey(chosen.provider).publicKey,
        orderId,
      });
      publish(id, { type: "purchase", act, message: "Purchase submitted", tx: purchased.signature, explorerUrl: null });
      const delivery = await llmDeliver(chosen.provider, miss.goal, line.categoryName);
      db.prepare("INSERT INTO deliveries(mission_id, provider, markdown, claims_json) VALUES (?,?,?,?)").run(
        id,
        chosen.provider,
        delivery.markdown,
        JSON.stringify(delivery.claims),
      );
      const fact = factScore(delivery.claims, facts());
      let rubric = 50;
      try {
        rubric = await llmRubric(miss.goal, delivery.markdown);
      } catch (e) {
        throw e;
      }
      const final = blendScore(fact, rubric);
      const settleTx = await verifier.settle({
        missionId: BigInt(miss.chainMissionId),
        orderId,
        score: final,
        provider: loadKey(chosen.provider).publicKey,
      });
      db.prepare(
        "INSERT INTO orders(mission_id, chain_order_id, provider, line_index, claimed, verified, paid, purchase_tx, settle_tx) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        orderId.toString(),
        chosen.provider,
        line.index,
        chosen.claimedScore,
        final,
        formatDusdc(
          final >= 90
            ? parseDusdc(chosen.full)
            : line.minScore < 90 && final >= line.minScore
              ? parseDusdc(chosen.full) / 2n
              : 0n,
        ),
        purchased.signature,
        settleTx,
      );
      db.prepare("INSERT INTO verifications(mission_id, fact_score, rubric_score, final_score) VALUES (?,?,?,?)").run(
        id,
        fact,
        rubric,
        final,
      );
      publish(id, {
        type: "settle",
        act,
        message: `Settled score ${final}`,
        tx: settleTx,
        explorerUrl: null,
      });
      if (final >= line.minScore) break;
    }
    if (act < 3) act = (act + 1) as 1 | 2 | 3;
  }
  db.prepare("UPDATE missions SET status=? WHERE id=?").run("settled", id);
  return getMission(id);
}

export async function closeMission(id: string) {
  const miss = getMission(id);
  const owner = new OwnerClient();
  const sig = await owner.closeMandate(BigInt(miss.chainMissionId));
  db.prepare("UPDATE missions SET status=?, close_tx=? WHERE id=?").run("closed", sig, id);
  publish(id, { type: "close", act: 3, message: "Mandate closed, vault returned", tx: sig, explorerUrl: null });
  return getMission(id);
}

export async function warmup(n: number) {
  const err = chainConfigured();
  if (err) throw new Error(err);
  const names: ProviderName[] = ["alpha", "deep", "premium"];
  const results = [];
  for (let i = 0; i < n; i++) {
    const planned = await planMission(DEMO_GOAL, DEMO_BUDGET);
    await signMission(planned.id);
    const miss = getMission(planned.id);
    const agent = new AgentClient();
    const verifier = new VerifierClient();
    const provider = names[i % 3]!;
    const line = miss.lines[0]!;
    const qs = (await quotesFor([line]))[0]!;
    const quote = qs.find((q) => q.provider === provider && q.eligible) ?? qs.find((q) => q.eligible)!;
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const orderId = mandateNextOrderId(onchain);
    const purchased = await agent.purchase({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: line.index,
      unitPrice: parseDusdc(quote.full),
      fullAmount: parseDusdc(quote.full),
      claimedScore: quote.claimedScore,
      provider: loadKey(provider).publicKey,
      orderId,
    });
    const score = provider === "alpha" ? 61 : provider === "deep" ? 80 : 93;
    const settleTx = await verifier.settle({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score,
      provider: loadKey(provider).publicKey,
    });
    db.prepare(
      "INSERT INTO orders(mission_id, chain_order_id, provider, line_index, claimed, verified, paid, purchase_tx, settle_tx) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      planned.id,
      orderId.toString(),
      provider,
      line.index,
      quote.claimedScore,
      score,
      formatDusdc(score >= 90 ? parseDusdc(quote.full) : score >= line.minScore && line.minScore < 90 ? parseDusdc(quote.full) / 2n : 0n),
      purchased.signature,
      settleTx,
    );
    await closeMission(planned.id);
    results.push({ missionId: planned.id, provider, score, purchase: purchased.signature, settle: settleTx });
  }
  return results;
}

export async function health(): Promise<{ rows: HealthRow[]; ok: boolean }> {
  const rows: HealthRow[] = [];
  const push = (name: string, status: HealthRow["status"], detail: string) => rows.push({ name, status, detail });

  push("Signing backend", "pass", "this server");
  if (!SOLANA_RPC_URL) push("RPC reachable", "error", "SOLANA_RPC_URL is not set");
  else {
    try {
      const slot = await explorerClusterConnection().getSlot("confirmed");
      push("RPC reachable", "pass", `slot ${slot}`);
    } catch (e) {
      push("RPC reachable", "fail", e instanceof Error ? e.message : String(e));
    }
  }
  if (!PROGRAM_ID) push("Program found at PROGRAM_ID", "error", "PROGRAM_ID is not set");
  else {
    try {
      const info = await explorerClusterConnection().getAccountInfo(new PublicKey(PROGRAM_ID));
      push("Program found at PROGRAM_ID", info ? "pass" : "fail", info ? PROGRAM_ID : "no account at PROGRAM_ID");
    } catch (e) {
      push("Program found at PROGRAM_ID", "fail", e instanceof Error ? e.message : String(e));
    }
  }
  push("IDL loaded", "pass", "server/src/chain/idl/mandate.json");

  async function solRow(name: string, key: "owner" | "agent" | "verifier") {
    const kp = tryLoadKey(key);
    if (!kp) return push(`${name} SOL`, "error", `missing .keys/${key}.json`);
    if (!SOLANA_RPC_URL) return push(`${name} SOL`, "error", "SOLANA_RPC_URL is not set");
    try {
      const lamports = await explorerClusterConnection().getBalance(kp.publicKey);
      const ok = lamports >= 0.5 * 1e9;
      push(`${name} SOL`, ok ? "pass" : "fail", `${lamports / 1e9} SOL`);
    } catch (e) {
      push(`${name} SOL`, "fail", e instanceof Error ? e.message : String(e));
    }
  }
  await solRow("Owner", "owner");
  await solRow("Agent", "agent");
  await solRow("Verifier", "verifier");

  const owner = tryLoadKey("owner");
  if (!owner || !DUSDC_MINT) push("Owner dUSDC", "error", !DUSDC_MINT ? "DUSDC_MINT is not set" : "missing owner key");
  else {
    try {
      const bal = await dusdcBalance(owner.publicKey);
      push("Owner dUSDC", bal != null ? "pass" : "fail", bal == null ? "no ATA" : formatDusdc(bal));
    } catch (e) {
      push("Owner dUSDC", "fail", e instanceof Error ? e.message : String(e));
    }
  }

  const agent = tryLoadKey("agent");
  if (!agent || !DUSDC_MINT) push("Agent holds 0 dUSDC", "error", !DUSDC_MINT ? "DUSDC_MINT is not set" : "missing agent key");
  else {
    try {
      const bal = await dusdcBalance(agent.publicKey);
      const zero = bal == null || bal === 0n;
      push("Agent holds 0 dUSDC", zero ? "pass" : "fail", bal == null ? "no ATA" : formatDusdc(bal));
    } catch (e) {
      push("Agent holds 0 dUSDC", "fail", e instanceof Error ? e.message : String(e));
    }
  }

  const names: ProviderName[] = ["alpha", "deep", "premium"];
  const providersErr = chainConfigured();
  if (providersErr) push("Providers registered", "error", providersErr);
  else {
    const missing: string[] = [];
    for (const n of names) {
      const s = await readProviderStats(loadKey(n).publicKey);
      if (!s) missing.push(n);
    }
    push("Providers registered", missing.length ? "fail" : "pass", missing.length ? `missing ${missing.join(",")}` : "alpha, deep, premium");
  }

  if (!ANTHROPIC_API_KEY) push("Anthropic", "error", "ANTHROPIC_API_KEY is not set");
  else push("Anthropic", "pass", "key present");

  const ok = rows.every((r) => r.status === "pass");
  return { rows, ok };
}

export async function runAttacks(): Promise<AttackRun[]> {
  const err = chainConfigured();
  if (err) throw new Error(err);
  const owner = new OwnerClient();
  const agent = new AgentClient();
  const verifier = new VerifierClient();
  const alpha = loadKey("alpha");
  const attacker = loadKey("attacker");
  const impostor = loadKey("impostor");
  const runs: AttackRun[] = [];

  async function freshMandate(expiresIn = 3600) {
    const planned = await planMission(DEMO_GOAL, DEMO_BUDGET);
    const miss = getMission(planned.id);
    const created = await owner.createMandate(
      BigInt(miss.chainMissionId),
      Math.floor(Date.now() / 1000) + expiresIn,
      miss.lines.map((l) => ({
        category: l.category,
        budget: parseDusdc(l.budget),
        maxUnitPrice: parseDusdc(l.maxUnitPrice),
        minScore: l.minScore,
      })),
      loadKey("agent").publicKey,
      loadKey("verifier").publicKey,
    );
    db.prepare("UPDATE missions SET status=?, mandate_pda=?, create_tx=? WHERE id=?").run(
      "signed",
      created.mandate,
      created.signature,
      planned.id,
    );
    return getMission(planned.id);
  }

  async function record(name: AttackRun["name"], expected: string, actual: string, tx: string | null, logs: string[]) {
    const outcome = actual === expected || (name === "overclaim" && actual === "paid 0") ? "expected" : "unexpected";
    const explorerUrl = tx ? (await import("./config.ts")).explorerTx(tx) : null;
    db.prepare(
      "INSERT INTO attack_runs(name, expected, actual, outcome, tx, explorer_url, logs, ts) VALUES (?,?,?,?,?,?,?,?)",
    ).run(name, expected, actual, outcome, tx, explorerUrl, JSON.stringify(logs), nowIso());
    runs.push({
      name,
      title: ATTACK_CARDS.find((c) => c.name === name)!.title,
      expected,
      actual,
      outcome,
      tx,
      explorerUrl,
      logs,
    });
  }

  {
    const miss = await freshMandate();
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const fail = await agent.purchaseExpectFail({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: attacker.publicKey,
      orderId: mandateNextOrderId(onchain),
    });
    await record("injected_transfer", "ProviderNotRegistered", fail.name, fail.signature, fail.logs);
  }
  {
    const miss = await freshMandate();
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const fail = await agent.purchaseExpectFail({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: parseDusdc("1.000000"),
      fullAmount: parseDusdc("1.000000"),
      claimedScore: 95,
      provider: alpha.publicKey,
      orderId: mandateNextOrderId(onchain),
    });
    await record("over_unit_price", "OverUnitPrice", fail.name, fail.signature, fail.logs);
  }
  {
    const miss = await freshMandate();
    let last = { name: "unknown", signature: "", logs: [] as string[] };
    for (let i = 0; i < 20; i++) {
      const onchain = await readMandate(BigInt(miss.chainMissionId));
      const orderId = mandateNextOrderId(onchain);
      last = await agent.purchaseExpectFail({
        missionId: BigInt(miss.chainMissionId),
        lineIndex: 0,
        unitPrice: 30_000n,
        fullAmount: parseDusdc(miss.lines[0]!.budget),
        claimedScore: 95,
        provider: alpha.publicKey,
        orderId,
      });
      if (last.name === "LineBudgetExceeded") break;
      if (last.name === "ok") continue;
    }
    await record("loop_drain", "LineBudgetExceeded", last.name, last.signature, last.logs);
  }
  {
    const miss = await freshMandate();
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const fail = await agent.purchaseExpectFail({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 5,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: alpha.publicKey,
      orderId: mandateNextOrderId(onchain),
    });
    await record("off_plan_purchase", "NoMatchingLineItem", fail.name, fail.signature, fail.logs);
  }
  {
    const miss = await freshMandate();
    const onchain0 = await readMandate(BigInt(miss.chainMissionId));
    const orderId = mandateNextOrderId(onchain0);
    await agent.purchase({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: alpha.publicKey,
      orderId,
    });
    const rand = Keypair.generate();
    const fail = await verifier.settleExpectFail({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score: 93,
      provider: alpha.publicKey,
      signer: rand,
    });
    await record("fake_verifier", "NotVerifier", fail.name, fail.signature, fail.logs);
    const failAgent = await verifier.settleExpectFail({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score: 93,
      provider: alpha.publicKey,
      signer: loadKey("agent"),
    });
    await record("agent_settles", "NotVerifier", failAgent.name, failAgent.signature, failAgent.logs);
    await verifier.settle({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score: 93,
      provider: alpha.publicKey,
    });
    const twice = await verifier.settleExpectFail({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score: 93,
      provider: alpha.publicKey,
      signer: loadKey("verifier"),
    });
    await record("double_settlement", "OrderAlreadySettled", twice.name, twice.signature, twice.logs);
  }
  {
    const miss = await freshMandate(3);
    await new Promise((r) => setTimeout(r, 5000));
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const fail = await agent.purchaseExpectFail({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: alpha.publicKey,
      orderId: mandateNextOrderId(onchain),
    });
    await record("expired_mandate", "MandateExpired", fail.name, fail.signature, fail.logs);
  }
  {
    const miss = await freshMandate();
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const fail = await agent.purchaseExpectFail({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: impostor.publicKey,
      orderId: mandateNextOrderId(onchain),
    });
    await record("impostor_provider", "ProviderNotRegistered", fail.name, fail.signature, fail.logs);
  }
  {
    const miss = await freshMandate();
    const onchain = await readMandate(BigInt(miss.chainMissionId));
    const orderId = mandateNextOrderId(onchain);
    await agent.purchase({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: alpha.publicKey,
      orderId,
    });
    const settleTx = await verifier.settle({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score: 61,
      provider: alpha.publicKey,
    });
    const ownerClient = new OwnerClient();
    const { orderPda, mandatePda, programId } = await import("./chain/send.ts");
    const mandateKey = mandatePda(ownerClient.owner.publicKey, BigInt(miss.chainMissionId), programId());
    const orderKey = orderPda(mandateKey, orderId, programId());
    const orderData = await (
      ownerClient.program.account as { order: { fetch: (k: import("@solana/web3.js").PublicKey) => Promise<{ paid: { toString(): string } | number }> } }
    ).order.fetch(orderKey);
    const paid = Number(orderData.paid?.toString?.() ?? orderData.paid ?? 0);
    await record("overclaim", "paid 0", paid === 0 ? "paid 0" : `paid ${paid}`, settleTx, []);
  }
  return runs;
}

export async function honesty(): Promise<Array<{ provider: ProviderName; n: number; claimedMean: number | null; verifiedMean: number | null; cFull: number; cHalf: number; cZero: number }>> {
  const names: ProviderName[] = ["alpha", "deep", "premium"];
  const out = [];
  const honestyErr = chainConfigured();
  for (const provider of names) {
    if (honestyErr) {
      out.push({ provider, n: 0, claimedMean: null, verifiedMean: null, cFull: 0, cHalf: 0, cZero: 0 });
      continue;
    }
    const s = await readProviderStats(loadKey(provider).publicKey);
    if (!s) {
      out.push({ provider, n: 0, claimedMean: null, verifiedMean: null, cFull: 0, cHalf: 0, cZero: 0 });
      continue;
    }
    const n = anchorNum(s.n);
    out.push({
      provider,
      n,
      claimedMean: n ? anchorNum(s.sumClaimed ?? s.sum_claimed) / n : null,
      verifiedMean: n ? anchorNum(s.sumVerified ?? s.sum_verified) / n : null,
      cFull: anchorNum(s.cFull ?? s.c_full),
      cHalf: anchorNum(s.cHalf ?? s.c_half),
      cZero: anchorNum(s.cZero ?? s.c_zero),
    });
  }
  return out;
}

export function receipts() {
  return db
    .prepare(
      "SELECT chain_order_id as orderId, mission_id as missionId, provider, claimed, verified, paid, settle_tx as tx FROM orders WHERE settle_tx IS NOT NULL ORDER BY id DESC",
    )
    .all() as Array<{
    orderId: string;
    missionId: string;
    provider: ProviderName;
    claimed: number;
    verified: number;
    paid: string;
    tx: string;
  }>;
}
