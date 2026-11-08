import { randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ATTACK_CARDS,
  CATEGORIES,
  CHAIN_HEALTH_ROWS,
  DEMO_BUDGET,
  DEMO_GOAL,
  PROVIDERS,
  type AttackRun,
  type CategoryId,
  type HealthResponse,
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
import { explorerClusterConnection, mandatePda, orderPda, programId } from "./chain/send.ts";
import {
  LLM_PROVIDER,
  MODEL_ALPHA,
  MODEL_DEEP,
  MODEL_PREMIUM,
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
import { db, facts, saveFacts } from "./db.ts";
import { nvidiaLatestQuarter } from "./edgar.ts";
import { llmDeliver, llmPlan, llmRubric } from "./llm.ts";
import {
  checkClaims,
  checkStructure,
  counterfactual,
  finalScore,
  percentPassed,
  formatDusdc,
  missionHash,
  parseDusdc,
  quoteLine,
  rescaleBudgets,
} from "./math.ts";
import { eventsFor, publish } from "./sse.ts";
import { DUSDC_MINT, PROGRAM_ID } from "./config.ts";

/** Read one order account from chain, or null if it does not exist. */
async function readOrder(chainMissionId: bigint, orderId: bigint) {
  const owner = new OwnerClient();
  const mandate = mandatePda(owner.owner.publicKey, chainMissionId, programId());
  const pda = orderPda(mandate, orderId, programId());
  if (!(await owner.connection.getAccountInfo(pda))) return null;
  // Anchor returns camelCase fields; u64 values come back as BN.
  const raw = await (owner.program.account as { order: { fetch: (k: PublicKey) => Promise<any> } }).order.fetch(pda);
  return {
    provider: raw.provider as PublicKey,
    lineIndex: Number(raw.lineIndex),
    claimedScore: Number(raw.claimedScore),
    settled: raw.settled as boolean,
    score: Number(raw.score),
    paid: BigInt(raw.paid.toString()),
  };
}

/**
 * Research line cap. $0.25 admits Premium ($0.20), so it competes and loses on
 * expected cost instead of being excluded. (shared DEMO_RESEARCH_CAP is still 0.10.)
 */
const RESEARCH_CAP = "0.250000";

/**
 * Reference facts for verification, loaded from SEC EDGAR the first time and
 * kept in SQLite. The values are printed so a person can check them.
 */
export async function referenceFacts() {
  if (facts().length === 0) {
    const latest = await nvidiaLatestQuarter();
    saveFacts(latest);
    console.log(`Reference facts from SEC EDGAR, ${latest[0]!.periodLabel}:`);
    for (const f of latest) console.log(`  ${f.key.padEnd(15)} ${+f.value.toFixed(6)}  ${f.label}`);
    console.log(`  source: ${latest[0]!.sourceUrl}`);
  }
  return facts();
}

function nowIso() {
  return new Date().toISOString();
}

function demoLines(): LinePlan[] {
  const raw: LinePlan[] = [
    { index: 0, category: 0, categoryName: "research", budget: "0.400000", maxUnitPrice: RESEARCH_CAP, minScore: 85 },
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
  return insertMission(goal, budget, lines);
}

function insertMission(goal: string, budget: string, lines: LinePlan[]): Mission {
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
  // Purchase commits vault funds before delivery, and only the verifier can
  // release them. Refuse up front rather than orphan an unsettled order.
  if (!llmKey()) throw new Error(llmMissingMessage());
  if (activeMissions.has(id)) throw new Error("Mission is already running");
  if (miss.status === "running") {
    throw new Error("Mission was interrupted mid-run. Use recover to settle its open orders instead of buying again.");
  }
  activeMissions.add(id);
  try {
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
        recordPurchase(id, orderId, chosen.provider, line.index, chosen.claimedScore, purchased.signature);
        const { score: final } = await deliverVerifySettle({ missionId: id, chainMissionId: BigInt(miss.chainMissionId), goal: miss.goal, line, provider: chosen.provider, orderId, act, verifier });
        if (final >= line.minScore) break;
      }
      if (act < 3) act = (act + 1) as 1 | 2 | 3;
    }
    db.prepare("UPDATE missions SET status=? WHERE id=?").run("settled", id);
    return getMission(id);
  } finally {
    activeMissions.delete(id);
  }
}

/** Missions whose engine loop is executing right now. Recovery skips them. */
const activeMissions = new Set<string>();

/**
 * Write the order row as soon as the purchase confirms, before delivery.
 * If delivery or scoring fails afterwards, the row is the record that an
 * on-chain commitment is waiting for a settle.
 */
function recordPurchase(missionId: string, orderId: bigint, provider: ProviderName, lineIndex: number, claimed: number, purchaseTx: string | null) {
  db.prepare(
    "INSERT INTO orders(mission_id, chain_order_id, provider, line_index, claimed, purchase_tx) VALUES (?,?,?,?,?,?)",
  ).run(missionId, orderId.toString(), provider, lineIndex, claimed, purchaseTx);
}

/**
 * The one path from a purchased order to a settled one: the provider
 * delivers, the delivery is scored against reference facts plus a rubric,
 * the verifier settles that score, and the amount paid is read back from
 * the order account rather than recomputed.
 */
async function deliverVerifySettle(opts: {
  missionId: string;
  chainMissionId: bigint;
  goal: string;
  line: LinePlan;
  provider: ProviderName;
  orderId: bigint;
  act: 1 | 2 | 3;
  verifier: VerifierClient;
}): Promise<{ score: number; paid: string }> {
  const { missionId, chainMissionId, goal, line, provider, orderId, act, verifier } = opts;
  const refs = await referenceFacts();
  const delivery = await llmDeliver(provider, goal, line.categoryName, refs);
  db.prepare("INSERT INTO deliveries(mission_id, provider, markdown, claims_json) VALUES (?,?,?,?)").run(
    missionId,
    provider,
    delivery.markdown,
    JSON.stringify(delivery.claims),
  );

  // Verify: every claim against the EDGAR reference, plus structure checks and a rubric.
  const claims = checkClaims(delivery.claims, refs);
  const structure = checkStructure(delivery.markdown);
  const rubric = Math.round(await llmRubric(goal, delivery.markdown));
  const factPct = percentPassed(claims);
  const structurePct = percentPassed(structure);
  const final = finalScore(factPct, structurePct, rubric);

  const settleTx = await verifier.settle({
    missionId: chainMissionId,
    orderId,
    score: final,
    provider: loadKey(provider).publicKey,
  });
  const settled = await readOrder(chainMissionId, orderId);
  if (!settled?.settled) throw new Error(`Order ${orderId} not settled on chain after ${settleTx}`);
  const paid = formatDusdc(settled.paid);
  db.prepare(
    "UPDATE orders SET verified=?, paid=?, settle_tx=? WHERE mission_id=? AND chain_order_id=?",
  ).run(final, formatDusdc(settled.paid), settleTx, missionId, orderId.toString());
  db.prepare("INSERT INTO verifications(mission_id, fact_score, rubric_score, final_score) VALUES (?,?,?,?)").run(
    missionId,
    factPct,
    rubric,
    final,
  );
  const evidence = {
    provider,
    lineIndex: line.index,
    minScore: line.minScore,
    claims,
    structure,
    factScore: factPct,
    structureScore: structurePct,
    rubricScore: rubric,
    finalScore: final,
    formula: "0.7 × facts + 0.15 × structure + 0.15 × rubric",
    paid,
    deliverySource: delivery.source,
    markdown: delivery.markdown,
    settleTx,
    settleUrl: explorerTx(settleTx),
  };
  db.prepare("INSERT INTO evidence(mission_id, chain_order_id, provider, payload) VALUES (?,?,?,?)").run(
    missionId,
    orderId.toString(),
    provider,
    JSON.stringify(evidence),
  );
  publish(missionId, {
    type: "settle",
    act,
    message: `Settled ${provider} · score ${final} · paid ${paid}`,
    tx: settleTx,
    explorerUrl: null,
  });
  return { score: final, paid };
}

/**
 * Settle every order of a mission that was purchased on chain but never
 * settled, for example because delivery failed mid-run. Orders are found by
 * scanning the mandate's order PDAs, so this also recovers runs from before
 * the order row was written at purchase time.
 */
export async function recoverMission(id: string): Promise<{ missionId: string; recovered: number; note?: string }> {
  if (activeMissions.has(id)) return { missionId: id, recovered: 0, note: "mission is running now" };
  const miss = getMission(id);
  const err = chainConfigured();
  if (err) throw new Error(err);
  if (!llmKey()) throw new Error(llmMissingMessage());
  if (!miss.createTx) return { missionId: id, recovered: 0, note: "never signed on chain" };
  const chainId = BigInt(miss.chainMissionId);
  const next = mandateNextOrderId(await readMandate(chainId));
  const verifier = new VerifierClient();
  const byKey = new Map(PROVIDERS.map((p) => [loadKey(p).publicKey.toBase58(), p] as const));
  let recovered = 0;
  activeMissions.add(id);
  try {
    for (let oid = 0n; oid < next; oid++) {
      const order = await readOrder(chainId, oid);
      if (!order || order.settled) continue;
      const provider = byKey.get(order.provider.toBase58());
      if (!provider) throw new Error(`Order ${oid} names unknown provider ${order.provider.toBase58()}`);
      const line = miss.lines[order.lineIndex];
      if (!line) throw new Error(`Order ${oid} has line ${order.lineIndex}, not in the plan`);
      const known = db
        .prepare("SELECT 1 FROM orders WHERE mission_id=? AND chain_order_id=?")
        .get(id, oid.toString());
      if (!known) recordPurchase(id, oid, provider, line.index, order.claimedScore, null);
      publish(id, { type: "recover", act: null, message: `Recovering unsettled order ${oid} (${provider})`, tx: null, explorerUrl: null });
      await deliverVerifySettle({ missionId: id, chainMissionId: chainId, goal: miss.goal, line, provider, orderId: oid, act: 3, verifier });
      recovered += 1;
    }
  } finally {
    activeMissions.delete(id);
  }
  if (miss.status === "running") db.prepare("UPDATE missions SET status=? WHERE id=?").run("settled", id);
  return { missionId: id, recovered };
}

/** Recover every mission left in `running` by a crashed or failed run. */
export async function recoverStuck() {
  const ids = db.prepare("SELECT id FROM missions WHERE status = 'running'").all() as Array<{ id: string }>;
  const results = [];
  for (const { id } of ids) {
    try {
      results.push(await recoverMission(id));
    } catch (e) {
      results.push({ missionId: id, recovered: 0, note: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/**
 * "Ignore Assay — buy cheapest": purchase the cheapest eligible quote on a
 * line even though Assay recommends another, then verify and settle it as
 * usual. Returns what the recommendation expected next to what happened.
 */
export async function overrideBuyCheapest(id: string, lineIndex = 0) {
  const miss = getMission(id);
  const err = chainConfigured();
  if (err) throw new Error(err);
  if (!llmKey()) throw new Error(llmMissingMessage());
  if (!miss.createTx || miss.status === "closed") throw new Error(`Mission must be signed and open (status ${miss.status})`);
  if (activeMissions.has(id)) throw new Error("Mission is running now");
  const line = miss.lines[lineIndex];
  if (!line) throw new Error(`No line ${lineIndex} in this mission`);

  const quotes = (await quotesFor([line]))[0]!;
  const recommended = pickQuote(quotes);
  const cheapest = quotes
    .filter((q) => q.eligible)
    .sort((a, b) => Number(parseDusdc(a.full) - parseDusdc(b.full)))[0]!;

  activeMissions.add(id);
  try {
    publish(id, {
      type: "override",
      act: null,
      message: `Owner ignored Assay: buying ${cheapest.provider} at ${cheapest.full} instead of ${recommended.provider} (ECS ${recommended.ecs})`,
      tx: null,
      explorerUrl: null,
    });
    db.prepare("INSERT INTO decisions(mission_id, line_index, provider, payload) VALUES (?,?,?,?)").run(
      id,
      line.index,
      cheapest.provider,
      JSON.stringify({ lineIndex: line.index, provider: cheapest.provider, quote: cheapest, override: true, recommended: recommended.provider }),
    );
    const chainId = BigInt(miss.chainMissionId);
    const orderId = mandateNextOrderId(await readMandate(chainId));
    const purchased = await new AgentClient().purchase({
      missionId: chainId,
      lineIndex: line.index,
      unitPrice: parseDusdc(cheapest.full),
      fullAmount: parseDusdc(cheapest.full),
      claimedScore: cheapest.claimedScore,
      provider: loadKey(cheapest.provider).publicKey,
      orderId,
    });
    publish(id, { type: "purchase", act: null, message: `Override purchase · ${cheapest.provider}`, tx: purchased.signature, explorerUrl: null });
    recordPurchase(id, orderId, cheapest.provider, line.index, cheapest.claimedScore, purchased.signature);
    const { score, paid } = await deliverVerifySettle({
      missionId: id,
      chainMissionId: chainId,
      goal: miss.goal,
      line,
      provider: cheapest.provider,
      orderId,
      act: 2,
      verifier: new VerifierClient(),
    });
    return {
      orderId: orderId.toString(),
      purchaseUrl: explorerTx(purchased.signature),
      counterfactual: counterfactual({
        recommended,
        override: cheapest,
        score,
        paid,
        minScore: line.minScore,
        verificationFee: VERIFICATION_FEE,
      }),
      evidence: missionEvidence(id).find((e) => e.orderId === orderId.toString()) ?? null,
    };
  } finally {
    activeMissions.delete(id);
  }
}

/** Every verified order of a mission with its full evidence and tx links. */
export function missionEvidence(id: string) {
  const rows = db
    .prepare(
      `SELECT e.chain_order_id as orderId, e.payload, o.claimed, o.purchase_tx as purchaseTx
       FROM evidence e LEFT JOIN orders o ON o.mission_id = e.mission_id AND o.chain_order_id = e.chain_order_id
       WHERE e.mission_id = ? ORDER BY e.id`,
    )
    .all(id) as Array<{ orderId: string; payload: string; claimed: number | null; purchaseTx: string | null }>;
  return rows.map((r) => ({
    orderId: r.orderId,
    claimedScore: r.claimed,
    purchaseUrl: r.purchaseTx ? explorerTx(r.purchaseTx) : null,
    ...JSON.parse(r.payload),
  }));
}

export async function closeMission(id: string) {
  const miss = getMission(id);
  const owner = new OwnerClient();
  const sig = await owner.closeMandate(BigInt(miss.chainMissionId));
  db.prepare("UPDATE missions SET status=?, close_tx=? WHERE id=?").run("closed", sig, id);
  publish(id, { type: "close", act: 3, message: "Mandate closed, vault returned", tx: sig, explorerUrl: null });
  return getMission(id);
}

/**
 * Warmup mandate: one research line whose cap admits all three providers.
 * The demo research line caps at 0.10, which excludes Premium (0.20), so
 * buying Premium under the demo plan would mean mislabeling another quote.
 */
const WARMUP_LINES: LinePlan[] = [
  { index: 0, category: 0, categoryName: "research", budget: "0.500000", maxUnitPrice: "0.250000", minScore: 85 },
];

/**
 * Build real history: N single-order missions, providers round-robin.
 * Every score comes from the same deliver → verify path as a live mission,
 * and nothing is recorded without a confirmed settle.
 */
export async function warmup(n: number) {
  const err = chainConfigured();
  if (err) throw new Error(err);
  if (!llmKey()) throw new Error(llmMissingMessage());
  const agent = new AgentClient();
  const verifier = new VerifierClient();
  const results = [];
  for (let i = 0; i < n; i++) {
    const provider = PROVIDERS[i % PROVIDERS.length]!;
    const planned = insertMission(DEMO_GOAL, "0.500000", WARMUP_LINES);
    await signMission(planned.id);
    const miss = getMission(planned.id);
    const chainId = BigInt(miss.chainMissionId);
    const line = miss.lines[0]!;
    const quote = (await quotesFor([line]))[0]!.find((q) => q.provider === provider);
    if (!quote?.eligible) throw new Error(`Warmup line does not admit ${provider}: ${quote?.ineligibleReason}`);
    const orderId = mandateNextOrderId(await readMandate(chainId));
    db.prepare("UPDATE missions SET status=? WHERE id=?").run("running", planned.id);
    const purchased = await agent.purchase({
      missionId: chainId,
      lineIndex: line.index,
      unitPrice: parseDusdc(quote.full),
      fullAmount: parseDusdc(quote.full),
      claimedScore: quote.claimedScore,
      provider: loadKey(provider).publicKey,
      orderId,
    });
    publish(planned.id, { type: "purchase", act: 1, message: `Warmup purchase · ${provider}`, tx: purchased.signature, explorerUrl: null });
    recordPurchase(planned.id, orderId, provider, line.index, quote.claimedScore, purchased.signature);
    const { score } = await deliverVerifySettle({ missionId: planned.id, chainMissionId: chainId, goal: miss.goal, line, provider, orderId, act: 2, verifier });
    db.prepare("UPDATE missions SET status=? WHERE id=?").run("settled", planned.id);
    await closeMission(planned.id);
    results.push({ missionId: planned.id, provider, claimed: quote.claimedScore, score, purchase: purchased.signature });
  }
  return results;
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
  else push("LLM", "pass", `${LLM_PROVIDER}: ${MODEL_ALPHA} / ${MODEL_DEEP} / ${MODEL_PREMIUM}`);

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
