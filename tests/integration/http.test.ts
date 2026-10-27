import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../../src/http/app.js";
import { createPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { PaymentIntentService } from "../../src/service/intents.js";
import { SponsorshipService } from "../../src/service/sponsorship.js";
import { serializeTransaction } from "../../src/policy/construction.js";
import { DEVNET_GENESIS, DEVNET_USDC } from "../fixtures.js";
import { FakeChainGateway, FakeSponsorSigner } from "./fakes.js";

const databaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgresql://postgres:postgres@127.0.0.1:5435/sponsored_usdc_transfer_test";
const token = "integration-internal-token";
const headers = { authorization: `Bearer ${token}` };

let pool: Pool;
let app: FastifyInstance;
let chain: FakeChainGateway;
let signer: FakeSponsorSigner;
let user: Keypair;

beforeAll(async () => {
  await runMigrations(databaseUrl);
  pool = createPool({ connectionString: databaseUrl });
});

beforeEach(async () => {
  await pool.query(`truncate table payment_intents, sponsorship_users, sponsorship_usage,
    sponsorship_audit_events restart identity cascade`);
  chain = new FakeChainGateway();
  signer = new FakeSponsorSigner();
  user = Keypair.generate();
  const intents = new PaymentIntentService(pool, DEVNET_USDC, 6);
  const sponsorship = new SponsorshipService(pool, chain, signer, {
    enabled: true,
    maxCostLamports: 3_000_000,
    userDailyCostLimit: 10_000_000,
    globalDailyCostLimit: 50_000_000,
    userDailyCount: 5,
    maxConstructionsPerMinute: 10,
  }, "devnet", DEVNET_GENESIS);
  app = buildApp({
    config: {
      port: 3003,
      databaseUrl,
      apiAuthToken: token,
      sponsorSecretKey: "not-used-by-the-fake-signer",
      solanaRpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      expectedGenesisHash: DEVNET_GENESIS,
      usdcMint: DEVNET_USDC,
      usdcDecimals: 6,
      sponsorshipEnabled: true,
      maxCostLamports: 3_000_000,
      userDailyCostLimit: 10_000_000,
      globalDailyCostLimit: 50_000_000,
      userDailyCount: 5,
      maxConstructionsPerMinute: 10,
    },
    pool,
    intents,
    sponsorship,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

describe("sponsorship HTTP API", () => {
  it("exposes health and readiness but protects payment routes", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/payment-intents", payload: {} })).statusCode).toBe(401);
  });

  it("runs the intent, construction, user-signature, co-sign, and replay flow", async () => {
    const intentResponse = await app.inject({
      method: "POST",
      url: "/payment-intents",
      headers,
      payload: {
        userId: "http-user",
        ownerWallet: user.publicKey.toBase58(),
        recipientOwner: Keypair.generate().publicKey.toBase58(),
        amountMinor: "2500000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(intentResponse.statusCode).toBe(201);
    const intent = intentResponse.json<{ payment: { id: string; amountMinor: string } }>().payment;
    expect(intent.amountMinor).toBe("2500000");

    const constructedResponse = await app.inject({
      method: "POST",
      url: `/payments/${intent.id}/sponsored-transaction`,
      headers,
    });
    expect(constructedResponse.statusCode).toBe(201);
    const construction = constructedResponse.json<{ sponsorship: { id: string; transaction: string } }>().sponsorship;
    const transaction = Transaction.from(Buffer.from(construction.transaction, "base64"));
    transaction.partialSign(user);

    const submissionResponse = await app.inject({
      method: "POST",
      url: `/sponsored-transactions/${construction.id}/sign-and-submit`,
      headers,
      payload: { transaction: serializeTransaction(transaction).toString("base64") },
    });
    expect(submissionResponse.statusCode).toBe(200);
    const submission = submissionResponse.json<{ sponsorship: { signature: string; replayed: boolean } }>().sponsorship;
    expect(submission.replayed).toBe(false);

    const replayResponse = await app.inject({
      method: "POST",
      url: `/sponsored-transactions/${construction.id}/sign-and-submit`,
      headers,
      payload: { transaction: serializeTransaction(transaction).toString("base64") },
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json<{ sponsorship: { signature: string; replayed: boolean } }>().sponsorship)
      .toEqual({ ...submission, replayed: true });
    expect(chain.submissionCalls).toBe(1);

    const fetched = await app.inject({ method: "GET", url: `/sponsored-transactions/${construction.id}`, headers });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ sponsorship: { status: string } }>().sponsorship.status).toBe("submitted");
  });
});
