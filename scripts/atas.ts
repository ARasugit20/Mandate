import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { DUSDC_MINT, SOLANA_RPC_URL, loadKey } from "../server/src/config.ts";

if (!SOLANA_RPC_URL || !DUSDC_MINT) {
  console.error("Need SOLANA_RPC_URL and DUSDC_MINT");
  process.exit(1);
}
const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const owner = loadKey("owner");
const mint = new PublicKey(DUSDC_MINT);
const holders = ["owner", "alpha", "deep", "premium", "attacker", "impostor"] as const;
for (const name of holders) {
  const kp = loadKey(name);
  const ata = await getOrCreateAssociatedTokenAccount(connection, owner, mint, kp.publicKey);
  console.log(`${name} ATA ${ata.address.toBase58()}`);
}
const agent = loadKey("agent");
const agentAta = getAssociatedTokenAddressSync(mint, agent.publicKey);
const info = await connection.getAccountInfo(agentAta);
if (info) {
  console.error("FAIL: agent has a dUSDC ATA — do not create one");
  process.exit(1);
}
console.log("agent has no dUSDC ATA (required)");
