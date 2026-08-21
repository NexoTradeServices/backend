// Runs once, before the whole suite (vitest.config.ts globalSetup).
//
// Wipes the test database and rebuilds it from the migrations, so every run
// starts from an empty Postgres exactly like a fresh environment would.
import "dotenv/config";
import { resetDatabase, testClient, testDatabaseUrl } from "./helpers/database.js";

export async function setup(): Promise<void> {
  process.env["DATABASE_URL"] = testDatabaseUrl();
  const client = testClient();
  try {
    await resetDatabase(client);
  } finally {
    await client.$disconnect();
  }
}
