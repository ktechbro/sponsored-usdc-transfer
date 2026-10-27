import { runMigrations } from "./migrate.js";

await runMigrations(process.env.DATABASE_URL
  ?? "postgresql://postgres:postgres@localhost:5435/sponsored_usdc_transfer");
