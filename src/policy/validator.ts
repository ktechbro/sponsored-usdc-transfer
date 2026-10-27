import { createHash, timingSafeEqual } from "node:crypto";
import { decodeTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { PolicySnapshot } from "../domain.js";
import { buildSponsoredTransaction } from "./construction.js";

export interface ValidationContext {
  canonicalMessageHash: string;
  currentBlockHeight: number;
  now: Date;
  expiresAt: Date;
}

export type ValidationResult =
  | { ok: true; transaction: Transaction; message: Buffer; messageHash: string }
  | { ok: false; code: string };

function rejected(code: string): ValidationResult {
  return { ok: false, code };
}

function sameInstruction(actual: TransactionInstruction, expected: TransactionInstruction): boolean {
  return actual.programId.equals(expected.programId)
    && actual.data.equals(expected.data)
    && actual.keys.length === expected.keys.length
    && actual.keys.every((key, index) => {
      const other = expected.keys[index];
      return other !== undefined && key.pubkey.equals(other.pubkey)
        && key.isSigner === other.isSigner && key.isWritable === other.isWritable;
    });
}

function hasSignature(signature: Buffer | null): signature is Buffer {
  return signature !== null && signature.some((byte) => byte !== 0);
}

export function validateSponsoredTransaction(
  serialized: Uint8Array,
  snapshot: PolicySnapshot,
  context: ValidationContext,
): ValidationResult {
  if (context.now >= context.expiresAt || context.currentBlockHeight > snapshot.lastValidBlockHeight) {
    return rejected("transaction_expired");
  }

  let actual: Transaction;
  let expected: Transaction;
  try {
    actual = Transaction.from(serialized);
    expected = buildSponsoredTransaction(snapshot);
  } catch {
    return rejected("invalid_transaction");
  }

  if (actual.recentBlockhash !== snapshot.blockhash) return rejected("blockhash_mismatch");
  if (!actual.signatures[0]?.publicKey.equals(new PublicKey(snapshot.sponsor))) return rejected("fee_payer_mismatch");

  const expectedMessage = expected.compileMessage();
  const expectedSigners = expectedMessage.accountKeys.filter((_key, index) => expectedMessage.isAccountSigner(index));
  if (actual.signatures.length !== expectedSigners.length
    || !actual.signatures.every((entry, index) => entry.publicKey.equals(expectedSigners[index]!))) {
    return rejected("signer_mismatch");
  }

  const expectedInstructions = expected.instructions;
  if (actual.instructions.length !== expectedInstructions.length) return rejected("instruction_count_mismatch");

  const transferIndex = actual.instructions.length - 1;
  const actualTransfer = actual.instructions[transferIndex]!;
  if (!actualTransfer.programId.equals(TOKEN_PROGRAM_ID)) return rejected("unexpected_program");
  if (actualTransfer.keys.some((key) => key.pubkey.equals(new PublicKey(snapshot.sponsor)))) {
    return rejected("sponsor_token_involvement");
  }

  try {
    const decoded = decodeTransferCheckedInstruction(actualTransfer);
    if (!decoded.keys.source.pubkey.equals(new PublicKey(snapshot.sourceTokenAccount))
      || !decoded.keys.destination.pubkey.equals(new PublicKey(snapshot.recipientTokenAccount))
      || !decoded.keys.mint.pubkey.equals(new PublicKey(snapshot.mint))
      || !decoded.keys.owner.pubkey.equals(new PublicKey(snapshot.ownerWallet))
      || decoded.data.amount !== BigInt(snapshot.amountMinor)
      || decoded.data.decimals !== snapshot.decimals) {
      return rejected("transfer_mismatch");
    }
    if (decoded.keys.multiSigners.length !== 1) return rejected("reference_mismatch");
    const reference = decoded.keys.multiSigners[0]!;
    if (!reference.pubkey.equals(new PublicKey(snapshot.reference)) || reference.isSigner || reference.isWritable) {
      return rejected("reference_mismatch");
    }
  } catch {
    return rejected("invalid_transfer");
  }

  if (!actual.instructions.every((instruction, index) => sameInstruction(instruction, expectedInstructions[index]!))) {
    return rejected("instruction_mismatch");
  }

  let message: Buffer;
  let actualHash: string;
  try {
    message = actual.serializeMessage();
    actualHash = createHash("sha256").update(message).digest("hex");
  } catch {
    return rejected("unsupported_message");
  }
  const expectedHash = createHash("sha256").update(expected.serializeMessage()).digest("hex");
  if (actualHash !== expectedHash) return rejected("message_hash_mismatch");
  const suppliedHash = Buffer.from(context.canonicalMessageHash, "hex");
  const digest = Buffer.from(actualHash, "hex");
  if (suppliedHash.length !== digest.length || !timingSafeEqual(suppliedHash, digest)) {
    return rejected("message_hash_mismatch");
  }

  const userEntry = actual.signatures.find((entry) => entry.publicKey.equals(new PublicKey(snapshot.ownerWallet)));
  const sponsorEntry = actual.signatures.find((entry) => entry.publicKey.equals(new PublicKey(snapshot.sponsor)));
  if (!userEntry || !hasSignature(userEntry.signature)) return rejected("user_signature_missing");
  if (sponsorEntry && hasSignature(sponsorEntry.signature)) return rejected("sponsor_signature_present");
  if (!nacl.sign.detached.verify(message, userEntry.signature, new PublicKey(snapshot.ownerWallet).toBytes())) {
    return rejected("user_signature_invalid");
  }

  return { ok: true, transaction: actual, message, messageHash: actualHash };
}
