import { OwnerClient } from "../server/src/chain/clients.ts";
import { chainConfigured, loadKey } from "../server/src/config.ts";

const err = chainConfigured();
if (err) {
  console.error(err);
  process.exit(1);
}
const owner = new OwnerClient();
for (const name of ["alpha", "deep", "premium"] as const) {
  const pk = loadKey(name).publicKey;
  try {
    const sig = await owner.registerProvider(pk);
    console.log(`registered ${name} ${sig}`);
  } catch (e) {
    console.log(`register ${name}: ${e instanceof Error ? e.message : e}`);
  }
}
