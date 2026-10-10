// The UAT data script pattern -- Feature 9002.
//
// Design: Data Model, Test data. The records made in dev for the owner's hand
// check of a feature are test data, labelled `uat-<id>`, and cleared once the
// check passes. Each feature's own script (`src/db/uat/<id>-<slug>.ts`)
// supplies only what is specific to it:
//
//   make(client)         creates the records, as the cast people the plan names,
//                        and returns one line per record for the UAT section.
//                        Runs under the label, so everything it creates -- and
//                        everything created for those records later -- is
//                        labelled and swept together.
//   restoreCast(client)  optional: puts back any cast record the check changed.
//                        make() also calls it first when it sets a cast record
//                        to a starting state.
//
// `npm run uat -- <id>-<slug> make|clear` runs one (run.ts). Both modes refuse
// NODE_ENV=production, through the label and the sweep.
import type { PrismaClient } from "../client.js";
import { runWithLabel } from "../../test-data/label.js";
import { sweepTestData, type SweepResult } from "../../test-data/sweep.js";

export interface UatScript {
  make(client: PrismaClient): Promise<string[]>;
  restoreCast?(client: PrismaClient): Promise<void>;
  /**
   * optional: during UAT, remake only the records the owner has used up as fresh records and leave
   * every other record as it is (`npm run uat -- <id>-<slug> topup`). Returns the new lines.
   */
  topUp?(client: PrismaClient): Promise<string[]>;
}

/** The leading feature number of a `<id>-<slug>` name: `9002-test-data-hygiene` -> `9002`. */
export function featureId(name: string): string {
  const match = /^(\d+)-[a-z0-9-]+$/.exec(name);
  if (match?.[1] === undefined) {
    throw new Error(`"${name}" is not a UAT script name -- expected <id>-<slug>, such as 9002-test-data-hygiene`);
  }
  return match[1];
}

export function uatLabel(name: string): string {
  return `uat-${featureId(name)}`;
}

/** Create the feature's UAT records under its label. Returns the lines to list in the UAT section. */
export async function makeUatData(client: PrismaClient, name: string, script: UatScript): Promise<string[]> {
  return runWithLabel(uatLabel(name), () => script.make(client));
}

/** Remove every record labelled for the feature, then put back any cast record the check changed. */
export async function clearUatData(client: PrismaClient, name: string, script: UatScript): Promise<SweepResult> {
  const result = await sweepTestData(client, uatLabel(name));
  await script.restoreCast?.(client);
  return result;
}
