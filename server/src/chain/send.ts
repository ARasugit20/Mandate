import { Program, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type Signer,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import idlJson from "./idl/mandate.json" with { type: "json" };
import { PROGRAM_ID, SOLANA_RPC_URL } from "../config.ts";

export function explorerClusterConnection(): Connection {
  if (!SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is not set");
  return new Connection(SOLANA_RPC_URL, "confirmed");
}

export function programId(): PublicKey {
  if (!PROGRAM_ID) throw new Error("PROGRAM_ID is not set");
  return new PublicKey(PROGRAM_ID);
}

export function mandateProgram(connection: Connection, payer: Signer) {
  const idl = { ...(idlJson as Idl), address: programId().toBase58() };
  return new Program(
    idl,
    {
      connection,
      publicKey: payer.publicKey,
    } as never,
  );
}

export async function sendAndConfirm(
  connection: Connection,
  payer: Signer,
  ixs: TransactionInstruction[],
  extraSigners: Signer[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...extraSigners]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

export function errorNameFromLogs(logs: string[] | null | undefined): string {
  const blob = (logs ?? []).join("\n");
  const m = blob.match(/Error Code: ([A-Za-z0-9_]+)/);
  if (m?.[1]) return m[1];
  const m2 = blob.match(/custom program error: (.+)/i);
  return m2?.[1]?.trim() ?? "unknown";
}

export async function sendExpectFail(
  connection: Connection,
  payer: Signer,
  ixs: TransactionInstruction[],
  extraSigners: Signer[] = [],
): Promise<{ name: string; signature: string; logs: string[] }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...extraSigners]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 0 });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  const txRes = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const logs = txRes?.meta?.logMessages ?? [];
  const name = errorNameFromLogs(logs);
  if (!conf.value.err) {
    return { name: "ok", signature: sig, logs };
  }
  return { name, signature: sig, logs };
}

export function mandatePda(owner: PublicKey, missionId: bigint, program: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(missionId);
  return PublicKey.findProgramAddressSync([Buffer.from("mandate"), owner.toBuffer(), buf], program)[0];
}

export function orderPda(mandate: PublicKey, orderId: bigint, program: PublicKey): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(orderId);
  return PublicKey.findProgramAddressSync([Buffer.from("order"), mandate.toBuffer(), buf], program)[0];
}

export function providerPda(owner: PublicKey, provider: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("provider"), owner.toBuffer(), provider.toBuffer()], program)[0];
}
