// Runs before every test file (vitest.config.ts setupFiles).
//
// Points DATABASE_URL at the TEST database before anything imports
// src/db/client.ts, so a test can never reach tradeservice_dev by accident.
import "dotenv/config";

const testUrl = process.env["TEST_DATABASE_URL"];
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL is not set -- see .env.example");
}
process.env["DATABASE_URL"] = testUrl;
