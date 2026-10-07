// `npm run test-data:sweep -- <label>` -- Feature 9002. For the implementer at
// the dev machine: clears one test-data label from the database in .env.
import "dotenv/config";
import { disconnectPrisma, getPrisma } from "../db/client.js";
import { sweepTestData } from "./sweep.js";

const label = process.argv[2];
if (label === undefined) {
  console.error("usage: npm run test-data:sweep -- <label>   (e2e, uat-<id>)");
  process.exit(1);
}

try {
  const result = await sweepTestData(getPrisma(), label);
  console.log(`swept "${result.label}": ${String(result.total)} rows removed`);
  for (const [table, count] of Object.entries(result.removed)) {
    console.log(`  ${table}: ${String(count)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
