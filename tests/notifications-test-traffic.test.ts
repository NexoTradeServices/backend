// Feature 6001, CL-08 -- automated browser-test traffic never reaches a real provider
//
// 1  a message tied to an `e2e` row goes to the console, not the provider the settings name
// 2  a normal row and a UAT row (`uat-<id>`) still go to the real provider
// 3  in production the label means nothing: the real provider is used
// 4  a message about an `e2e` job inherits the label even when it is asked for outside the request
//    that made the job (the pay-link loop) -- and so is kept off the real provider too
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, seedCast, setProviders } from "./helpers/notifications.js";
import { drainOnce, sendNotification } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { runWithLabel } from "../src/test-data/label.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let sarahId: string;

const email = recordingAdapter("test-email-traffic", "email");

beforeAll(() => {
  db = testClient();
  registerProvider(email);
  registerTemplate({
    type: "traffic_probe",
    channel: "email",
    category: "transactional",
    render: () => ({ subject: "probe", text: "probe" }),
  });
});

afterAll(async () => {
  resetProviders();
  resetTemplates();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  ({ sarahId } = await seedCast(db));
  await setProviders(db, { emailProvider: email.name, providerOverrides: null });
  email.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function ask(key: string, jobId?: string): Promise<string> {
  const row = await sendNotification(
    {
      type: "traffic_probe",
      channel: "email",
      recipientType: "customer",
      recipientId: sarahId,
      idempotencyKey: `traffic_probe:customer:${key}`,
      ...(jobId === undefined ? {} : { jobId }),
    },
    db,
  );
  return row.id;
}

describe("1 / 2 / 3 -- which provider a message goes to", () => {
  test("1: a message tied to an e2e row is shown in the console and never handed to the provider", async () => {
    const id = await runWithLabel("e2e", () => ask("a"));
    expect((await db.notification.findUniqueOrThrow({ where: { id } })).testData).toBe("e2e");
    await drainOnce(db);
    expect(email.sent).toHaveLength(0);
    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "sent", provider: "console" });
  });

  test("2: a normal message and a UAT message still go to the provider the settings name", async () => {
    await ask("b");
    await runWithLabel("uat-6001", () => ask("c"));
    await drainOnce(db);
    expect(email.sent).toHaveLength(2);
    const rows = await db.notification.findMany({ where: { type: "traffic_probe" } });
    expect(rows.every((r) => r.provider === email.name)).toBe(true);
  });

  test("3: in production the label means nothing -- the real provider is used", async () => {
    const id = await runWithLabel("e2e", () => ask("d"));
    vi.stubEnv("NODE_ENV", "production");
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
    expect((await db.notification.findUniqueOrThrow({ where: { id } })).provider).toBe(email.name);
  });
});

describe("4 -- a message inherits its job's label", () => {
  async function jobWithLabel(label: string | null): Promise<string> {
    const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const make = () =>
      db.job.create({
        data: {
          reference: "JOB-9001",
          customerId: sarahId,
          serviceTypeId: plumbing.id,
          customerCalloutRate: plumbing.customerCalloutRate,
          customerStandardRate: plumbing.customerStandardRate,
          postcode: "6163",
          serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.07, lng: 115.78, placeId: "x" },
          timezone: "Australia/Perth",
          source: "web",
          preferredWindow: "morning",
          preferredDate: new Date(),
        },
      });
    const job = label === null ? await make() : await runWithLabel(label, make);
    return job.id;
  }

  test("4: asked outside the request that made an e2e job, the message still carries e2e and stays off the provider", async () => {
    const jobId = await jobWithLabel("e2e");
    const id = await ask("e", jobId); // no label held here: this is the loop's situation
    expect((await db.notification.findUniqueOrThrow({ where: { id } })).testData).toBe("e2e");
    await drainOnce(db);
    expect(email.sent).toHaveLength(0);
  });

  test("4: a message about an unlabelled job stays unlabelled and goes to the provider", async () => {
    const jobId = await jobWithLabel(null);
    const id = await ask("f", jobId);
    expect((await db.notification.findUniqueOrThrow({ where: { id } })).testData).toBeNull();
    await drainOnce(db);
    expect(email.sent).toHaveLength(1);
  });
});
