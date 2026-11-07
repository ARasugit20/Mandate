import BN from "bn.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Signer } from "@solana/web3.js";
import {
  DUSDC_MINT,
  loadKey,
} from "../config.ts";
import {
  explorerClusterConnection,
  mandatePda,
  mandateProgram,
  orderPda,
  programId,
  providerPda,
  sendAndConfirm,
  sendExpectFail,
} from "./send.ts";

export type LineInput = {
  category: number;
  budget: bigint;
  maxUnitPrice: bigint;
  minScore: number;
};

function mint(): PublicKey {
  if (!DUSDC_MINT) throw new Error("DUSDC_MINT is not set");
  return new PublicKey(DUSDC_MINT);
}

function bn(n: bigint | number): BN {
  return new BN(n.toString());
}

export class OwnerClient {
  readonly owner = loadKey("owner");
  readonly connection = explorerClusterConnection();
  readonly program = mandateProgram(this.connection, this.owner);

  pda(missionId: bigint) {
    return mandatePda(this.owner.publicKey, missionId, programId());
  }

  statsPda(provider: PublicKey) {
    return providerPda(this.owner.publicKey, provider, programId());
  }

  async createMandate(missionId: bigint, expiresAt: number, lines: LineInput[], agent: PublicKey, verifier: PublicKey) {
    const mandate = this.pda(missionId);
    const m = mint();
    const ownerAta = getAssociatedTokenAddressSync(m, this.owner.publicKey);
    const vault = getAssociatedTokenAddressSync(m, mandate, true);
    const ix = await this.program.methods
      .createMandate(
        bn(missionId),
        bn(expiresAt),
        lines.map((l) => ({
          category: l.category,
          budget: bn(l.budget),
          maxUnitPrice: bn(l.maxUnitPrice),
          minScore: l.minScore,
        })),
      )
      .accounts({
        owner: this.owner.publicKey,
        agent,
        verifier,
        mint: m,
        ownerAta,
        mandate,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await sendAndConfirm(this.connection, this.owner, [ix]);
    return { signature: sig, mandate: mandate.toBase58() };
  }

  async registerProvider(provider: PublicKey) {
    const ix = await this.program.methods
      .registerProvider()
      .accounts({
        owner: this.owner.publicKey,
        provider,
        providerStats: this.statsPda(provider),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return sendAndConfirm(this.connection, this.owner, [ix]);
  }

  async closeMandate(missionId: bigint) {
    const mandate = this.pda(missionId);
    const m = mint();
    const ix = await this.program.methods
      .closeMandate()
      .accounts({
        owner: this.owner.publicKey,
        mandate,
        mint: m,
        ownerAta: getAssociatedTokenAddressSync(m, this.owner.publicKey),
        vault: getAssociatedTokenAddressSync(m, mandate, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendAndConfirm(this.connection, this.owner, [ix]);
  }

  async closeExpectFail(missionId: bigint, signer: Signer) {
    const mandate = this.pda(missionId);
    const m = mint();
    const program = mandateProgram(this.connection, signer);
    const ix = await program.methods
      .closeMandate()
      .accounts({
        owner: signer.publicKey,
        mandate,
        mint: m,
        ownerAta: getAssociatedTokenAddressSync(m, this.owner.publicKey),
        vault: getAssociatedTokenAddressSync(m, mandate, true),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendExpectFail(this.connection, signer, [ix]);
  }
}

export class AgentClient {
  readonly agent = loadKey("agent");
  readonly owner = loadKey("owner");
  readonly connection = explorerClusterConnection();
  readonly program = mandateProgram(this.connection, this.agent);

  async purchase(opts: {
    missionId: bigint;
    lineIndex: number;
    unitPrice: bigint;
    fullAmount: bigint;
    claimedScore: number;
    provider: PublicKey;
    orderId: bigint;
  }) {
    const mandate = mandatePda(this.owner.publicKey, opts.missionId, programId());
    const order = orderPda(mandate, opts.orderId, programId());
    const ix = await this.program.methods
      .purchase(opts.lineIndex, bn(opts.unitPrice), bn(opts.fullAmount), opts.claimedScore)
      .accounts({
        mandate,
        agent: this.agent.publicKey,
        provider: opts.provider,
        providerStats: providerPda(this.owner.publicKey, opts.provider, programId()),
        order,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sig = await sendAndConfirm(this.connection, this.agent, [ix]);
    return { signature: sig, order: order.toBase58(), orderId: opts.orderId };
  }

  async purchaseExpectFail(opts: {
    missionId: bigint;
    lineIndex: number;
    unitPrice: bigint;
    fullAmount: bigint;
    claimedScore: number;
    provider: PublicKey;
    orderId: bigint;
  }) {
    const mandate = mandatePda(this.owner.publicKey, opts.missionId, programId());
    const order = orderPda(mandate, opts.orderId, programId());
    const ix = await this.program.methods
      .purchase(opts.lineIndex, bn(opts.unitPrice), bn(opts.fullAmount), opts.claimedScore)
      .accounts({
        mandate,
        agent: this.agent.publicKey,
        provider: opts.provider,
        providerStats: providerPda(this.owner.publicKey, opts.provider, programId()),
        order,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return sendExpectFail(this.connection, this.agent, [ix]);
  }
}

export class VerifierClient {
  readonly verifier = loadKey("verifier");
  readonly owner = loadKey("owner");
  readonly connection = explorerClusterConnection();
  readonly program = mandateProgram(this.connection, this.verifier);

  async settle(opts: { missionId: bigint; orderId: bigint; score: number; provider: PublicKey }) {
    const mandate = mandatePda(this.owner.publicKey, opts.missionId, programId());
    const order = orderPda(mandate, opts.orderId, programId());
    const m = mint();
    const ix = await this.program.methods
      .settle(opts.score)
      .accounts({
        mandate,
        verifier: this.verifier.publicKey,
        order,
        providerStats: providerPda(this.owner.publicKey, opts.provider, programId()),
        vault: getAssociatedTokenAddressSync(m, mandate, true),
        providerAta: getAssociatedTokenAddressSync(m, opts.provider),
        mint: m,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendAndConfirm(this.connection, this.verifier, [ix]);
  }

  async settleExpectFail(opts: {
    missionId: bigint;
    orderId: bigint;
    score: number;
    provider: PublicKey;
    signer: Signer;
  }) {
    const mandate = mandatePda(this.owner.publicKey, opts.missionId, programId());
    const order = orderPda(mandate, opts.orderId, programId());
    const m = mint();
    const program = mandateProgram(this.connection, opts.signer);
    const ix = await program.methods
      .settle(opts.score)
      .accounts({
        mandate,
        verifier: opts.signer.publicKey,
        order,
        providerStats: providerPda(this.owner.publicKey, opts.provider, programId()),
        vault: getAssociatedTokenAddressSync(m, mandate, true),
        providerAta: getAssociatedTokenAddressSync(m, opts.provider),
        mint: m,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return sendExpectFail(this.connection, opts.signer, [ix]);
  }
}

type AnchorNum = { toString(): string } | number | bigint;

export type ProviderStatsAccount = {
  n?: AnchorNum;
  cFull?: AnchorNum;
  cHalf?: AnchorNum;
  cZero?: AnchorNum;
  c_full?: AnchorNum;
  c_half?: AnchorNum;
  c_zero?: AnchorNum;
  sumVerified?: AnchorNum;
  sumClaimed?: AnchorNum;
  sum_verified?: AnchorNum;
  sum_claimed?: AnchorNum;
};

export type MandateAccount = {
  nextOrderId?: AnchorNum;
  next_order_id?: AnchorNum;
};

export function anchorNum(v: AnchorNum | undefined): number {
  if (v == null) return 0;
  return Number(v.toString());
}

export function mandateNextOrderId(m: MandateAccount): bigint {
  const v = m.nextOrderId ?? m.next_order_id;
  if (v == null) throw new Error("mandate missing next_order_id");
  return BigInt(v.toString());
}

export async function readProviderStats(provider: PublicKey): Promise<ProviderStatsAccount | null> {
  const owner = loadKey("owner");
  const connection = explorerClusterConnection();
  const program = mandateProgram(connection, owner);
  const pda = providerPda(owner.publicKey, provider, programId());
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return (program.account as { providerStats: { fetch: (k: PublicKey) => Promise<ProviderStatsAccount> } }).providerStats.fetch(
    pda,
  );
}

export async function readMandate(missionId: bigint): Promise<MandateAccount> {
  const owner = loadKey("owner");
  const connection = explorerClusterConnection();
  const program = mandateProgram(connection, owner);
  const pda = mandatePda(owner.publicKey, missionId, programId());
  return (program.account as { mandate: { fetch: (k: PublicKey) => Promise<MandateAccount> } }).mandate.fetch(pda);
}

export async function dusdcBalance(owner: PublicKey): Promise<bigint | null> {
  if (!DUSDC_MINT) throw new Error("DUSDC_MINT is not set");
  const connection = explorerClusterConnection();
  const ata = getAssociatedTokenAddressSync(new PublicKey(DUSDC_MINT), owner);
  try {
    const acc = await getAccount(connection, ata);
    return BigInt(acc.amount.toString());
  } catch {
    return null;
  }
}

export { sendExpectFail };
