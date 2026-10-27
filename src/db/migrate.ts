import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

export async function runMigrations(databaseUrl: string): Promise<void> {
  const migrationsDirectory = path.resolve(process.cwd(), "src/db/migrations");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = await client.query<{ name: string }>("select name from schema_migrations");
    const appliedNames = new Set(applied.rows.map((row) => row.name));
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (appliedNames.has(file)) continue;
      const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}
