import { randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ATTACK_CARDS,
  CATEGORIES,
  CHAIN_HEALTH_ROWS,
  DEMO_BUDGET,
  DEMO_GOAL,
  DEMO_RESEARCH_CAP,
  type AttackRun,
  type CategoryId,
  type HealthResponse,
  type HealthRow,
  type InstructionName,
  type LinePlan,
  type MinScore,
  type Mission,
  type PayoutMath,
  type PayoutTier,
  type ProviderName,
  type Quote,
  type ReceiptDetail,
  type TxRef,
  type Verification,
  type WarmupProgress,
  type WarmupSummaryRow,
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
  LLM_PROVIDER,
  llmKey,
  llmMissingMessage,
  RETRY_PENALTY,
  SOLANA_RPC_URL,
  VERIFICATION_FEE,
  chainConfigured,
  explorerTx,
  loadKey,
  tryLoadKey,
} from "./config.ts";
import { db, facts } from "./db.ts";
import { llmDeliver, llmPlan, llmRubric } from "./llm.ts";
import {
  buildVerification,
  checkClaims,
  formatDusdc,
  missionHash,
  parseDusdc,
  payoutFor,
  quoteLine,
  rescaleBudgets,
  round6Number,
} from "./math.ts";
import { eventsFor, publish } from "./sse.ts";
import { DUSDC_MINT, PROGRAM_ID } from "./config.ts";

function nowIso() {
  return new Date().toISOString();
}

/** One retry per line: enough to show the loop, bounded enough to show a verdict. */
export const MAX_ATTEMPTS = 2;

const INSTRUCTION_LABELS: Record<InstructionName, string> = {
  create_mandate: "owner signs the purchase plan and funds the vault",
  register_provider: "owner adds a provider to the on-chain allowlist",
  purchase: "agent commits vault funds against one line item",
  settle: "verifier records the score and releases payment",
  close_mandate: "owner closes the mandate and reclaims the vault",
};

export function txRef(instruction: InstructionName, signature: string): TxRef {
  return {
    instruction,
    label: `${instruction} · ${INSTRUCTION_LABELS[instruction]}`,
    signature,
    explorerUrl: explorerTx(signature),
  };
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

/**
 * ECS is expected cost per success, so the lowest number wins.
 *
 * `exclude` carries the providers that already failed this line. Provider stats
 * are global, so a provider that just missed a hard line's minimum still looks
 * cheap on the next attempt and would be picked again forever. Retrying is only
 * worth paying for if it escalates.
 */
function pickQuote(qs: Quote[], exclude: ReadonlySet<ProviderName> = new Set()): Quote {
  const eligible = qs.filter((q) => q.eligible && q.ecs);
  if (eligible.length === 0) throw new Error("No eligible quotes");
  const byEcs = [...eligible].sort((a, b) => Number(parseDusdc(a.ecs!) - parseDusdc(b.ecs!)));
  return byEcs.find((q) => !exclude.has(q.provider)) ?? byEcs[0]!;
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
    message: `Mandate created on chain with ${miss.lines.length} signed line items`,
    tx: created.signature,
    explorerUrl: null,
    instruction: "create_mandate",
    status: "signed",
  });
  return getMission(id);
}

export async function runMission(id: string) {
  const miss = getMission(id);
  if (miss.status !== "signed" && miss.status !== "running") throw new Error(`Cannot run mission in status ${miss.status}`);
  const err = chainConfigured();
  if (err) throw new Error(err);
  // Purchase commits vault funds before delivery, and only the verifier can
  // release them. Refuse up front rather than orphan an unsettled order.
  if (!llmKey()) throw new Error(llmMissingMessage());
  db.prepare("UPDATE missions SET status=? WHERE id=?").run("running", id);
  publish(id, { type: "status", act: 1, message: "Mission running", tx: null, explorerUrl: null, status: "running" });
  const agent = new AgentClient();
  const verifier = new VerifierClient();
  let act: 1 | 2 | 3 = 1;
  let totalPaid = 0n;
  const lineResults: Array<{ line: LinePlan; cleared: boolean; best: number }> = [];

  for (const line of miss.lines) {
    let attempts = 0;
    let cleared = false;
    let best = 0;
    const failed = new Set<ProviderName>();
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      // The penalty is what a retry costs us in the ECS model; showing it makes
      // the loop legible instead of looking like the agent is stuck.
      const spentPenalty = round6Number(RETRY_PENALTY * (attempts - 1));
      publish(id, {
        type: "attempt",
        act,
        message: `${line.categoryName} · attempt ${attempts}/${MAX_ATTEMPTS} · retry penalty ${spentPenalty} dUSDC`,
        tx: null,
        explorerUrl: null,
      });

      const qs = (await quotesFor([line]))[0]!;
      for (const q of qs) {
        db.prepare("INSERT INTO quotes(mission_id, line_index, provider, payload) VALUES (?,?,?,?)").run(
          id,
          line.index,
          q.provider,
          JSON.stringify(q),
        );
      }
      const quoteSummary = qs
        .map((q) => `${q.provider} ${q.eligible ? `ECS ${q.ecs}` : q.ineligibleReason}`)
        .join(" · ");
      publish(id, {
        type: "quotes",
        act,
        message: `Quotes · ${line.categoryName} · ${quoteSummary}`,
        tx: null,
        explorerUrl: null,
      });

      const chosen = pickQuote(qs, failed);
      db.prepare("INSERT INTO decisions(mission_id, line_index, provider, payload) VALUES (?,?,?,?)").run(
        id,
        line.index,
        chosen.provider,
        JSON.stringify({ lineIndex: line.index, provider: chosen.provider, quote: chosen }),
      );
      publish(id, {
        type: "decision",
        act,
        // ECS is expected cost per success, so the cheapest number wins.
        message: failed.size
          ? `${chosen.provider} chosen · lowest ECS ${chosen.ecs} dUSDC per success among providers that have not already failed this line (${[...failed].join(", ")} excluded)`
          : `${chosen.provider} chosen · lowest ECS ${chosen.ecs} dUSDC per success`,
        tx: null,
        explorerUrl: null,
      });

      const onchain = await readMandate(BigInt(miss.chainMissionId));
      const orderId = mandateNextOrderId(onchain);
      const fullAmount = parseDusdc(chosen.full);
      const purchased = await agent.purchase({
        missionId: BigInt(miss.chainMissionId),
        lineIndex: line.index,
        unitPrice: fullAmount,
        fullAmount,
        claimedScore: chosen.claimedScore,
        provider: loadKey(chosen.provider).publicKey,
        orderId,
      });
      publish(id, {
        type: "purchase",
        act,
        message: `Purchase committed ${chosen.full} dUSDC to the vault for order ${orderId}`,
        tx: purchased.signature,
        explorerUrl: null,
        instruction: "purchase",
      });

      const verification = await verify(id, act, miss.goal, line, chosen.provider);
      const final = verification.finalScore;
      best = Math.max(best, final);

      const settleTx = await verifier.settle({
        missionId: BigInt(miss.chainMissionId),
        orderId,
        score: final,
        provider: loadKey(chosen.provider).publicKey,
      });
      const payout = payoutFor({ score: final, fullAmount, minScore: line.minScore });
      totalPaid += parseDusdc(payout.paid);

      db.prepare(
        `INSERT INTO orders(mission_id, chain_order_id, provider, line_index, claimed, verified, paid,
          purchase_tx, settle_tx, line_min_score, tier, attempt, quotes_json, chosen_json, payout_json,
          verification_json, deliverable, claims_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        orderId.toString(),
        chosen.provider,
        line.index,
        chosen.claimedScore,
        final,
        payout.paid,
        purchased.signature,
        settleTx,
        line.minScore,
        payout.tier,
        attempts,
        JSON.stringify(qs),
        JSON.stringify(chosen),
        JSON.stringify(payout),
        JSON.stringify(verification),
        verification.deliverable,
        JSON.stringify(verification.claims),
      );

      publish(id, {
        type: "settle",
        act,
        message: `Settled ${chosen.provider} at ${final} · ${payout.rule} Paid ${payout.paid} dUSDC.`,
        tx: settleTx,
        explorerUrl: null,
        instruction: "settle",
      });

      if (final >= line.minScore) {
        cleared = true;
        break;
      }
      failed.add(chosen.provider);
      if (attempts < MAX_ATTEMPTS) {
        publish(id, {
          type: "retry",
          act,
          message: `${final} is under the ${line.minScore} minimum for ${line.categoryName} — retrying (${attempts}/${MAX_ATTEMPTS} used)`,
          tx: null,
          explorerUrl: null,
        });
      }
    }
    lineResults.push({ line, cleared, best });
    if (act < 3) act = (act + 1) as 1 | 2 | 3;
  }

  const passed = lineResults.every((r) => r.cleared);
  const failedLines = lineResults.filter((r) => !r.cleared);
  db.prepare("UPDATE missions SET status=? WHERE id=?").run("settled", id);
  publish(id, {
    type: "verdict",
    act: 3,
    message: passed
      ? `PASSED · every line met its minimum · total spent ${formatDusdc(totalPaid)} dUSDC of ${miss.budget}`
      : `FAILED · ${failedLines
          .map((r) => `${r.line.categoryName} peaked at ${r.best} vs min ${r.line.minScore}`)
          .join("; ")} · total spent ${formatDusdc(totalPaid)} dUSDC of ${miss.budget}`,
    tx: null,
    explorerUrl: null,
    status: "settled",
  });
  return getMission(id);
}

/**
 * Buys nothing and signs nothing: grades a deliverable and records exactly what
 * the verifier saw. An LLM failure surfaces as a timeline event and aborts the
 * run — a silently defaulted score would be indistinguishable from a real grade.
 */
async function verify(
  missionId: string,
  act: 1 | 2 | 3,
  goal: string,
  line: LinePlan,
  provider: ProviderName,
): Promise<Verification & { deliverable: string; claims: Array<{ key: string; value: number }> }> {
  let delivery: Awaited<ReturnType<typeof llmDeliver>>;
  try {
    delivery = await llmDeliver(provider, goal, line.categoryName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    publish(missionId, {
      type: "error",
      act,
      message: `${provider} failed to deliver: ${msg}`,
      tx: null,
      explorerUrl: null,
      status: "error",
    });
    db.prepare("UPDATE missions SET status=? WHERE id=?").run("error", missionId);
    throw e;
  }
  db.prepare("INSERT INTO deliveries(mission_id, provider, markdown, claims_json) VALUES (?,?,?,?)").run(
    missionId,
    provider,
    delivery.markdown,
    JSON.stringify(delivery.claims),
  );

  let rubric: Awaited<ReturnType<typeof llmRubric>>;
  try {
    rubric = await llmRubric(goal, delivery.markdown);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("INSERT INTO verifications(mission_id, fact_score, rubric_score, final_score, error) VALUES (?,?,?,?,?)").run(
      missionId,
      null,
      null,
      -1,
      msg,
    );
    publish(missionId, {
      type: "error",
      act,
      message: `Verifier could not score ${provider}: ${msg}. No score was invented; the run stops here.`,
      tx: null,
      explorerUrl: null,
      status: "error",
    });
    db.prepare("UPDATE missions SET status=? WHERE id=?").run("error", missionId);
    throw e;
  }

  const checks = checkClaims(delivery.claims, facts());
  const verification = buildVerification(checks, { score: rubric.score, reasoning: rubric.reasoning });
  db.prepare(
    "INSERT INTO verifications(mission_id, fact_score, rubric_score, final_score, raw_input, raw_output) VALUES (?,?,?,?,?,?)",
  ).run(
    missionId,
    verification.factScore,
    verification.rubricScore,
    verification.finalScore,
    rubric.rawInput,
    rubric.rawOutput,
  );
  const checkText = checks.length
    ? checks.map((c) => `${c.key} ${c.claimed} vs ${c.expected} → ${c.points}`).join(" · ")
    : "no checkable claims";
  publish(missionId, {
    type: "verify",
    act,
    message: `Graded ${provider} · facts ${verification.factScore ?? "n/a"} (${checkText}) · rubric ${rubric.score} (${rubric.reasoning}) · ${verification.formula}`,
    tx: null,
    explorerUrl: null,
  });
  return { ...verification, deliverable: delivery.markdown, claims: delivery.claims };
}

export async function closeMission(id: string) {
  const miss = getMission(id);
  const owner = new OwnerClient();
  const sig = await owner.closeMandate(BigInt(miss.chainMissionId));
  db.prepare("UPDATE missions SET status=?, close_tx=? WHERE id=?").run("closed", sig, id);
  publish(id, {
    type: "close",
    act: 3,
    message: "Mandate closed, unspent vault balance returned to the owner",
    tx: sig,
    explorerUrl: null,
    instruction: "close_mandate",
    status: "closed",
  });
  return getMission(id);
}

/**
 * Seeds on-chain provider history so ECS has something to learn from. Scores
 * are fixed per provider on purpose: this is a ledger bootstrap, not a demo of
 * the verifier. Each provider is given a score that lands in a different payout
 * tier against the line minimum, so the resulting history exercises all three.
 */
function warmupScore(provider: ProviderName, minScore: number): number {
  if (provider === "premium") return 93; // >= 90, full payment
  if (provider === "deep") return Math.min(89, minScore + 1); // clears the min, half payment
  return Math.max(0, minScore - 20); // under the min, zero payment
}

export async function* warmupStream(n: number): AsyncGenerator<
  { kind: "progress"; progress: WarmupProgress } | { kind: "summary"; rows: WarmupSummaryRow[] }
> {
  const err = chainConfigured();
  if (err) throw new Error(err);
  const names: ProviderName[] = ["alpha", "deep", "premium"];
  const tally = new Map<
    ProviderName,
    { missions: number; verified: number; claimed: number; paid: bigint }
  >();
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
    const fullAmount = parseDusdc(quote.full);
    const purchased = await agent.purchase({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: line.index,
      unitPrice: fullAmount,
      fullAmount,
      claimedScore: quote.claimedScore,
      provider: loadKey(provider).publicKey,
      orderId,
    });
    const score = warmupScore(provider, line.minScore);
    const settleTx = await verifier.settle({
      missionId: BigInt(miss.chainMissionId),
      orderId,
      score,
      provider: loadKey(provider).publicKey,
    });
    const payout = payoutFor({ score, fullAmount, minScore: line.minScore });
    db.prepare(
      `INSERT INTO orders(mission_id, chain_order_id, provider, line_index, claimed, verified, paid,
        purchase_tx, settle_tx, line_min_score, tier, attempt, chosen_json, payout_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      planned.id,
      orderId.toString(),
      provider,
      line.index,
      quote.claimedScore,
      score,
      payout.paid,
      purchased.signature,
      settleTx,
      line.minScore,
      payout.tier,
      1,
      JSON.stringify(quote),
      JSON.stringify(payout),
    );
    await closeMission(planned.id);

    const agg = tally.get(provider) ?? { missions: 0, verified: 0, claimed: 0, paid: 0n };
    agg.missions += 1;
    agg.verified += score;
    agg.claimed += quote.claimedScore;
    agg.paid += parseDusdc(payout.paid);
    tally.set(provider, agg);

    yield {
      kind: "progress",
      progress: {
        index: i + 1,
        total: n,
        provider,
        claimed: quote.claimedScore,
        verified: score,
        paid: payout.paid,
        tier: payout.tier,
        txs: [
          txRef("purchase", purchased.signature),
          txRef("settle", settleTx),
        ],
      },
    };
    const { pace } = await import("./llm.ts");
    await pace();
  }

  yield {
    kind: "summary",
    rows: names.map((provider) => {
      const agg = tally.get(provider);
      if (!agg || agg.missions === 0) {
        return { provider, missions: 0, meanVerified: null, meanClaimed: null, totalPaid: "0.000000", honestyGap: null };
      }
      const meanVerified = agg.verified / agg.missions;
      const meanClaimed = agg.claimed / agg.missions;
      return {
        provider,
        missions: agg.missions,
        meanVerified,
        meanClaimed,
        totalPaid: formatDusdc(agg.paid),
        honestyGap: meanClaimed - meanVerified,
      };
    }),
  };
}

export async function warmup(n: number) {
  const progress: WarmupProgress[] = [];
  let summary: WarmupSummaryRow[] = [];
  for await (const msg of warmupStream(n)) {
    if (msg.kind === "progress") progress.push(msg.progress);
    else summary = msg.rows;
  }
  return { progress, summary };
}

export async function health(): Promise<HealthResponse> {
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

  if (!llmKey()) push("LLM", "error", llmMissingMessage());
  else push("LLM", "pass", `${LLM_PROVIDER} · key present`);

  const ok = rows.every((r) => r.status === "pass");
  const chainOk = CHAIN_HEALTH_ROWS.every(
    (name) => rows.find((r) => r.name === name)?.status === "pass",
  );
  return { rows, ok, chainOk };
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
    const explorerUrl = tx ? explorerTx(tx) : null;
    const card = ATTACK_CARDS.find((c) => c.name === name)!;
    // The one log line the program emitted to reject this, so the card can show
    // the program's own words rather than our summary of them.
    const errorLine =
      logs.find((l) => /Error Code:|AnchorError|custom program error/i.test(l))?.trim() ?? null;
    db.prepare(
      "INSERT INTO attack_runs(name, expected, actual, outcome, tx, explorer_url, logs, ts, instruction, error_line) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(name, expected, actual, outcome, tx, explorerUrl, JSON.stringify(logs), nowIso(), card.instruction, errorLine);
    runs.push({
      name,
      title: card.title,
      expected,
      actual,
      outcome,
      tx,
      explorerUrl,
      instruction: card.instruction,
      logs,
      errorLine,
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

type OrderRow = {
  orderId: string;
  missionId: string;
  provider: ProviderName;
  lineIndex: number;
  claimed: number;
  verified: number;
  paid: string;
  tier: PayoutTier | null;
  attempt: number | null;
  purchaseTx: string | null;
  tx: string;
  quotesJson: string | null;
  chosenJson: string | null;
  payoutJson: string | null;
  verificationJson: string | null;
  deliverable: string | null;
  claimsJson: string | null;
  goal: string;
  createTx: string | null;
  closeTx: string | null;
  linesJson: string;
};

const ORDER_SELECT = `
  SELECT o.chain_order_id as orderId, o.mission_id as missionId, o.provider, o.line_index as lineIndex,
         o.claimed, o.verified, o.paid, o.tier, o.attempt, o.purchase_tx as purchaseTx, o.settle_tx as tx,
         o.quotes_json as quotesJson, o.chosen_json as chosenJson, o.payout_json as payoutJson,
         o.verification_json as verificationJson, o.deliverable, o.claims_json as claimsJson,
         m.goal, m.create_tx as createTx, m.close_tx as closeTx, m.lines_json as linesJson
  FROM orders o JOIN missions m ON m.id = o.mission_id
  WHERE o.settle_tx IS NOT NULL`;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toDetail(row: OrderRow): ReceiptDetail {
  const lines = parseJson<LinePlan[]>(row.linesJson) ?? [];
  const payout = parseJson<PayoutMath>(row.payoutJson);
  const txs: TxRef[] = [];
  if (row.createTx) txs.push(txRef("create_mandate", row.createTx));
  if (row.purchaseTx) txs.push(txRef("purchase", row.purchaseTx));
  txs.push(txRef("settle", row.tx));
  if (row.closeTx) txs.push(txRef("close_mandate", row.closeTx));
  return {
    orderId: row.orderId,
    missionId: row.missionId,
    provider: row.provider,
    claimed: row.claimed,
    verified: row.verified,
    paid: row.paid,
    tier: row.tier ?? payout?.tier ?? (row.paid === "0.000000" ? "zero" : "full"),
    tx: row.tx,
    explorerUrl: explorerTx(row.tx),
    goal: row.goal,
    line: lines.find((l) => l.index === row.lineIndex) ?? null,
    quotes: parseJson<Quote[]>(row.quotesJson) ?? [],
    chosen: parseJson<Quote>(row.chosenJson),
    attempt: row.attempt ?? 1,
    maxAttempts: MAX_ATTEMPTS,
    deliverable: row.deliverable ?? "",
    claims: parseJson<Array<{ key: string; value: number }>>(row.claimsJson) ?? [],
    verification: parseJson<Verification>(row.verificationJson),
    payout,
    txs,
  };
}

export function receipts(): ReceiptDetail[] {
  const rows = db.prepare(`${ORDER_SELECT} ORDER BY o.id DESC`).all() as OrderRow[];
  return rows.map(toDetail);
}

export function receipt(orderId: string, missionId: string): ReceiptDetail | null {
  const row = db
    .prepare(`${ORDER_SELECT} AND o.chain_order_id = ? AND o.mission_id = ?`)
    .get(orderId, missionId) as OrderRow | undefined;
  return row ? toDetail(row) : null;
}
