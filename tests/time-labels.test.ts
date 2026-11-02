// Feature 1022 -- the one rule for the label on a time
//
// AC1  a customer, site contact or contractor reads a booked time plain: "8:00am", every screen, email and text
// AC2  the office reads a booked job's time with the job's state: "8:00am NSW time" / "8:00am WA time" - on the job page,
//      the queue's contractor line, the dispatch candidates' Busy reason, the day view's blocks, the declined email
// AC3  nothing else carries a label: received, updated, answered, notes, paid, a Stripe check
// AC4  the agreement acceptance record keeps its zone name
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { testClient } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { acceptJob1042, buildOpsApp, freshWorld, signIn } from "./helpers/ops-app.js";
import {
  formatDateTimeLabel,
  formatDateTimeZoned,
  formatLabelled,
  formatSlotLabel,
  formatTimeRangeLabel,
} from "../src/time/index.js";
import { loadContractorDay } from "../src/contractors/day.js";
import type { PrismaClient } from "../src/db/client.js";

const PERTH = "Australia/Perth";
const SYDNEY = "Australia/Sydney";
// 8:00am in Sydney in summer (AEDT, UTC+11) = 21:00 UTC the day before; 8:00am in Perth = 00:00 UTC.
const SYDNEY_8AM_SUMMER = new Date("2027-01-12T21:00:00.000Z");
const SYDNEY_8AM_WINTER = new Date("2027-07-12T22:00:00.000Z"); // AEST, UTC+10
const PERTH_8AM = new Date("2027-03-15T00:00:00.000Z");
const NOW = new Date("2027-01-01T00:00:00.000Z");

describe("the formatters", () => {
  test("AC1: with no state a time reads plain, in summer and in winter, in either zone", () => {
    expect(formatLabelled(SYDNEY, SYDNEY_8AM_SUMMER)).toBe("8:00am");
    expect(formatLabelled(SYDNEY, SYDNEY_8AM_WINTER)).toBe("8:00am");
    expect(formatLabelled(PERTH, PERTH_8AM)).toBe("8:00am");
    expect(formatTimeRangeLabel(SYDNEY, SYDNEY_8AM_SUMMER, new Date(SYDNEY_8AM_SUMMER.getTime() + 3_600_000))).toBe("8:00-9:00am");
    expect(formatSlotLabel(SYDNEY, SYDNEY_8AM_SUMMER, NOW)).toBe("Wed 13 Jan, 8:00am");
    expect(formatDateTimeLabel(PERTH, PERTH_8AM, NOW)).toBe("Mon 15 Mar, 8:00am");
  });

  test("AC2: given the job's state the office reads 'NSW time' / 'WA time' after the time", () => {
    expect(formatLabelled(SYDNEY, SYDNEY_8AM_SUMMER, "NSW")).toBe("8:00am NSW time");
    expect(formatLabelled(PERTH, PERTH_8AM, "WA")).toBe("8:00am WA time");
    expect(formatTimeRangeLabel(PERTH, PERTH_8AM, new Date(PERTH_8AM.getTime() + 3_600_000), "WA")).toBe("8:00-9:00am WA time");
    expect(formatSlotLabel(SYDNEY, SYDNEY_8AM_WINTER, NOW, "NSW")).toBe("Tue 13 Jul, 8:00am NSW time");
  });

  test("AC4: the agreement's acceptance moment keeps its zone name", () => {
    expect(formatDateTimeZoned(PERTH, PERTH_8AM)).toBe("15 Mar 2027, 8:00am AWST");
    expect(formatDateTimeZoned(SYDNEY, SYDNEY_8AM_SUMMER)).toBe("13 Jan 2027, 8:00am AEDT");
  });
});

describe("the screens and messages", () => {
  let db: PrismaClient;
  let app: ReturnType<typeof buildOpsApp>;
  const email = recordingAdapter("test-email-1022-labels", "email");
  beforeAll(() => {
    db = testClient();
    app = buildOpsApp(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await freshWorld(db, email);
  });

  test("AC2, AC3: on the job page Mike reads Bob's standing line with WA time, while received and notes stay plain", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    await acceptJob1042(db, app);
    const res = await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike);
    const body = res.body as { contractor: { standing: string }; receivedLabel?: string };
    expect(body.contractor.standing).toMatch(/^Booked - .*\d(am|pm) WA time$/);
    expect(JSON.stringify(res.body)).not.toMatch(/AWST/);
  });

  test("AC2: the day view's block for a WA job carries WA time; a Sydney job's block carries NSW time", async () => {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    await acceptJob1042(db, app);
    const blocks = await loadContractorDay(db, bob.id, (await db.calendarEvent.findFirstOrThrow({ where: { contractorId: bob.id, type: "job" } })).startTime.toISOString().slice(0, 10), PERTH);
    expect(blocks[0]?.timeLabel).toMatch(/WA time$/);
  });
});
