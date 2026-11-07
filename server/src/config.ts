import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { ProviderName } from "../../shared/types.ts";

const ROOT = resolve(import.meta.dirname, "../..");

export const ROOT_DIR = ROOT;
export const KEYS_DIR = resolve(ROOT, ".keys");

function readEnvFile() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (process.env[k] == null) process.env[k] = v;
  }
}
readEnvFile();

export const PORT = Number(process.env.PORT ?? 8787);
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "";
export const PROGRAM_ID = process.env.PROGRAM_ID ?? "";
export const DUSDC_MINT = process.env.DUSDC_MINT ?? "";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const VERIFICATION_FEE = Number(process.env.VERIFICATION_FEE ?? "0.02");
export const RETRY_PENALTY = Number(process.env.RETRY_PENALTY ?? "0.03");
export const MODEL_ALPHA = process.env.MODEL_ALPHA ?? "claude-haiku-4-5-20251001";
export const MODEL_DEEP = process.env.MODEL_DEEP ?? "claude-sonnet-4-5-20250929";
export const MODEL_PREMIUM = process.env.MODEL_PREMIUM ?? "claude-opus-4-1-20250805";
export const MODEL_PLANNER = process.env.MODEL_PLANNER ?? MODEL_DEEP;
export const MODEL_RUBRIC = process.env.MODEL_RUBRIC ?? MODEL_DEEP;

export const KEY_NAMES = [
  "owner",
  "agent",
  "verifier",
  "alpha",
  "deep",
  "premium",
  "attacker",
  "impostor",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export function keyPath(name: KeyName): string {
  return resolve(KEYS_DIR, `${name}.json`);
}

export function loadKey(name: KeyName): Keypair {
  const p = keyPath(name);
  if (!existsSync(p)) throw new Error(`Missing keypair ${p}`);
  const secret = Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

export function tryLoadKey(name: KeyName): Keypair | null {
  try {
    return loadKey(name);
  } catch {
    return null;
  }
}

export function providerKey(name: ProviderName): Keypair {
  return loadKey(name);
}

export function chainConfigured(): string | null {
  if (!SOLANA_RPC_URL) return "SOLANA_RPC_URL is not set";
  if (!PROGRAM_ID) return "PROGRAM_ID is not set";
  if (!DUSDC_MINT) return "DUSDC_MINT is not set";
  for (const name of KEY_NAMES) {
    if (!existsSync(keyPath(name))) return `Missing .keys/${name}.json`;
  }
  return null;
}

export function explorerTx(sig: string): string {
  const url = SOLANA_RPC_URL.toLowerCase();
  const cluster = url.includes("devnet") ? "devnet" : url.includes("127.0.0.1") || url.includes("localhost") ? "custom" : "devnet";
  const base = `https://explorer.solana.com/tx/${sig}`;
  if (cluster === "custom") return `${base}?cluster=custom&customUrl=${encodeURIComponent(SOLANA_RPC_URL)}`;
  return `${base}?cluster=${cluster}`;
}
