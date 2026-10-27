import type { PoolClient } from "pg";
import { SponsorshipError } from "./errors.js";

export interface SponsorshipLimits {
  enabled: boolean;
  maxCostLamports: number;
  userDailyCostLimit: number;
  globalDailyCostLimit: number;
  userDailyCount: number;
  maxConstructionsPerMinute: number;
}

export async function reserveSponsorship(
  client: PoolClient,
  input: { sponsoredTransactionId: string; userId: string; costLamports: number },
  limits: SponsorshipLimits,
): Promise<void> {
  if (!limits.enabled) throw new SponsorshipError("sponsorship_disabled", "Sponsorship circuit breaker is active", 503);
  if (input.costLamports > limits.maxCostLamports) {
    throw new SponsorshipError("cost_limit_exceeded", "Estimated sponsor cost exceeds the per-transaction limit", 429);
  }

  await client.query("select singleton from sponsorship_budget_state where singleton = true for update");
  await client.query("select user_id from sponsorship_users where user_id = $1 for update", [input.userId]);
  const usage = await client.query<{
    user_costs: string;
    global_costs: string;
    user_count: string;
  }>(
    `select
      coalesce(sum(cost_lamports) filter (where user_id = $1), 0)::text as user_costs,
      coalesce(sum(cost_lamports), 0)::text as global_costs,
      count(*) filter (where user_id = $1)::text as user_count
     from sponsorship_usage where usage_date = current_date`,
    [input.userId],
  );
  const current = usage.rows[0]!;
  if (Number(current.user_costs) + input.costLamports > limits.userDailyCostLimit
    || Number(current.global_costs) + input.costLamports > limits.globalDailyCostLimit
    || Number(current.user_count) + 1 > limits.userDailyCount) {
    throw new SponsorshipError("budget_exceeded", "Daily sponsorship budget would be exceeded", 429);
  }

  await client.query(
    "insert into sponsorship_usage (sponsored_transaction_id, user_id, cost_lamports) values ($1, $2, $3)",
    [input.sponsoredTransactionId, input.userId, input.costLamports],
  );
}
