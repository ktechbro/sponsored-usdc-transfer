import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import type { Pool } from "pg";
import { createPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { PaymentIntentService } from "../../src/service/intents.js";
import { SponsorshipService, type ConstructionResult, type SubmissionResult } from "../../src/service/sponsorship.js";
import type { SponsorshipLimits } from "../../src/service/budget.js";
import { serializeTransaction } from "../../src/policy/construction.js";
import { DEVNET_GENESIS, DEVNET_USDC } from "../fixtures.js";
import { FakeChainGateway, FakeSponsorSigner } from "./fakes.js";

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgresql://postgres:postgres@127.0.0.1:5435/sponsored_usdc_transfer_test";

const defaultLimits: SponsorshipLimits = {
  enabled: true,
  maxCostLamports: 3_000_000,
  userDailyCostLimit: 10_000_000,
  globalDailyCostLimit: 50_000_000,
  userDailyCount: 5,
  maxConstructionsPerMinute: 10,
};

let pool: Pool;
let chain: FakeChainGateway;
let signer: FakeSponsorSigner;
let intents: PaymentIntentService;
let service: SponsorshipService;
let user: Keypair;
let recipient: Keypair;

function createService(limits = defaultLimits) {
  return new SponsorshipService(pool, chain, signer, limits, "devnet", DEVNET_GENESIS);
}

async function createIntent(userId = "user-1") {
  return intents.create({
    userId,
    ownerWallet: user.publicKey.toBase58(),
    recipientOwner: recipient.publicKey.toBase58(),
    amountMinor: 1_000_000n,
    expiresAt: new Date(Date.now() + 60_000),
  });
}

function userSign(construction: ConstructionResult): Buffer {
  const transaction = Transaction.from(Buffer.from(construction.transaction, "base64"));
  transaction.partialSign(user);
  return serializeTransaction(transaction);
}

beforeAll(async () => {
  await runMigrations(databaseUrl);
  pool = createPool({ connectionString: databaseUrl });
});

beforeEach(async () => {
  await pool.query(`truncate table payment_intents, sponsorship_users, sponsorship_usage,
    sponsorship_audit_events restart identity cascade`);
  chain = new FakeChainGateway();
  signer = new FakeSponsorSigner();
  intents = new PaymentIntentService(pool, DEVNET_USDC, 6);
  service = createService();
  user = Keypair.generate();
  recipient = Keypair.generate();
});

afterAll(async () => {
  await pool.end();
});

describe("sponsored USDC transfer integration", () => {
  it("validates, co-signs, submits, and replays without duplicate submission or usage", async () => {
    const intent = await createIntent();
    const construction = await service.construct(intent.id);
    expect((await service.construct(intent.id)).id).toBe(construction.id);
    const payload = userSign(construction);

    const first = await service.signAndSubmit(construction.id, payload);
    expect(first).toMatchObject({ status: "submitted", ambiguous: false, replayed: false });
    expect(signer.calls).toBe(1);
    expect(chain.simulationCalls).toBe(1);
    expect(chain.submissionCalls).toBe(1);

    const replay = await service.signAndSubmit(construction.id, payload);
    expect(replay).toMatchObject({ signature: first.signature, replayed: true });
    expect(chain.submissionCalls).toBe(1);
    const usage = await pool.query("select count(*)::int as count from sponsorship_usage");
    expect(usage.rows[0]?.count).toBe(1);

    const submitted = Transaction.from(Buffer.from(construction.transaction, "base64"));
    expect(submitted.feePayer?.toBase58()).toBe(signer.publicKey.toBase58());
    await expect(service.signAndSubmit(construction.id, Buffer.from(construction.transaction, "base64")))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("does not reuse a construction after the intent expires", async () => {
    const intent = await createIntent();
    await service.construct(intent.id);
    await pool.query("update payment_intents set expires_at = now() - interval '1 second' where id = $1", [intent.id]);

    await expect(service.construct(intent.id)).rejects.toMatchObject({ code: "payment_expired" });
  });

  it("does not reuse a construction after the intent is cancelled", async () => {
    const intent = await createIntent();
    await service.construct(intent.id);
    await pool.query("update payment_intents set status = 'cancelled' where id = $1", [intent.id]);

    await expect(service.construct(intent.id)).rejects.toMatchObject({ code: "payment_not_active" });
  });

  it("rejects an invalid user signature before sponsor signing", async () => {
    const intent = await createIntent();
    const construction = await service.construct(intent.id);
    const transaction = Transaction.from(userSign(construction));
    const userSignature = transaction.signatures.find((entry) => entry.publicKey.equals(user.publicKey))!;
    userSignature.signature![0] = userSignature.signature![0]! ^ 1;

    await expect(service.signAndSubmit(construction.id, serializeTransaction(transaction)))
      .rejects.toMatchObject({ code: "user_signature_invalid" });
    expect(signer.calls).toBe(0);
    expect(chain.submissionCalls).toBe(0);
    expect((await service.get(construction.id))?.status).toBe("rejected");
  });

  it("does not co-sign when simulation fails", async () => {
    const intent = await createIntent();
    const construction = await service.construct(intent.id);
    chain.failSimulation = true;

    await expect(service.signAndSubmit(construction.id, userSign(construction)))
      .rejects.toMatchObject({ code: "simulation_failed" });
    expect(signer.calls).toBe(0);
    expect(chain.submissionCalls).toBe(0);
    const usage = await pool.query("select count(*)::int as count from sponsorship_usage");
    expect(usage.rows[0]?.count).toBe(0);
  });

  it("serializes concurrent budget reservations", async () => {
    const totalCost = chain.feeLamports + chain.rentExemptionLamports;
    service = createService({ ...defaultLimits, globalDailyCostLimit: totalCost, userDailyCount: 10 });
    const first = await service.construct((await createIntent()).id);
    const second = await service.construct((await createIntent()).id);
    const results = await Promise.allSettled([
      service.signAndSubmit(first.id, userSign(first)),
      service.signAndSubmit(second.id, userSign(second)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "budget_exceeded" } });
    expect(signer.calls).toBe(1);
    expect(chain.submissionCalls).toBe(1);
    const usage = await pool.query("select count(*)::int as count, sum(cost_lamports)::int as costs from sponsorship_usage");
    expect(usage.rows[0]).toEqual({ count: 1, costs: totalCost });
  });

  it("includes fresh recipient ATA rent in the global sponsor budget", async () => {
    const totalCost = chain.feeLamports + chain.rentExemptionLamports;
    service = createService({
      ...defaultLimits,
      userDailyCostLimit: totalCost * 2,
      globalDailyCostLimit: totalCost,
      userDailyCount: 10,
    });
    const first = await service.construct((await createIntent()).id);
    expect(first.estimatedCostLamports).toBe(totalCost);
    await service.signAndSubmit(first.id, userSign(first));

    recipient = Keypair.generate();
    const second = await service.construct((await createIntent()).id);
    expect(second.estimatedCostLamports).toBe(totalCost);
    await expect(service.signAndSubmit(second.id, userSign(second)))
      .rejects.toMatchObject({ code: "budget_exceeded" });

    expect(signer.calls).toBe(1);
    expect(chain.submissionCalls).toBe(1);
    const usage = await pool.query("select cost_lamports::int as cost from sponsorship_usage");
    expect(usage.rows).toEqual([{ cost: totalCost }]);
  });

  it("preserves an ambiguous RPC submission for watcher recovery", async () => {
    const intent = await createIntent();
    const construction = await service.construct(intent.id);
    const payload = userSign(construction);
    chain.failSubmission = true;

    const first = await service.signAndSubmit(construction.id, payload);
    expect(first).toMatchObject({ status: "sponsor_signed", ambiguous: true, replayed: false });
    const replay = await service.signAndSubmit(construction.id, payload);
    expect(replay).toMatchObject({ signature: first.signature, ambiguous: true, replayed: true });
    expect(chain.submissionCalls).toBe(1);
    expect((await service.get(construction.id))?.submissionError).toBe("RPC timeout");
  });

  it("returns pre-RPC recovery replays as ambiguous without duplicate submission", async () => {
    const construction = await service.construct((await createIntent()).id);
    const payload = userSign(construction);
    let recovered: SubmissionResult | undefined;
    chain.beforeSubmission = async () => {
      recovered = await createService().signAndSubmit(construction.id, payload);
    };

    const first = await service.signAndSubmit(construction.id, payload);

    expect(recovered).toMatchObject({ status: "sponsor_signed", ambiguous: true, replayed: true });
    expect(first).toMatchObject({ status: "submitted", ambiguous: false, replayed: false });
    expect(chain.submissionCalls).toBe(1);
    expect(signer.calls).toBe(1);
  });

  it("constructs and validates recipient ATA creation", async () => {
    const intent = await createIntent();
    const construction = await service.construct(intent.id);
    const unsigned = Transaction.from(Buffer.from(construction.transaction, "base64"));
    expect(unsigned.instructions).toHaveLength(2);

    const result = await service.signAndSubmit(construction.id, userSign(construction));
    expect(result.ambiguous).toBe(false);
    expect(signer.calls).toBe(1);
  });

  it("rejects altered ATA creation before sponsor signing", async () => {
    const intent = await createIntent();
    const construction = await service.construct(intent.id);
    const transaction = Transaction.from(userSign(construction));
    transaction.instructions[0]!.keys[2]!.pubkey = Keypair.generate().publicKey;
    transaction.signatures = [];

    await expect(service.signAndSubmit(construction.id, serializeTransaction(transaction))).rejects.toThrow();
    expect(signer.calls).toBe(0);
    expect(chain.submissionCalls).toBe(0);
  });

  it("enforces construction rate limits", async () => {
    service = createService({ ...defaultLimits, maxConstructionsPerMinute: 1 });
    await service.construct((await createIntent()).id);
    await expect(service.construct((await createIntent()).id)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("keeps sponsorship usage immutable", async () => {
    const construction = await service.construct((await createIntent()).id);
    await service.signAndSubmit(construction.id, userSign(construction));
    await expect(pool.query("update sponsorship_usage set cost_lamports = cost_lamports"))
      .rejects.toThrow("Sponsorship usage is immutable");
  });
});
