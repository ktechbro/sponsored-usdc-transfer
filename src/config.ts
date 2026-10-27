import { z } from "zod";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5435/sponsored_usdc_transfer"),
  API_AUTH_TOKEN: z.string().min(16),
  SPONSOR_SECRET_KEY: z.string().min(1),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  SOLANA_CLUSTER: z.literal("devnet").default("devnet"),
  USDC_MINT: z.string().min(32).default("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  USDC_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  SPONSORSHIP_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  MAX_COST_LAMPORTS: z.coerce.number().int().positive().default(3_000_000),
  USER_DAILY_COST_LIMIT: z.coerce.number().int().positive().default(10_000_000),
  GLOBAL_DAILY_COST_LIMIT: z.coerce.number().int().positive().default(50_000_000),
  USER_DAILY_COUNT: z.coerce.number().int().positive().default(5),
  MAX_CONSTRUCTIONS_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  return {
    port: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    apiAuthToken: parsed.API_AUTH_TOKEN,
    sponsorSecretKey: parsed.SPONSOR_SECRET_KEY,
    solanaRpcUrl: parsed.SOLANA_RPC_URL,
    cluster: parsed.SOLANA_CLUSTER,
    expectedGenesisHash: DEVNET_GENESIS_HASH,
    usdcMint: parsed.USDC_MINT,
    usdcDecimals: parsed.USDC_DECIMALS,
    sponsorshipEnabled: parsed.SPONSORSHIP_ENABLED,
    maxCostLamports: parsed.MAX_COST_LAMPORTS,
    userDailyCostLimit: parsed.USER_DAILY_COST_LIMIT,
    globalDailyCostLimit: parsed.GLOBAL_DAILY_COST_LIMIT,
    userDailyCount: parsed.USER_DAILY_COUNT,
    maxConstructionsPerMinute: parsed.MAX_CONSTRUCTIONS_PER_MINUTE,
  };
}
