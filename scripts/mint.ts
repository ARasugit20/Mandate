import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { DUSDC_MINT, SOLANA_RPC_URL, loadKey } from "../server/src/config.ts";
import { formatDusdc } from "../server/src/math.ts";

if (!SOLANA_RPC_URL) {
  console.error("SOLANA_RPC_URL is not set");
  process.exit(1);
}

const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const owner = loadKey("owner");

async function main() {
  let mint: PublicKey;
  if (DUSDC_MINT) {
    mint = new PublicKey(DUSDC_MINT);
    console.log(`using DUSDC_MINT ${mint.toBase58()}`);
  } else {
    mint = await createMint(connection, owner, owner.publicKey, null, 6);
    console.log(`created dUSDC mint ${mint.toBase58()}`);
    console.log(`set DUSDC_MINT=${mint.toBase58()} in .env`);
  }

  const ata = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
  const need = 100_000_000n - ata.amount;
  if (need > 0n) {
    await mintTo(connection, owner, mint, ata.address, owner, need);
  }
  const after = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
  console.log(`owner dUSDC ${formatDusdc(after.amount)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
