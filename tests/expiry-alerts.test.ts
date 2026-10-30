// Feature 7002 -- licence and insurance expiry alerts: a step of the daily sweep
//
// AC1  Bob's plumbing licence 30 days out: Bob and the office inbox are emailed, Bob's copy replies to the office
// AC2  a run each day from 31 days left to the day after expiry: five pairs, at 30, 23, 16, 9 and 2 days left
// AC3  a run that missed days sends the step it lands in once, never the steps it skipped
// AC4  a new expiry date stops the old date's alerts and starts its own run at 30 days before it
// AC5  insurance wordings, naming the insurer and policy number, or reading without them
// AC6  a suspended specialty, or a suspended contractor, gets no alert
// AC7  a contractor with two trades is alerted for the one trade whose licence is near
//
// Fixed clock: the step is called directly with a business day (`today`). No test reaches Mailjet; the email adapter records.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { DAILY_STEPS, runDailySteps } from "../src/daily/index.js";
import { alertStep, runExpiryAlerts } from "../src/contractors/expiry-alerts.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

const ZONE = "Australia/Perth";
const TODAY = "2026-10-14"; // a Wednesday
const DAY = 86_400_000;

let db: PrismaClient;
const email = recordingAdapter("test-email-7002", "email");

/** The plain date `days` after `from`, `YYYY-MM-DD`. */
function plus(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

beforeAll(() => {
  db = testClient();
  registerProvider(email);
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  email.reset();
});

async function setLicence(contractorCode: string, trade: string, expiry: string): Promise<void> {
  await db.contractorSpecialty.updateMany({ where: { trade, contractor: { code: contractorCode } }, data: { licenceExpiry: new Date(expiry) } });
}

async function setInsurance(contractorCode: string, data: { expiry: string; insurer?: string | null; policy?: string | null }): Promise<void> {
  await db.contractor.update({
    where: { code: contractorCode },
    data: {
      insuranceExpiry: new Date(data.expiry),
      ...(data.insurer === undefined ? {} : { insurer: data.insurer }),
      ...(data.policy === undefined ? {} : { insurancePolicyNo: data.policy }),
    },
  });
}

async function alertRows(type?: string) {
  return db.notification.findMany({
    where: { type: type ?? { in: ["licence_expiring", "insurance_expiring"] } },
    orderBy: [{ createdAt: "asc" }, { idempotencyKey: "asc" }],
  });
}

const run = (today: string) => runExpiryAlerts(db, { zone: ZONE, today });

describe("the step arithmetic", () => {
  test("alertStep: 30-24 days is step 0, 23-17 is 1, 16-10 is 2, 9-3 is 3, 2-1 is 4; outside 1..30 is none", () => {
    expect([31, 30, 24, 23, 17, 16, 10, 9, 3, 2, 1, 0, -4].map(alertStep)).toEqual([null, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, null, null]);
  });

  test("the morning run carries the step, after the two invoice steps (7004 appends its own after it)", () => {
    expect(DAILY_STEPS.map((step) => step.name)).toEqual(["invoice reminders", "pay-link switch-off", "licence and insurance alerts", "job-tomorrow reminders"]);
  });
});

describe("AC1 -- Bob's licence, 30 days out", () => {
  test("AC1: Bob and the office inbox are emailed; only Bob's copy replies to the office inbox", async () => {
    const expiry = plus(TODAY, 30); // Fri 13 Nov
    await setLicence("CON-014", "Plumbing", expiry);
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });

    const result = await runDailySteps(db, { zone: ZONE, today: TODAY });
    expect(result.failed).toEqual([]);
    const rows = await alertRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.recipientType).sort()).toEqual(["contractor", "ops"]);

    await drainOnce(db);
    expect(email.sent).toHaveLength(2);
    const toBob = email.sent.find((sent) => sent.to === bob.email);
    const toOffice = email.sent.find((sent) => sent.to === "ops@idelta.com.au");
    expect(toBob?.message.subject).toBe("Your plumbing licence expires Fri 13 Nov");
    expect(toBob?.message.text).toContain("Hi Bob,");
    expect(toBob?.message.text).toContain("Your plumbing licence PL-8841 expires on Fri 13 Nov - 30 days from today.");
    expect(toBob?.message.text).toContain("we can't send you new plumbing jobs until your renewed licence is on file. Jobs already booked go ahead.");
    expect(toBob?.message.text).toContain("ring the office on 08 0000 0000");
    expect(toBob?.message.text).not.toContain("$");
    expect(toBob?.message.replyTo).toBe("ops@idelta.com.au");

    expect(toOffice?.message.subject).toBe("Licence expiring - Bob Reilly, Plumbing, Fri 13 Nov");
    expect(toOffice?.message.text).toContain("Bob Reilly's (CON-014) plumbing licence PL-8841 expires on Fri 13 Nov - 30 days from today.");
    expect(toOffice?.message.text).toContain("Bob drops off the dispatch list for plumbing.");
    expect(toOffice?.message.text).toContain("Open Bob's record: https://idelta.com.au/ops/contractors/CON-014");
    expect(toOffice?.message.html).toContain(`<a href="https://idelta.com.au/ops/contractors/CON-014">Open Bob's record</a>`);
    expect(toOffice?.message.replyTo).toBeUndefined();
  });

  test("AC1: the seeded licences and insurance (all months away, Priya's long past) send nothing", async () => {
    expect((await run(TODAY)).sent).toBe(0);
    expect(await alertRows()).toHaveLength(0);
  });

  test("AC1: with 1 day left the wording reads '1 day', never '1 days'", async () => {
    await setLicence("CON-014", "Plumbing", plus(TODAY, 1));
    await run(TODAY);
    await drainOnce(db);
    expect(email.sent.map((sent) => sent.message.text).join("\n")).toContain("1 day from today");
    expect(email.sent.map((sent) => sent.message.text).join("\n")).not.toContain("1 days");
  });
});

describe("AC2 -- five pairs, whatever the days", () => {
  test("AC2: a run each day from 31 days left to the day after expiry sends pairs at 30, 23, 16, 9 and 2 days left only", async () => {
    const expiry = plus(TODAY, 40);
    await setLicence("CON-014", "Plumbing", expiry);
    const sentAt: number[] = [];
    for (let daysLeft = 41; daysLeft >= -1; daysLeft -= 1) {
      const made = await run(plus(expiry, -daysLeft));
      if (made.sent > 0) sentAt.push(daysLeft);
      // The same morning's second run sends nothing more.
      expect((await run(plus(expiry, -daysLeft))).sent).toBe(0);
    }
    expect(sentAt).toEqual([30, 23, 16, 9, 2]);
    const rows = await alertRows("licence_expiring");
    expect(rows).toHaveLength(10);
    const steps = new Set(rows.map((row) => row.idempotencyKey.split(":").slice(-2)[0]));
    expect([...steps].sort()).toEqual(["0", "1", "2", "3", "4"]);
  });
});

describe("AC3 -- a missed morning", () => {
  test("AC3: runs at 30 then 12 days left send steps 0 and 2 only; the skipped step 1 is never sent", async () => {
    const expiry = plus(TODAY, 30);
    await setLicence("CON-014", "Plumbing", expiry);
    await run(TODAY);
    await run(plus(expiry, -12));
    const stepsSent = (await alertRows("licence_expiring")).map((row) => row.idempotencyKey.split(":").slice(-2)[0]);
    expect(stepsSent.sort()).toEqual(["0", "0", "2", "2"]);
    await run(plus(expiry, -12)); // a repeat
    expect(await alertRows("licence_expiring")).toHaveLength(4);
  });
});

describe("AC4 -- a new expiry date", () => {
  test("AC4: Mike entering an expiry 12 months away stops the old date's alerts; nothing fires until 30 days before the new one", async () => {
    const oldExpiry = plus(TODAY, 30);
    await setLicence("CON-014", "Plumbing", oldExpiry);
    await run(TODAY);
    expect(await alertRows()).toHaveLength(2);

    const newExpiry = plus(oldExpiry, 365);
    await setLicence("CON-014", "Plumbing", newExpiry);
    for (const daysLeft of [23, 16, 9, 2, 1]) {
      expect((await run(plus(oldExpiry, -daysLeft))).sent).toBe(0);
    }
    expect(await alertRows()).toHaveLength(2);

    expect((await run(plus(newExpiry, -31))).sent).toBe(0);
    expect((await run(plus(newExpiry, -30))).sent).toBe(2);
    const keys = (await alertRows()).map((row) => row.idempotencyKey);
    expect(keys.filter((key) => key.includes(newExpiry))).toHaveLength(2);
    expect(keys.filter((key) => key.includes(oldExpiry))).toHaveLength(2);
  });
});

describe("AC5 -- insurance", () => {
  test("AC5: Bob's insurance 30 days out sends the insurance wordings naming the insurer and the policy number", async () => {
    await setInsurance("CON-014", { expiry: plus(TODAY, 30), insurer: "QBE", policy: "PL-2291-884" });
    await run(TODAY);
    await drainOnce(db);
    expect(email.sent).toHaveLength(2);
    const toBob = email.sent.find((sent) => sent.to !== "ops@idelta.com.au");
    const toOffice = email.sent.find((sent) => sent.to === "ops@idelta.com.au");
    expect(toBob?.message.subject).toBe("Your insurance expires Fri 13 Nov");
    expect(toBob?.message.text).toContain("Your public liability insurance with QBE, policy PL-2291-884, expires on Fri 13 Nov - 30 days from today.");
    expect(toBob?.message.text).toContain("we can't send you any new jobs until your renewed insurance is on file. Jobs already booked go ahead.");
    expect(toBob?.message.replyTo).toBe("ops@idelta.com.au");
    expect(toOffice?.message.subject).toBe("Insurance expiring - Bob Reilly, Fri 13 Nov");
    expect(toOffice?.message.text).toContain("Bob Reilly's (CON-014) public liability insurance with QBE, policy PL-2291-884, expires on Fri 13 Nov - 30 days from today.");
    expect(toOffice?.message.text).toContain("Bob drops off the dispatch list for every trade.");
    expect(toOffice?.message.text).toContain("Open Bob's record:");
  });

  test("AC5: with neither insurer nor policy number the sentence reads without them; with one it names that one", async () => {
    await setInsurance("CON-014", { expiry: plus(TODAY, 30), insurer: null, policy: null });
    await run(TODAY);
    await drainOnce(db);
    const bare = email.sent.map((sent) => sent.message.text).join("\n");
    expect(bare).toContain("Your public liability insurance expires on Fri 13 Nov - 30 days from today.");
    expect(bare).toContain("public liability insurance expires on Fri 13 Nov");
    expect(bare).not.toMatch(/null|undefined|with ,|policy ,/);

    email.reset();
    await db.notification.deleteMany({});
    await setInsurance("CON-014", { expiry: plus(TODAY, 30), insurer: "QBE", policy: null });
    await run(TODAY);
    await drainOnce(db);
    expect(email.sent.map((sent) => sent.message.text).join("\n")).toContain("Your public liability insurance with QBE, expires on Fri 13 Nov");

    email.reset();
    await db.notification.deleteMany({});
    await setInsurance("CON-014", { expiry: plus(TODAY, 30), insurer: null, policy: "PL-1" });
    await run(TODAY);
    await drainOnce(db);
    expect(email.sent.map((sent) => sent.message.text).join("\n")).toContain("Your public liability insurance policy PL-1, expires on Fri 13 Nov");
  });

  test("AC5: Dave's insurance 23 days out sends the second step", async () => {
    await setInsurance("CON-021", { expiry: plus(TODAY, 23), insurer: "QBE", policy: "PL-7710-020" });
    await run(TODAY);
    const rows = await alertRows("insurance_expiring");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.idempotencyKey.includes(":1:"))).toBe(true);
  });
});

describe("AC6 -- suspended gets nothing", () => {
  test("AC6: Priya's suspended electrical specialty, licence 9 days out, sends nothing", async () => {
    await db.contractorSpecialty.updateMany({ where: { contractor: { code: "CON-030" }, trade: "Electrical" }, data: { status: "suspended", licenceExpiry: new Date(plus(TODAY, 9)) } });
    expect((await run(TODAY)).sent).toBe(0);
    expect(await alertRows()).toHaveLength(0);
  });

  test("AC6: a suspended contractor gets no licence and no insurance alert", async () => {
    await setLicence("CON-014", "Plumbing", plus(TODAY, 30));
    await setInsurance("CON-014", { expiry: plus(TODAY, 30) });
    await db.contractor.update({ where: { code: "CON-014" }, data: { status: "suspended" } });
    expect((await run(TODAY)).sent).toBe(0);
    expect(await alertRows()).toHaveLength(0);
  });
});

describe("AC7 -- two trades", () => {
  test("AC7: Dave's electrical licence 30 days out alerts for electrical only; his air conditioning licence sends nothing", async () => {
    await setLicence("CON-021", "Electrical", plus(TODAY, 30));
    await run(TODAY);
    await drainOnce(db);
    expect(email.sent).toHaveLength(2);
    expect(email.sent.map((sent) => sent.message.subject).sort()).toEqual([
      "Licence expiring - Dave Hurst, Electrical, Fri 13 Nov",
      "Your electrical licence expires Fri 13 Nov",
    ].sort());
    expect(email.sent.map((sent) => sent.message.text).join("\n")).not.toMatch(/air conditioning/i);
  });
});
