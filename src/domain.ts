import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const publicKeySchema = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
});

export const policySnapshotSchema = z.object({
  version: z.literal(1),
  cluster: z.literal("devnet"),
  genesisHash: publicKeySchema,
  sponsor: publicKeySchema,
  userId: z.string().min(1).max(128),
  ownerWallet: publicKeySchema,
  sourceTokenAccount: publicKeySchema,
  recipientOwner: publicKeySchema,
  recipientTokenAccount: publicKeySchema,
  mint: publicKeySchema,
  decimals: z.number().int().min(0).max(18),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  reference: publicKeySchema,
  createRecipientAta: z.boolean(),
  blockhash: publicKeySchema,
  lastValidBlockHeight: z.number().int().nonnegative(),
});

export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;

export interface PaymentIntent {
  id: string;
  userId: string;
  ownerWallet: string;
  sourceTokenAccount: string;
  recipientOwner: string;
  mint: string;
  decimals: number;
  amountMinor: bigint;
  reference: string;
  status: "active" | "cancelled" | "completed";
  expiresAt: Date;
  createdAt: Date;
}

export type SponsorshipStatus = "constructed" | "user_signed" | "validated" | "sponsor_signed" | "submitted" | "rejected" | "expired";

export interface SponsoredTransaction {
  id: string;
  paymentIntentId: string;
  attemptNumber: number;
  canonicalMessageHash: string;
  policySnapshot: PolicySnapshot;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  status: SponsorshipStatus;
  estimatedCostLamports: number;
  signedPayloadHash: string | null;
  signature: string | null;
  rejectionCode: string | null;
  submissionError: string | null;
  createdAt: Date;
  expiresAt: Date;
  submittedAt: Date | null;
}
