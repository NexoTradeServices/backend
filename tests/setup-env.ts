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

// Feature 1003 -- auth + roles. buildAuth() requires these with no default
// (same as WEB_ORIGIN always has); a real .env supplies real values, and
// `dotenv/config` above already loaded them where one exists. Where it
// doesn't (CI, a fresh clone, Docker -- house rule 5), nothing talks to a
// real cookie or a real secret in a test run, so safe fixed test values are
// exactly as correct as real ones.
process.env["WEB_ORIGIN"] ??= "https://idelta.com.au";
process.env["COOKIE_DOMAIN"] ??= "idelta.com.au";
process.env["BETTER_AUTH_SECRET"] ??= "test-only-secret-do-not-use-outside-tests";
process.env["API_BASE_URL"] ??= "https://api.idelta.com.au";
