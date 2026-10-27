import { loadConfig } from "./config.js";
import { SolanaChainGateway } from "./chain/gateway.js";
import { LocalDevnetSponsorSigner } from "./chain/signer.js";
import { createPool } from "./db/pool.js";
import { buildApp } from "./http/app.js";
import { PaymentIntentService } from "./service/intents.js";
import { SponsorshipService } from "./service/sponsorship.js";

const config = loadConfig();
const pool = createPool({ connectionString: config.databaseUrl });
const signer = new LocalDevnetSponsorSigner(config.sponsorSecretKey);
const chain = new SolanaChainGateway(config.solanaRpcUrl);
const intents = new PaymentIntentService(pool, config.usdcMint, config.usdcDecimals);
const sponsorship = new SponsorshipService(pool, chain, signer, {
  enabled: config.sponsorshipEnabled,
  maxCostLamports: config.maxCostLamports,
  userDailyCostLimit: config.userDailyCostLimit,
  globalDailyCostLimit: config.globalDailyCostLimit,
  userDailyCount: config.userDailyCount,
  maxConstructionsPerMinute: config.maxConstructionsPerMinute,
}, config.cluster, config.expectedGenesisHash);
const app = buildApp({ config, pool, intents, sponsorship, logger: true });

app.addHook("onClose", async () => {
  await pool.end();
});

async function shutdown() {
  await app.close();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
