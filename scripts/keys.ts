import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { KEY_NAMES, KEYS_DIR, keyPath } from "../server/src/config.ts";

mkdirSync(KEYS_DIR, { recursive: true });
for (const name of KEY_NAMES) {
  const p = keyPath(name);
  if (!existsSync(p)) {
    const kp = Keypair.generate();
    writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`created ${name} ${kp.publicKey.toBase58()}`);
  } else {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
    console.log(`exists  ${name} ${kp.publicKey.toBase58()}`);
  }
}
