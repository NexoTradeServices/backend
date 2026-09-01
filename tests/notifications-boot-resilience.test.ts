// Feature 1009 -- notifications never block boot
//
// AC1  no providers configured at all: production boots, one warning per channel
// AC2  only mailjet configured: Bob's SMS fails its row with the named error,
//      normal retries, terminal failed at the third attempt
// AC3  same state: Sarah's password reset sends normally -- one channel's gap
//      never touches the other
// AC4  the SMS row succeeds on a later attempt once clicksend becomes
//      configured -- no code change, no manual requeue
// AC5  dev behaviour is unchanged: simulated SMS still works, and a fully
//      configured setup logs no startup warning
// AC6  no code path anywhere refuses process start over provider configuration
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import {
  backdate,
  dispatchedSms,
  recordingAdapter,
  seedCast,
  setProviders,
  type CastIds,
} from "./helpers/notifications.js";
import { drainOnce, MAX_ATTEMPTS, sendNotification, startNotifications } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { MAILJET_PROVIDER } from "../src/notifications/providers/mailjet.js";
import { CLICKSEND_PROVIDER } from "../src/notifications/providers/clicksend.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let cast: CastIds;

// Registered UNDER THE REAL NAMES, so `resolveProvider`'s error text names the
// real provider ("clicksend") while a test still never calls the real HTTP
// APIs -- the same substitution feature 1004's own AC9 already relies on.
const fakeMailjet = recordingAdapter(MAILJET_PROVIDER, "email", { configured: true });
const fakeClicksend = recordingAdapter(CLICKSEND_PROVIDER, "sms", { configured: false });

async function queueBobsDispatch(key = "dispatched:assignment:a-1042"): Promise<string> {
  const row = await sendNotification(
    {
      type: "dispatched",
      channel: "sms",
      recipientType: "contractor",
      recipientId: cast.bobId,
      idempotencyKey: key,
      relatedType: "assignment",
      relatedId: "a-1042",
      context: { jobReference: "JOB-1042" },
    },
    db,
  );
  return row.id;
}

async function sendPasswordReset(key: string): Promise<void> {
  await sendNotification(
    {
      type: "password_reset",
      channel: "email",
      recipientType: "customer",
      recipientId: cast.sarahId,
      idempotencyKey: key,
      context: { name: "Sarah", resetUrl: "https://idelta.com.au/reset/abc123" },
    },
    db,
  );
}

beforeAll(() => {
  db = testClient();
  registerTemplate(dispatchedSms);
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
  registerProvider(fakeMailjet);
  registerProvider(fakeClicksend);
  fakeMailjet.reset();
  fakeClicksend.reset();
  await setProviders(db, {
    emailProvider: MAILJET_PROVIDER,
    smsProvider: CLICKSEND_PROVIDER,
    providerOverrides: null,
  });
});

afterEach(() => {
  delete process.env["NODE_ENV"];
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

describe("AC2 -- an unconfigured channel fails its own row, on the normal retry clock", () => {
  test("AC2: only mailjet configured, Bob's SMS fails with the named error and terminal-fails at the third attempt", async () => {
    process.env["NODE_ENV"] = "production";
    const id = await queueBobsDispatch();

    await drainOnce(db);
    let row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("no configured sms provider (clicksend)");

    await backdate(db, id, 2);
    await drainOnce(db);
    await backdate(db, id, 10);
    await drainOnce(db);

    row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("no configured sms provider (clicksend)");
    // The row failed at resolution -- the adapter's send() was never reached.
    expect(fakeClicksend.sent).toEqual([]);
  });
});

describe("AC3 -- one channel's gap never touches the other", () => {
  test("AC3: in the same state, Sarah's password reset sends normally while Bob's SMS fails", async () => {
    process.env["NODE_ENV"] = "production";
    await queueBobsDispatch();
    await sendPasswordReset(`password_reset:customer:${cast.sarahId}:1`);

    await drainOnce(db);

    const smsRow = await db.notification.findFirstOrThrow({ where: { channel: "sms" } });
    expect(smsRow.status).toBe("queued");
    expect(smsRow.error).toBe("no configured sms provider (clicksend)");

    const emailRow = await db.notification.findFirstOrThrow({ where: { channel: "email" } });
    expect(emailRow.status).toBe("sent");
    expect(emailRow.provider).toBe(MAILJET_PROVIDER);
    expect(fakeMailjet.sent).toHaveLength(1);
    expect(fakeMailjet.sent[0]?.message.subject).toBe("Reset your password");
  });
});

describe("AC4 -- configuring the provider rescues a row still inside its retry window", () => {
  test("AC4: an SMS row still queued for retry succeeds once clicksend becomes configured -- no code change, no requeue", async () => {
    process.env["NODE_ENV"] = "production";
    const id = await queueBobsDispatch();

    await drainOnce(db);
    let row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);

    // The fix is config, not code: the owner supplies real credentials. The
    // row and the queue are untouched -- only whether isConfigured() is true.
    fakeClicksend.configured = true;

    await backdate(db, id, 2);
    await drainOnce(db);

    row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2);
    expect(row.provider).toBe(CLICKSEND_PROVIDER);
    expect(fakeClicksend.sent).toHaveLength(1);
  });
});

describe("AC5 -- dev behaviour is unchanged", () => {
  test("AC5: simulated SMS still works in dev, and a fully configured setup logs no startup warning", async () => {
    // Part 1: dev (NODE_ENV unset here), clicksend unconfigured -- the send
    // still reaches `sent` through the console adapter, exactly as before 1009.
    const id = await queueBobsDispatch();
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await drainOnce(db);
    } finally {
      logged.mockRestore();
    }
    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.provider).toBe("console");

    // Part 2: every named channel IS configured -- startup names nothing.
    fakeClicksend.configured = true;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dispatcher = await startNotifications({ client: db, intervalMs: 3_600_000 });
      await dispatcher.stop();
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});

describe("AC1 and AC6 -- the app always boots, no matter the provider configuration", () => {
  const CLICKSEND_ENV = ["CLICKSEND_USERNAME", "CLICKSEND_API_KEY"] as const;
  const MAILJET_ENV = ["MAILJET_API_KEY", "MAILJET_API_SECRET", "MAILJET_FROM_EMAIL"] as const;
  const ALL_ENV = [...CLICKSEND_ENV, ...MAILJET_ENV];
  let saved: (string | undefined)[];

  beforeEach(() => {
    saved = ALL_ENV.map((name) => process.env[name]);
    for (const name of ALL_ENV) delete process.env[name];
    // The real, shipped adapters -- exactly what a fresh clone has configured,
    // no test double standing in front of them.
    resetProviders();
    process.env["NODE_ENV"] = "production";
  });

  afterEach(() => {
    ALL_ENV.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    registerProvider(fakeMailjet);
    registerProvider(fakeClicksend);
  });

  test("AC1: with no providers configured at all, production boots and logs one warning per unconfigured channel", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dispatcher = await startNotifications({ client: db, intervalMs: 3_600_000 });
      await dispatcher.stop();

      const messages = warned.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(2);
      expect(messages.some((m) => m.includes("email") && m.includes(MAILJET_PROVIDER))).toBe(true);
      expect(messages.some((m) => m.includes("sms") && m.includes(CLICKSEND_PROVIDER))).toBe(true);
    } finally {
      warned.mockRestore();
    }
  });

  test("AC6: no code path anywhere refuses process start over provider configuration -- production boots with an empty provider environment", async () => {
    const dispatcher = await startNotifications({ client: db, intervalMs: 3_600_000 });
    expect(dispatcher).toBeDefined();
    await dispatcher.stop();
  });
});
