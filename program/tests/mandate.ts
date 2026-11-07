/**
 * Localnet tests. Run with `cd program && anchor test`.
 * Requires Anchor 0.32.1 and a local validator.
 */
import assert from "node:assert/strict";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

type MandateProgram = Program<anchor.Idl>;

const MICROS = 1_000_000;

function bn(n: number | bigint) {
  return new BN(n.toString());
}

function errName(e: unknown): string {
  const logs = (e as { logs?: string[] }).logs ?? [];
  const blob = logs.join("\n") + String(e);
  const m = blob.match(/Error Code: ([A-Za-z0-9_]+)/);
  return m?.[1] ?? blob.slice(0, 180);
}

async function expectFail(fn: () => Promise<unknown>, name: string) {
  try {
    await fn();
    throw new Error(`expected ${name}, transaction succeeded`);
  } catch (e) {
    const got = errName(e);
    assert.equal(got, name, `expected ${name}, got ${got}`);
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Mandate as MandateProgram;
  const connection = provider.connection;
  const owner = (provider.wallet as anchor.Wallet).payer;
  const agent = Keypair.generate();
  const verifier = Keypair.generate();
  const alpha = Keypair.generate();
  const deep = Keypair.generate();
  const premium = Keypair.generate();
  const attacker = Keypair.generate();
  const impostor = Keypair.generate();

  for (const kp of [agent, verifier, alpha, deep, premium, attacker, impostor]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 2e9);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const mint = await createMint(connection, owner, owner.publicKey, null, 6);
  const ownerAta = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
  await mintTo(connection, owner, mint, ownerAta.address, owner, 1_000n * BigInt(MICROS));
  for (const kp of [alpha, deep, premium, attacker, impostor]) {
    await getOrCreateAssociatedTokenAccount(connection, owner, mint, kp.publicKey);
  }

  const pid = program.programId;
  const mandatePda = (missionId: number) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(missionId));
    return PublicKey.findProgramAddressSync([Buffer.from("mandate"), owner.publicKey.toBuffer(), buf], pid)[0];
  };
  const statsPda = (provider: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("provider"), owner.publicKey.toBuffer(), provider.toBuffer()], pid)[0];
  const orderPda = (mandate: PublicKey, orderId: number) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(orderId));
    return PublicKey.findProgramAddressSync([Buffer.from("order"), mandate.toBuffer(), buf], pid)[0];
  };

  const lines = [
    { category: 0, budget: bn(400_000), maxUnitPrice: bn(200_000), minScore: 75 },
    { category: 1, budget: bn(300_000), maxUnitPrice: bn(200_000), minScore: 75 },
    { category: 2, budget: bn(300_000), maxUnitPrice: bn(200_000), minScore: 75 },
  ];

  async function create(missionId: number, expiresIn = 3600) {
    const mandate = mandatePda(missionId);
    const vault = getAssociatedTokenAddressSync(mint, mandate, true);
    await program.methods
      .createMandate(bn(missionId), bn(Math.floor(Date.now() / 1000) + expiresIn), lines)
      .accounts({
        owner: owner.publicKey,
        agent: agent.publicKey,
        verifier: verifier.publicKey,
        mint,
        ownerAta: ownerAta.address,
        mandate,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return mandate;
  }

  for (const p of [alpha, deep, premium]) {
    await program.methods
      .registerProvider()
      .accounts({
        owner: owner.publicKey,
        provider: p.publicKey,
        providerStats: statsPda(p.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const m1 = await create(1);
  const vault = getAssociatedTokenAddressSync(mint, m1, true);

  async function buy(mandate: PublicKey, orderId: number, lineIndex: number, amount: number, provider: PublicKey, claimed = 95) {
    await program.methods
      .purchase(lineIndex, bn(amount), bn(amount), claimed)
      .accounts({
        mandate,
        agent: agent.publicKey,
        provider,
        providerStats: statsPda(provider),
        order: orderPda(mandate, orderId),
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();
  }
  async function settle(mandate: PublicKey, orderId: number, score: number, provider: PublicKey) {
    await program.methods
      .settle(score)
      .accounts({
        mandate,
        verifier: verifier.publicKey,
        order: orderPda(mandate, orderId),
        providerStats: statsPda(provider),
        vault,
        providerAta: getAssociatedTokenAddressSync(mint, provider),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([verifier])
      .rpc();
  }

  await buy(m1, 0, 0, 100_000, alpha.publicKey, 95);
  await settle(m1, 0, 93, alpha.publicKey);
  await buy(m1, 1, 1, 100_000, deep.publicKey, 92);
  await settle(m1, 1, 80, deep.publicKey);
  await buy(m1, 2, 2, 100_000, premium.publicKey, 98);
  await settle(m1, 2, 61, premium.publicKey);

  const statsA = await program.account.providerStats.fetch(statsPda(alpha.publicKey));
  const statsD = await program.account.providerStats.fetch(statsPda(deep.publicKey));
  const statsP = await program.account.providerStats.fetch(statsPda(premium.publicKey));
  assert.equal(Number(statsA.cFull ?? statsA.c_full), 1);
  assert.equal(Number(statsD.cHalf ?? statsD.c_half), 1);
  assert.equal(Number(statsP.cZero ?? statsP.c_zero), 1);

  await program.methods
    .closeMandate()
    .accounts({
      owner: owner.publicKey,
      mandate: m1,
      mint,
      ownerAta: ownerAta.address,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const m2 = await create(2);
  await expectFail(
    () =>
      program.methods
        .purchase(0, bn(100_000), bn(100_000), 95)
        .accounts({
          mandate: m2,
          agent: agent.publicKey,
          provider: attacker.publicKey,
          providerStats: statsPda(attacker.publicKey),
          order: orderPda(m2, 0),
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
    "ProviderNotRegistered",
  );
  await expectFail(
    () =>
      program.methods
        .purchase(0, bn(500_000), bn(100_000), 95)
        .accounts({
          mandate: m2,
          agent: agent.publicKey,
          provider: alpha.publicKey,
          providerStats: statsPda(alpha.publicKey),
          order: orderPda(m2, 0),
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
    "OverUnitPrice",
  );
  await program.methods
    .purchase(0, bn(100_000), bn(400_000), 95)
    .accounts({
      mandate: m2,
      agent: agent.publicKey,
      provider: alpha.publicKey,
      providerStats: statsPda(alpha.publicKey),
      order: orderPda(m2, 0),
      systemProgram: SystemProgram.programId,
    })
    .signers([agent])
    .rpc();
  await expectFail(
    () =>
      program.methods
        .purchase(0, bn(100_000), bn(1), 95)
        .accounts({
          mandate: m2,
          agent: agent.publicKey,
          provider: alpha.publicKey,
          providerStats: statsPda(alpha.publicKey),
          order: orderPda(m2, 1),
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
    "LineBudgetExceeded",
  );
  await expectFail(
    () =>
      program.methods
        .purchase(5, bn(100_000), bn(100_000), 95)
        .accounts({
          mandate: m2,
          agent: agent.publicKey,
          provider: alpha.publicKey,
          providerStats: statsPda(alpha.publicKey),
          order: orderPda(m2, 1),
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
    "NoMatchingLineItem",
  );

  const m3 = await create(3);
  await program.methods
    .purchase(0, bn(100_000), bn(100_000), 95)
    .accounts({
      mandate: m3,
      agent: agent.publicKey,
      provider: alpha.publicKey,
      providerStats: statsPda(alpha.publicKey),
      order: orderPda(m3, 0),
      systemProgram: SystemProgram.programId,
    })
    .signers([agent])
    .rpc();
  const vault3 = getAssociatedTokenAddressSync(mint, m3, true);
  const rand = Keypair.generate();
  await expectFail(
    () =>
      program.methods
        .settle(93)
        .accounts({
          mandate: m3,
          verifier: rand.publicKey,
          order: orderPda(m3, 0),
          providerStats: statsPda(alpha.publicKey),
          vault: vault3,
          providerAta: getAssociatedTokenAddressSync(mint, alpha.publicKey),
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([rand])
        .rpc(),
    "NotVerifier",
  );
  await expectFail(
    () =>
      program.methods
        .settle(93)
        .accounts({
          mandate: m3,
          verifier: agent.publicKey,
          order: orderPda(m3, 0),
          providerStats: statsPda(alpha.publicKey),
          vault: vault3,
          providerAta: getAssociatedTokenAddressSync(mint, alpha.publicKey),
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc(),
    "NotVerifier",
  );
  await program.methods
    .settle(93)
    .accounts({
      mandate: m3,
      verifier: verifier.publicKey,
      order: orderPda(m3, 0),
      providerStats: statsPda(alpha.publicKey),
      vault: vault3,
      providerAta: getAssociatedTokenAddressSync(mint, alpha.publicKey),
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([verifier])
    .rpc();
  await expectFail(
    () =>
      program.methods
        .settle(93)
        .accounts({
          mandate: m3,
          verifier: verifier.publicKey,
          order: orderPda(m3, 0),
          providerStats: statsPda(alpha.publicKey),
          vault: vault3,
          providerAta: getAssociatedTokenAddressSync(mint, alpha.publicKey),
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([verifier])
        .rpc(),
    "OrderAlreadySettled",
  );

  const m4 = await create(4, 3);
  await new Promise((r) => setTimeout(r, 5000));
  await expectFail(
    () =>
      program.methods
        .purchase(0, bn(100_000), bn(100_000), 95)
        .accounts({
          mandate: m4,
          agent: agent.publicKey,
          provider: alpha.publicKey,
          providerStats: statsPda(alpha.publicKey),
          order: orderPda(m4, 0),
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
    "MandateExpired",
  );

  const m5 = await create(5);
  await expectFail(
    () =>
      program.methods
        .purchase(0, bn(100_000), bn(100_000), 95)
        .accounts({
          mandate: m5,
          agent: agent.publicKey,
          provider: impostor.publicKey,
          providerStats: statsPda(impostor.publicKey),
          order: orderPda(m5, 0),
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc(),
    "ProviderNotRegistered",
  );
  await expectFail(
    () =>
      program.methods
        .closeMandate()
        .accounts({
          owner: agent.publicKey,
          mandate: m5,
          mint,
          ownerAta: ownerAta.address,
          vault: getAssociatedTokenAddressSync(mint, m5, true),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc(),
    "NotOwner",
  );

  const m6 = await create(6);
  await program.methods
    .purchase(0, bn(100_000), bn(100_000), 95)
    .accounts({
      mandate: m6,
      agent: agent.publicKey,
      provider: alpha.publicKey,
      providerStats: statsPda(alpha.publicKey),
      order: orderPda(m6, 0),
      systemProgram: SystemProgram.programId,
    })
    .signers([agent])
    .rpc();
  await program.methods
    .settle(61)
    .accounts({
      mandate: m6,
      verifier: verifier.publicKey,
      order: orderPda(m6, 0),
      providerStats: statsPda(alpha.publicKey),
      vault: getAssociatedTokenAddressSync(mint, m6, true),
      providerAta: getAssociatedTokenAddressSync(mint, alpha.publicKey),
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([verifier])
    .rpc();
  const order = await program.account.order.fetch(orderPda(m6, 0));
  assert.equal(Number(order.paid), 0);

  console.log("all localnet tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
