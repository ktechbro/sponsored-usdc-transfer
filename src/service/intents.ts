import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Pool } from "pg";
import type { PaymentIntent } from "../domain.js";
import { mapPaymentIntent, type PaymentIntentRow } from "../db/mappers.js";
import { withTransaction } from "../db/pool.js";
import { SponsorshipError } from "./errors.js";

export interface CreateIntentInput {
  userId: string;
  ownerWallet: string;
  recipientOwner: string;
  amountMinor: bigint;
  expiresAt: Date;
}

export class PaymentIntentService {
  constructor(private readonly pool: Pool, private readonly mint: string, private readonly decimals: number) {}

  async create(input: CreateIntentInput): Promise<PaymentIntent> {
    if (input.amountMinor <= 0n) throw new SponsorshipError("invalid_amount", "Amount must be positive");
    if (input.expiresAt <= new Date()) throw new SponsorshipError("invalid_expiry", "Payment expiry must be in the future");
    const owner = new PublicKey(input.ownerWallet);
    const source = getAssociatedTokenAddressSync(new PublicKey(this.mint), owner);

    return withTransaction(this.pool, async (client) => {
      await client.query("insert into sponsorship_users (user_id) values ($1) on conflict do nothing", [input.userId]);
      const result = await client.query<PaymentIntentRow>(
        `insert into payment_intents (
          user_id, owner_wallet, source_token_account, recipient_owner, mint, decimals,
          amount_minor, reference, status, expires_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9) returning *`,
        [input.userId, input.ownerWallet, source.toBase58(), input.recipientOwner, this.mint,
          this.decimals, input.amountMinor.toString(), Keypair.generate().publicKey.toBase58(), input.expiresAt],
      );
      return mapPaymentIntent(result.rows[0]!);
    });
  }

  async get(id: string): Promise<PaymentIntent | null> {
    const result = await this.pool.query<PaymentIntentRow>("select * from payment_intents where id = $1", [id]);
    return result.rows[0] ? mapPaymentIntent(result.rows[0]) : null;
  }
}
