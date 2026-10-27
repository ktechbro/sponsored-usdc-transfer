import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { PolicySnapshot } from "../domain.js";
import { SponsorshipError } from "../service/errors.js";

const MAX_U64 = 18_446_744_073_709_551_615n;

export function destinationTokenAccount(snapshot: PolicySnapshot): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(snapshot.mint), new PublicKey(snapshot.recipientOwner));
}

export function buildSponsoredTransaction(snapshot: PolicySnapshot): Transaction {
  const amountMinor = BigInt(snapshot.amountMinor);
  if (amountMinor <= 0n || amountMinor > MAX_U64) throw new SponsorshipError("invalid_amount", "Amount is outside the SPL u64 range");

  const sponsor = new PublicKey(snapshot.sponsor);
  const owner = new PublicKey(snapshot.ownerWallet);
  const recipient = new PublicKey(snapshot.recipientOwner);
  const source = new PublicKey(snapshot.sourceTokenAccount);
  const destination = destinationTokenAccount(snapshot);
  if (!destination.equals(new PublicKey(snapshot.recipientTokenAccount))) {
    throw new SponsorshipError("invalid_policy", "Recipient token account is not the derived associated token account");
  }
  if ([owner, recipient, source, destination].some((key) => key.equals(sponsor))) {
    throw new SponsorshipError("sponsor_token_involvement", "Sponsor cannot participate in token movement");
  }

  const transaction = new Transaction({
    feePayer: sponsor,
    blockhash: snapshot.blockhash,
    lastValidBlockHeight: snapshot.lastValidBlockHeight,
  });

  if (snapshot.createRecipientAta) {
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(
      sponsor,
      destination,
      recipient,
      new PublicKey(snapshot.mint),
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }

  const transfer = createTransferCheckedInstruction(
    source,
    new PublicKey(snapshot.mint),
    destination,
    owner,
    amountMinor,
    snapshot.decimals,
    [],
    TOKEN_PROGRAM_ID,
  );
  transfer.keys.push({ pubkey: new PublicKey(snapshot.reference), isSigner: false, isWritable: false });
  transaction.add(transfer);
  return transaction;
}

export function messageHash(transaction: Transaction): string {
  return createHash("sha256").update(transaction.serializeMessage()).digest("hex");
}

export function serializeTransaction(transaction: Transaction): Buffer {
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
}
