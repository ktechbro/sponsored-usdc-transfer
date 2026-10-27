import { createHash } from "node:crypto";
import { ACCOUNT_SIZE, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Pool, PoolClient } from "pg";
import type { ChainGateway } from "../chain/gateway.js";
import type { SponsorSigner } from "../chain/signer.js";
import type { PaymentIntent, PolicySnapshot, SponsoredTransaction } from "../domain.js";
import {
  mapPaymentIntent,
  mapSponsoredTransaction,
  type PaymentIntentRow,
  type SponsoredTransactionRow,
} from "../db/mappers.js";
import { withTransaction } from "../db/pool.js";
import { buildSponsoredTransaction, messageHash, serializeTransaction } from "../policy/construction.js";
import { validateSponsoredTransaction } from "../policy/validator.js";
import { reserveSponsorship, type SponsorshipLimits } from "./budget.js";
import { SponsorshipError } from "./errors.js";

const sponsoredColumns = "select * from sponsored_transactions";

export interface ConstructionResult {
  id: string;
  status: string;
  transaction: string;
  canonicalMessageHash: string;
  estimatedCostLamports: number;
  expiresAt: Date;
}

export interface SubmissionResult {
  id: string;
  status: string;
  signature: string;
  ambiguous: boolean;
  replayed: boolean;
}

export class SponsorshipService {
  constructor(
    private readonly pool: Pool,
    private readonly chain: ChainGateway,
    private readonly signer: SponsorSigner,
    private readonly limits: SponsorshipLimits,
    private readonly cluster: "devnet",
    private readonly expectedGenesisHash: string,
  ) {}

  async get(id: string): Promise<SponsoredTransaction | null> {
    const result = await this.pool.query<SponsoredTransactionRow>(`${sponsoredColumns} where id = $1`, [id]);
    return result.rows[0] ? mapSponsoredTransaction(result.rows[0]) : null;
  }

  async construct(paymentIntentId: string): Promise<ConstructionResult> {
    const intent = await this.intent(this.pool, paymentIntentId);
    this.assertIntentEligible(intent);
    const reusable = await this.reusableTransaction(this.pool, paymentIntentId);
    if (reusable) return this.constructionResult(reusable);
    await this.assertNetwork();

    const recipientTokenAccount = getAssociatedTokenAddressSync(
      new PublicKey(intent.mint),
      new PublicKey(intent.recipientOwner),
    );
    const createRecipientAta = !(await this.chain.accountExists(recipientTokenAccount));
    const latestBlockhash = await this.chain.getLatestBlockhash();
    const snapshot: PolicySnapshot = {
      version: 1,
      cluster: this.cluster,
      genesisHash: this.expectedGenesisHash,
      sponsor: this.signer.publicKey.toBase58(),
      userId: intent.userId,
      ownerWallet: intent.ownerWallet,
      sourceTokenAccount: intent.sourceTokenAccount,
      recipientOwner: intent.recipientOwner,
      recipientTokenAccount: recipientTokenAccount.toBase58(),
      mint: intent.mint,
      decimals: intent.decimals,
      amountMinor: intent.amountMinor.toString(),
      reference: intent.reference,
      createRecipientAta,
      ...latestBlockhash,
    };
    const transaction = buildSponsoredTransaction(snapshot);
    const feeLamports = await this.chain.getFeeLamports(transaction);
    const rentLamports = createRecipientAta ? await this.chain.getRentExemptionLamports(ACCOUNT_SIZE) : 0;
    const estimatedCostLamports = feeLamports + rentLamports;
    if (estimatedCostLamports > this.limits.maxCostLamports) {
      throw new SponsorshipError("cost_limit_exceeded", "Estimated sponsor cost exceeds the per-transaction limit", 429);
    }
    const canonicalMessageHash = messageHash(transaction);
    const expiresAt = new Date(Math.min(intent.expiresAt.getTime(), Date.now() + 5 * 60 * 1000));

    const sponsored = await withTransaction(this.pool, async (client) => {
      const lockedIntent = await this.intent(client, paymentIntentId, true);
      this.assertIntentEligible(lockedIntent);
      const concurrent = await this.reusableTransaction(client, paymentIntentId);
      if (concurrent) return concurrent;

      const rate = await client.query<{ count: string }>(
        `select count(*)::text as count from sponsored_transactions s
         join payment_intents p on p.id = s.payment_intent_id
         where p.user_id = $1 and s.created_at > now() - interval '1 minute'`,
        [lockedIntent.userId],
      );
      if (Number(rate.rows[0]!.count) >= this.limits.maxConstructionsPerMinute) {
        throw new SponsorshipError("rate_limited", "Too many sponsored transaction constructions", 429);
      }

      const attempt = await client.query<{ attempt_number: number }>(
        "select coalesce(max(attempt_number), 0) + 1 as attempt_number from sponsored_transactions where payment_intent_id = $1",
        [paymentIntentId],
      );
      const inserted = await client.query<SponsoredTransactionRow>(
        `insert into sponsored_transactions (
          payment_intent_id, attempt_number, canonical_message_hash, policy_snapshot,
          recent_blockhash, last_valid_block_height, status, estimated_cost_lamports, expires_at
        ) values ($1, $2, $3, $4, $5, $6, 'constructed', $7, $8) returning *`,
        [paymentIntentId, attempt.rows[0]!.attempt_number, canonicalMessageHash, JSON.stringify(snapshot),
          snapshot.blockhash, snapshot.lastValidBlockHeight, estimatedCostLamports, expiresAt],
      );
      const record = mapSponsoredTransaction(inserted.rows[0]!);
      await this.audit(client, record.id, record.policySnapshot.userId, "constructed", null, {
        attemptNumber: record.attemptNumber,
        estimatedCostLamports,
      });
      return record;
    });

    return this.constructionResult(sponsored);
  }

  async signAndSubmit(id: string, signedPayload: Uint8Array): Promise<SubmissionResult> {
    const signedPayloadHash = createHash("sha256").update(signedPayload).digest("hex");
    const initial = await this.required(id);
    if (initial.status === "submitted" || initial.status === "sponsor_signed") {
      if (initial.signedPayloadHash !== signedPayloadHash) {
        throw new SponsorshipError("idempotency_mismatch", "A different payload was already submitted", 409);
      }
      return this.submissionResult(initial, true);
    }
    if (initial.status === "rejected") {
      throw new SponsorshipError(initial.rejectionCode ?? "rejected", "Sponsored transaction was rejected");
    }
    if (initial.status === "expired" || initial.expiresAt <= new Date()) {
      throw new SponsorshipError("transaction_expired", "Sponsored transaction has expired");
    }

    await this.assertNetwork();
    const currentBlockHeight = await this.chain.getBlockHeight();
    const validation = validateSponsoredTransaction(signedPayload, initial.policySnapshot, {
      canonicalMessageHash: initial.canonicalMessageHash,
      currentBlockHeight,
      now: new Date(),
      expiresAt: initial.expiresAt,
    });
    if (!validation.ok) {
      await this.reject(initial, validation.code);
      throw new SponsorshipError(validation.code, "Transaction does not match the authorized payment policy");
    }

    try {
      await this.chain.simulate(validation.transaction);
    } catch {
      await this.reject(initial, "simulation_failed");
      throw new SponsorshipError("simulation_failed", "Transaction simulation failed; sponsor did not sign", 422);
    }

    let prepared: { record: SponsoredTransaction; transaction: Transaction | null };
    try {
      prepared = await withTransaction(this.pool, async (client) => {
        const locked = await this.required(id, client, true);
        if (locked.signedPayloadHash && locked.signedPayloadHash !== signedPayloadHash) {
          throw new SponsorshipError("idempotency_mismatch", "A different payload was already submitted", 409);
        }
        if (locked.status === "submitted" || locked.status === "sponsor_signed") {
          return { record: locked, transaction: null };
        }
        if (locked.status !== "constructed" || locked.expiresAt <= new Date()) {
          throw new SponsorshipError("transaction_not_signable", "Sponsored transaction is not eligible for signing", 409);
        }

        await reserveSponsorship(client, {
          sponsoredTransactionId: locked.id,
          userId: locked.policySnapshot.userId,
          costLamports: locked.estimatedCostLamports,
        }, this.limits);

        const sponsorSignature = await this.signer.sign(validation.message);
        if (sponsorSignature.length !== 64) throw new Error("Sponsor signer returned an invalid signature");
        validation.transaction.addSignature(this.signer.publicKey, Buffer.from(sponsorSignature));
        const signature = bs58.encode(sponsorSignature);
        validation.transaction.serialize();

        const updated = await client.query<SponsoredTransactionRow>(
          `update sponsored_transactions set
            status = 'sponsor_signed', signed_payload_hash = $2, signature = $3,
            submitted_at = null, submission_error = 'Submission outcome unknown; awaiting RPC acknowledgement'
          where id = $1 returning *`,
          [locked.id, signedPayloadHash, signature],
        );
        const record = mapSponsoredTransaction(updated.rows[0]!);
        await this.audit(client, id, locked.policySnapshot.userId, "submission_recorded", null, {
          estimatedCostLamports: locked.estimatedCostLamports,
        });
        return { record, transaction: validation.transaction };
      });
    } catch (error) {
      if (error instanceof SponsorshipError) {
        await this.audit(this.pool, id, initial.policySnapshot.userId, "signing_rejected", error.code, {});
      }
      throw error;
    }

    if (!prepared.transaction) return this.submissionResult(prepared.record, true);
    try {
      await this.chain.submit(prepared.transaction, prepared.record.signature!);
      await this.pool.query(
        `update sponsored_transactions set status = 'submitted', submission_error = null, submitted_at = now()
         where id = $1 and status = 'sponsor_signed'`,
        [id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown submission error";
      await this.pool.query(
        "update sponsored_transactions set submission_error = $2 where id = $1 and status = 'sponsor_signed'",
        [id, message.slice(0, 500)],
      );
    }
    const current = await this.required(id);
    return this.submissionResult(current, false);
  }

  private async intent(executor: Pool | PoolClient, id: string, lock = false): Promise<PaymentIntent> {
    const result = await executor.query<PaymentIntentRow>(
      `select * from payment_intents where id = $1 ${lock ? "for update" : ""}`,
      [id],
    );
    if (!result.rows[0]) throw new SponsorshipError("payment_not_found", "Payment intent not found", 404);
    return mapPaymentIntent(result.rows[0]);
  }

  private async required(id: string, executor: Pool | PoolClient = this.pool, lock = false): Promise<SponsoredTransaction> {
    const result = await executor.query<SponsoredTransactionRow>(
      `${sponsoredColumns} where id = $1 ${lock ? "for update" : ""}`,
      [id],
    );
    if (!result.rows[0]) throw new SponsorshipError("sponsorship_not_found", "Sponsored transaction not found", 404);
    return mapSponsoredTransaction(result.rows[0]);
  }

  private async reusableTransaction(executor: Pool | PoolClient, paymentIntentId: string): Promise<SponsoredTransaction | null> {
    const result = await executor.query<SponsoredTransactionRow>(
      `${sponsoredColumns} where payment_intent_id = $1
       and status not in ('rejected', 'expired') and expires_at > now()
       order by attempt_number desc limit 1`,
      [paymentIntentId],
    );
    return result.rows[0] ? mapSponsoredTransaction(result.rows[0]) : null;
  }

  private assertIntentEligible(intent: PaymentIntent): void {
    if (intent.status !== "active") throw new SponsorshipError("payment_not_active", "Payment intent is not active", 409);
    if (intent.expiresAt <= new Date()) throw new SponsorshipError("payment_expired", "Payment intent has expired");
  }

  private async assertNetwork(): Promise<void> {
    if (await this.chain.getGenesisHash() !== this.expectedGenesisHash) {
      throw new SponsorshipError("wrong_network", "Connected Solana network does not match policy", 503);
    }
  }

  private constructionResult(record: SponsoredTransaction): ConstructionResult {
    const transaction = buildSponsoredTransaction(record.policySnapshot);
    return {
      id: record.id,
      status: record.status,
      transaction: serializeTransaction(transaction).toString("base64"),
      canonicalMessageHash: record.canonicalMessageHash,
      estimatedCostLamports: record.estimatedCostLamports,
      expiresAt: record.expiresAt,
    };
  }

  private submissionResult(record: SponsoredTransaction, replayed: boolean): SubmissionResult {
    if (!record.signature) throw new Error("Submitted sponsorship has no signature");
    return {
      id: record.id,
      status: record.status,
      signature: record.signature,
      ambiguous: record.status !== "submitted" || record.submissionError !== null,
      replayed,
    };
  }

  private async reject(record: SponsoredTransaction, code: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        "update sponsored_transactions set status = 'rejected', rejection_code = $2 where id = $1 and status <> 'submitted'",
        [record.id, code],
      );
      await this.audit(client, record.id, record.policySnapshot.userId, "policy_rejected", code, {});
    });
  }

  private async audit(
    executor: Pool | PoolClient,
    sponsoredTransactionId: string,
    userId: string,
    eventType: string,
    code: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await executor.query(
      `insert into sponsorship_audit_events (sponsored_transaction_id, user_id, event_type, code, metadata)
       values ($1, $2, $3, $4, $5)`,
      [sponsoredTransactionId, userId, eventType, code, JSON.stringify(metadata)],
    );
  }
}
