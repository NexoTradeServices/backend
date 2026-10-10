// `npm run uat -- <id>-<slug> make|clear` -- Feature 9002.
//
// Runs one feature's UAT data script (src/db/uat/<id>-<slug>.ts) against the
// database in .env. Inside the backend dev container, never against production.
import "dotenv/config";
import { disconnectPrisma, getPrisma } from "../client.js";
import { runWithLabel } from "../../test-data/label.js";
import { clearUatData, makeUatData, uatLabel, type UatScript } from "./pattern.js";

const [name, mode] = process.argv.slice(2);
if (name === undefined || (mode !== "make" && mode !== "clear" && mode !== "topup")) {
  console.error("usage: npm run uat -- <id>-<slug> make|clear|topup");
  process.exit(1);
}

try {
  const label = uatLabel(name); // also rejects a name that is not <id>-<slug>
  const script = (await import(`./${name}.js`)) as UatScript;
  const client = getPrisma();
  if (mode === "make") {
    // Start from the same records every time: clear first, so a second make never doubles up.
    await clearUatData(client, name, script);
    const lines = await makeUatData(client, name, script);
    console.log(`made ${String(lines.length)} record(s) labelled "${label}":`);
    for (const line of lines) console.log(`  ${line}`);
  } else if (mode === "topup") {
    // During UAT: remake only the records the owner has used up; every other record stays as it is.
    if (script.topUp === undefined) throw new Error(`${name} has no topUp -- use make`);
    const lines = await runWithLabel(label, () => script.topUp?.(client) ?? Promise.resolve([]));
    console.log(`topped up ${String(lines.length)} record(s) labelled "${label}":`);
    for (const line of lines) console.log(`  ${line}`);
  } else {
    const result = await clearUatData(client, name, script);
    console.log(`cleared "${label}": ${String(result.total)} rows removed`);
    for (const [table, count] of Object.entries(result.removed)) {
      console.log(`  ${table}: ${String(count)}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
