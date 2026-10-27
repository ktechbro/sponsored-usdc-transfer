import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { z, ZodError } from "zod";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type { PaymentIntentService } from "../service/intents.js";
import type { SponsorshipService } from "../service/sponsorship.js";
import { SponsorshipError } from "../service/errors.js";

const publicKeySchema = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid Solana public key");

const intentSchema = z.object({
  userId: z.string().min(1).max(128),
  ownerWallet: publicKeySchema,
  recipientOwner: publicKeySchema,
  amountMinor: z.string().regex(/^[1-9]\d*$/).transform(BigInt),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
});

const transactionSchema = z.object({
  transaction: z.string().min(1).max(2048).refine((value) => {
    try {
      return Buffer.from(value, "base64").toString("base64") === value;
    } catch {
      return false;
    }
  }, "Transaction must be canonical base64").transform((value) => Buffer.from(value, "base64")),
});

function validBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export interface BuildAppOptions {
  config: AppConfig;
  pool: Pool;
  intents: PaymentIntentService;
  sponsorship: SponsorshipService;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onRequest", async (request, reply) => {
    reply.serializer((payload) => JSON.stringify(payload, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    if (["/health", "/ready"].includes(request.url)) return;
    if (!validBearerToken(request.headers.authorization, options.config.apiAuthToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "invalid_request", issues: error.issues });
    if (error instanceof SponsorshipError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return reply.code(409).send({ error: "duplicate_resource" });
    }
    if (typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "bad_request" });
    }
    options.logger && app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ status: "ok", service: "sponsored-usdc-transfer", cluster: options.config.cluster }));
  app.get("/ready", async (_request, reply) => {
    try {
      await options.pool.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post("/payment-intents", async (request, reply) => {
    const input = intentSchema.parse(request.body);
    const payment = await options.intents.create(input);
    return reply.code(201).send({ payment });
  });

  app.post("/payments/:id/sponsored-transaction", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await options.sponsorship.construct(id);
    return reply.code(201).send({ sponsorship: result });
  });

  app.post("/sponsored-transactions/:id/sign-and-submit", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { transaction } = transactionSchema.parse(request.body);
    const result = await options.sponsorship.signAndSubmit(id, transaction);
    return reply.code(result.ambiguous ? 202 : 200).send({ sponsorship: result });
  });

  app.get("/sponsored-transactions/:id", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const sponsored = await options.sponsorship.get(id);
    if (!sponsored) throw new SponsorshipError("sponsorship_not_found", "Sponsored transaction not found", 404);
    return { sponsorship: sponsored };
  });

  return app;
}
