import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { DEVNET_GENESIS_HASH } from "../src/config.js";
import type { PolicySnapshot } from "../src/domain.js";
import { buildSponsoredTransaction, messageHash, serializeTransaction } from "../src/policy/construction.js";
import type { ValidationContext } from "../src/policy/validator.js";

export const DEVNET_GENESIS = DEVNET_GENESIS_HASH;
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface PolicyFixture {
  user: Keypair;
  sponsor: Keypair;
  recipient: Keypair;
  snapshot: PolicySnapshot;
  context: ValidationContext;
}

export function policyFixture(createRecipientAta = false): PolicyFixture {
  const user = Keypair.generate();
  const sponsor = Keypair.generate();
  const recipient = Keypair.generate();
  const mint = new PublicKey(DEVNET_USDC);
  const snapshot: PolicySnapshot = {
    version: 1,
    cluster: "devnet",
    genesisHash: DEVNET_GENESIS,
    sponsor: sponsor.publicKey.toBase58(),
    userId: "user-1",
    ownerWallet: user.publicKey.toBase58(),
    sourceTokenAccount: getAssociatedTokenAddressSync(mint, user.publicKey).toBase58(),
    recipientOwner: recipient.publicKey.toBase58(),
    recipientTokenAccount: getAssociatedTokenAddressSync(mint, recipient.publicKey).toBase58(),
    mint: mint.toBase58(),
    decimals: 6,
    amountMinor: "1000000",
    reference: Keypair.generate().publicKey.toBase58(),
    createRecipientAta,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  };
  return {
    user,
    sponsor,
    recipient,
    snapshot,
    context: {
      canonicalMessageHash: messageHash(buildSponsoredTransaction(snapshot)),
      currentBlockHeight: 99,
      now: new Date("2026-10-27T12:00:00.000Z"),
      expiresAt: new Date("2026-10-27T12:05:00.000Z"),
    },
  };
}

export function signPayload(fixture: PolicyFixture, transaction = buildSponsoredTransaction(fixture.snapshot)): Uint8Array {
  transaction.partialSign(fixture.user);
  return serializeTransaction(transaction);
}

export function transferInstruction(transaction: Transaction) {
  return transaction.instructions.at(-1)!;
}
