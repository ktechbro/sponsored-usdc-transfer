import { policySnapshotSchema, type PaymentIntent, type SponsoredTransaction, type SponsorshipStatus } from "../domain.js";

export interface PaymentIntentRow {
  id: string;
  user_id: string;
  owner_wallet: string;
  source_token_account: string;
  recipient_owner: string;
  mint: string;
  decimals: number;
  amount_minor: string;
  reference: string;
  status: PaymentIntent["status"];
  expires_at: Date;
  created_at: Date;
}

export interface SponsoredTransactionRow {
  id: string;
  payment_intent_id: string;
  attempt_number: number;
  canonical_message_hash: string;
  policy_snapshot: unknown;
  recent_blockhash: string;
  last_valid_block_height: string;
  status: SponsorshipStatus;
  estimated_cost_lamports: string;
  signed_payload_hash: string | null;
  signature: string | null;
  rejection_code: string | null;
  submission_error: string | null;
  created_at: Date;
  expires_at: Date;
  submitted_at: Date | null;
}

export function mapPaymentIntent(row: PaymentIntentRow): PaymentIntent {
  return {
    id: row.id,
    userId: row.user_id,
    ownerWallet: row.owner_wallet,
    sourceTokenAccount: row.source_token_account,
    recipientOwner: row.recipient_owner,
    mint: row.mint,
    decimals: row.decimals,
    amountMinor: BigInt(row.amount_minor),
    reference: row.reference,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function mapSponsoredTransaction(row: SponsoredTransactionRow): SponsoredTransaction {
  return {
    id: row.id,
    paymentIntentId: row.payment_intent_id,
    attemptNumber: row.attempt_number,
    canonicalMessageHash: row.canonical_message_hash,
    policySnapshot: policySnapshotSchema.parse(row.policy_snapshot),
    recentBlockhash: row.recent_blockhash,
    lastValidBlockHeight: Number(row.last_valid_block_height),
    status: row.status,
    estimatedCostLamports: Number(row.estimated_cost_lamports),
    signedPayloadHash: row.signed_payload_hash,
    signature: row.signature,
    rejectionCode: row.rejection_code,
    submissionError: row.submission_error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
  };
}
