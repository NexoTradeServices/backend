// Feature 1004, notification module
//
// AC3  the dispatcher drains -- queued row -> sent, stamped
// AC4  a throwing adapter retries, then gives up at the third failure
// AC5  two loops over the same row cause exactly one provider call
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import {
  backdate,
  dispatchedSms,
  recordingAdapter,
  seedCast,
  setProviders,
  type CastIds,
} from "./helpers/notifications.js";
import { drainOnce, MAX_ATTEMPTS, sendNotification } from "../src/notifications/index.js";
import { registerTemplate, resetTemplates } from "../src/notifications/templates/registry.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let cast: CastIds;

const sms = recordingAdapter("test-sms", "sms");

/** Bob's dispatch SMS, the one message every criterion in this file drains. */
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

beforeAll(() => {
  db = testClient();
  registerTemplate(dispatchedSms);
  registerProvider(sms);
});

beforeEach(async () => {
  await truncateAll(db);
  cast = await seedCast(db);
  await setProviders(db, { smsProvider: sms.name });
  sms.reset();
});

afterAll(async () => {
  resetTemplates();
  resetProviders();
  await db.$disconnect();
});

describe("AC3 -- the dispatcher drains", () => {
  test("AC3: a queued row is picked up, sent, and ends at sent with provider, id and sentAt", async () => {
    const id = await queueBobsDispatch();

    const handled = await drainOnce(db);
    expect(handled).toBe(1);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.provider).toBe("test-sms");
    expect(row.providerMessageId).toBe("test-sms-1");
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(sms.sent[0]?.to).toBe("0400 000 014"); // Bob's number, from the cast
  });

  test("AC3: a drained row is not picked up again", async () => {
    await queueBobsDispatch();
    await drainOnce(db);

    expect(await drainOnce(db)).toBe(0);
    expect(sms.sent).toHaveLength(1);
  });
});

describe("AC4 -- three attempts, then failed", () => {
  test("AC4: an adapter that throws leaves the row queued with attempts incremented", async () => {
    const id = await queueBobsDispatch();
    sms.failWith = "clicksend said no";

    await drainOnce(db);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("clicksend said no");
  });

  test("AC4: the backoff holds the row back -- the next pass does not touch it yet", async () => {
    await queueBobsDispatch();
    sms.failWith = "clicksend said no";
    await drainOnce(db);

    // One minute has not passed, so there is nothing due.
    expect(await drainOnce(db)).toBe(0);
  });

  test("AC4: after the third failure the row is failed, carrying the provider's message", async () => {
    const id = await queueBobsDispatch();
    sms.failWith = "clicksend said no";

    // The backoff is measured from createdAt, so winding that clock back is how
    // three attempts happen in a test instead of over six real minutes.
    await drainOnce(db);
    await backdate(db, id, 2);
    await drainOnce(db);
    await backdate(db, id, 10);
    await drainOnce(db);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("clicksend said no");
  });

  test("AC4: and no fourth attempt is ever made", async () => {
    const id = await queueBobsDispatch();
    sms.failWith = "clicksend said no";

    await drainOnce(db);
    await backdate(db, id, 2);
    await drainOnce(db);
    await backdate(db, id, 10);
    await drainOnce(db);

    // Wound back far past any backoff: a failed row is finished, not merely resting.
    await backdate(db, id, 600);
    expect(await drainOnce(db)).toBe(0);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(MAX_ATTEMPTS);
  });

  test("AC4: a provider that recovers on the second attempt still ends at sent", async () => {
    const id = await queueBobsDispatch();
    sms.failWith = "a blip";
    await drainOnce(db);

    sms.failWith = null;
    await backdate(db, id, 2);
    await drainOnce(db);

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2);
    expect(row.error).toBeNull();
    expect(sms.sent).toHaveLength(1);
  });
});

describe("AC5 -- two loops, one send", () => {
  test("AC5: two loops over an OVERDUE row still send it exactly once", async () => {
    // THE CASE REVIEW FINDING R1.1 PROVED. A row that is already past its next
    // backoff step when it is claimed cannot be protected by the backoff: it is
    // due again the instant the claim commits. Only the row lock, held for the
    // whole send, keeps the second loop off it. A fresh row never exercises
    // that, which is why the first version of this suite passed over the bug.
    const id = await queueBobsDispatch();
    await backdate(db, id, 60);

    const other = testClient();
    sms.delayMs = 200;

    try {
      const [first, second] = await Promise.all([drainOnce(db), drainOnce(other)]);
      expect(first + second).toBe(1);
    } finally {
      await other.$disconnect();
      sms.delayMs = 0;
    }

    expect(sms.sent).toHaveLength(1);
    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
  });

  test("AC5: two loops over an overdue row that FAILS still spend exactly one attempt", async () => {
    // The same window, on the unhappy path: a row whose send fails must come out
    // with one attempt spent, not two, or three failures arrive in two passes.
    const id = await queueBobsDispatch();
    await backdate(db, id, 60);
    sms.failWith = "clicksend said no";
    sms.delayMs = 200;

    const other = testClient();
    try {
      await Promise.all([drainOnce(db), drainOnce(other)]);
    } finally {
      await other.$disconnect();
      sms.delayMs = 0;
    }

    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("queued");
  });

  test("AC5: two dispatcher loops over the same queued row cause exactly one provider call", async () => {
    const id = await queueBobsDispatch();

    // A second client is a second connection -- the same shape as a second Fly
    // machine, which is what SKIP LOCKED is actually defending against.
    const other = testClient();
    // Slow enough that both loops are genuinely inside the claim at once.
    sms.delayMs = 200;

    try {
      const [first, second] = await Promise.all([drainOnce(db), drainOnce(other)]);
      expect(first + second).toBe(1);
    } finally {
      await other.$disconnect();
      sms.delayMs = 0;
    }

    expect(sms.sent).toHaveLength(1);
    const row = await db.notification.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
  });

  test("AC5: two loops over a queue of many still send each row exactly once", async () => {
    for (let i = 0; i < 6; i += 1) {
      await queueBobsDispatch(`dispatched:assignment:a-10${String(i)}`);
    }

    const other = testClient();
    try {
      await Promise.all([drainOnce(db), drainOnce(other)]);
    } finally {
      await other.$disconnect();
    }

    expect(sms.sent).toHaveLength(6);
    expect(await db.notification.count({ where: { status: "sent" } })).toBe(6);
    const rows = await db.notification.findMany({ select: { attempts: true } });
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });
});
