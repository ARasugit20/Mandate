import { OwnerClient, AgentClient, readMandate, mandateNextOrderId } from "../server/src/chain/clients.ts";
import { loadKey } from "../server/src/config.ts";
import { planMission, getMission } from "../server/src/engine.ts";
import { parseDusdc } from "../server/src/math.ts";
import { DEMO_GOAL, DEMO_BUDGET } from "../shared/types.ts";

async function main() {
  const owner = new OwnerClient();
  const agent = new AgentClient();
  const planned = await planMission(DEMO_GOAL, DEMO_BUDGET);
  const miss = getMission(planned.id);
  console.log("mission", miss.chainMissionId);

  let created;
  try {
    created = await owner.createMandate(
      BigInt(miss.chainMissionId),
      Math.floor(Date.now() / 1000) + 3600,
      miss.lines.map((l) => ({
        category: l.category,
        budget: parseDusdc(l.budget),
        maxUnitPrice: parseDusdc(l.maxUnitPrice),
        minScore: l.minScore,
      })),
      loadKey("agent").publicKey,
      loadKey("verifier").publicKey,
    );
    console.log("createMandate OK", created.signature);
  } catch (e) {
    console.log("createMandate FAILED:", JSON.stringify(e));
    return;
  }

  const onchain = await readMandate(BigInt(miss.chainMissionId));
  const orderId = mandateNextOrderId(onchain);
  try {
    const fail = await agent.purchaseExpectFail({
      missionId: BigInt(miss.chainMissionId),
      lineIndex: 0,
      unitPrice: 30_000n,
      fullAmount: 30_000n,
      claimedScore: 95,
      provider: loadKey("attacker").publicKey,
      orderId,
    });
    console.log("purchaseExpectFail returned", fail.name);
  } catch (e) {
    console.log("purchaseExpectFail THREW:", JSON.stringify(e));
  }
}

main().catch((e) => {
  console.log("outer:", JSON.stringify(e));
  process.exit(1);
});
