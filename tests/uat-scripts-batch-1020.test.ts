// The UAT data scripts of batch 1020 (features 1020, 1021, 1022, 2004) - run here, against the TEST database, so the
// first time one runs is not at the owner's sitting. Each: make -> records labelled uat-<id>; topUp (if it has one) remakes
// nothing that is intact; clear -> everything labelled is gone and the seeded cast is as it was.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { freshWorld } from "./helpers/ops-app.js";
import { clearUatData, makeUatData, uatLabel, type UatScript } from "../src/db/uat/pattern.js";
import { runWithLabel } from "../src/test-data/label.js";
import * as s1020 from "../src/db/uat/1020-business-hours-and-holidays.js";
import * as s1021 from "../src/db/uat/1021-operating-states.js";
import * as s1022 from "../src/db/uat/1022-time-zones.js";
import * as s2004 from "../src/db/uat/2004-contractor-calendar-and-availability.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
const email = recordingAdapter("test-email-uat-1020", "email");

beforeAll(() => {
  db = testClient();
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await freshWorld(db, email);
});

const SCRIPTS: [string, UatScript][] = [
  ["1020-business-hours-and-holidays", s1020],
  ["1021-operating-states", s1021],
  ["1022-time-zones", s1022],
  ["2004-contractor-calendar-and-availability", s2004],
];

describe.each(SCRIPTS)("%s", (name, script) => {
  test("make labels what it creates, topUp leaves intact records alone, clear removes it all and leaves the cast", async () => {
    const label = uatLabel(name);
    const cast = {
      contractors: await db.contractor.count(),
      customers: await db.customer.count(),
      jobs: await db.job.count({ where: { testData: null } }),
      notifications: await db.notification.count(),
    };

    const lines = await makeUatData(db, name, script);
    expect(lines.length).toBeGreaterThan(0);
    const jobs = await db.job.count({ where: { testData: label } });
    expect(jobs).toBeGreaterThan(0);
    expect(await db.notification.count()).toBe(cast.notifications); // nothing is sent while a script makes its records

    if (script.topUp !== undefined) {
      const again = await runWithLabel(label, () => script.topUp?.(db) ?? Promise.resolve([]));
      expect(again).toEqual([]);
      expect(await db.job.count({ where: { testData: label } })).toBe(jobs);
    }

    await clearUatData(db, name, script);
    expect(await db.job.count({ where: { testData: label } })).toBe(0);
    expect(await db.contractor.count()).toBe(cast.contractors);
    expect(await db.job.count({ where: { testData: null } })).toBe(cast.jobs);
    expect(await db.customer.count({ where: { testData: null } })).toBe(cast.customers);
  });
});
