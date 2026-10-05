// Feature 4003 -- accept / decline
//
// AC1  the migration: Assignment.declinedAt / declineNote exist and are empty on every assignment; the seed runs clean
// AC2  Bob's read of JOB-1042: Plumbing, the slot in AWST, 12 Paget Street, Hilton, "Lena Park" (name only - V3)
// AC3  no site contact: the read names the customer, "Sarah Chen"
// AC4  the read carries Sarah's description and her answers
// AC5  the read carries the Instruction notes and none of the General, Complaint or Dispute ones
// AC6  the read carries no money
// AC7  accept: assignment accepted, acceptedAt set, confirmedSlot = proposed, job scheduled
// AC8  accept: the calendar block is still there, on the same assignment
// AC9  (BKLG-027) accept through one link: the other opens "Already answered" (accepted); an answer through it is refused
// AC10 (BKLG-027) decline through one link: the other opens "Already answered" (declined)
// AC11 Sarah's slot-confirmed email and text: Bob, address, day + start AWST, JOB-1042, Plumbing, the rates, the office number; no Track button, no reminder line
// AC12 a Saturday dispatch states the weekend price in Sarah's confirmation
// AC13 with Lena as site contact, Sarah's wording says the site contact has been told, never naming Lena
// AC14 with Lena as site contact, Lena's own text and email: Bob, address, day + start; no price, no link; site_contact rows named "Lena Park"
// AC15 a site contact with no email gets the text only
// AC16 no site contact: no site contact line in Sarah's wording, no site_contact row
// AC17 an accept arriving twice (one after the other, and at once) creates no second set of messages
// AC18 decline with a note: declined, declinedAt + note, job new, block gone
// AC19 decline with no note goes through, declineNote empty
// AC20 the office inbox gets one "Contractor declined" email naming Bob, CON-014, JOB-1042, the slot, the note, a link to the job
// AC21 the queue lists JOB-1042 among the new jobs in its first-come place, badged "Declined by Bob Reilly" with the note
// AC22 once Mike dispatches it again its queue row carries no badge
// AC23 the job page lists Bob's declined booking under Earlier bookings, before and after a fresh dispatch
// AC24 a link opened after its slot started reads "expired" with the job reference and office number; an accept through it is refused
// AC25 a link that does not exist reads "doesn't work" with the office number
// AC26 (frontend e2e: respond.spec.ts) tapping Decline shows the note box; Back sends nothing
// AC27 the Texts sent page shows Lena's slot-confirmed text under JOB-1042
// 3003 AC12 (back half) the respond read carries the customer's photos; none when the job has none
// AC28 the Messages card names the two new types "Slot confirmed" and "Contractor declined"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, setProviders } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { jobRoutes } from "../src/jobs/routes.js";
import { respondRoutes } from "../src/respond/routes.js";
import { sendSlotConfirmed } from "../src/respond/messages.js";
import { devTextsRoutes } from "../src/notifications/dev-texts-routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { CapabilityTokenType, mintCapabilityLink } from "../src/capability-tokens/index.js";
import { formatDollars } from "../src/enquiries/money.js";
import { nextReference } from "../src/db/reference.js";
import { Prisma } from "../src/generated/prisma/client.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

// SMS gets no provider here, same as 4002's and 4008's suites: every text
// falls to the console adapter and is read back through /api/dev/texts.
const email = recordingAdapter("test-email-4003", "email");

const LENA = { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" };
const HILTON = { suburb: "Hilton", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" };
// A Monday and a Saturday comfortably in the future (dispatch.test.ts explains why fixed dates).
const MONDAY = "2027-03-15";
const SATURDAY = "2027-03-20";

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(addr: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: addr, password: DEV_PASSWORD });
  return cookieHeader(res);
}

interface Read {
  state: string;
  jobReference?: string;
  trade?: string;
  slotLabel?: string;
  addressLine?: string;
  contactLine?: string;
  contractorFirstName?: string;
  customerFirstName?: string;
  contactIsSiteContact?: boolean;
  description?: string | null;
  answers?: string[];
  photos?: { fileName: string; thumbnailUrl: string; fullUrl: string }[];
  instructions?: { authorFirstName: string; dateLabel: string; note: string }[];
  answer?: string;
  answeredAtLabel?: string;
  officePhone?: string;
}

const readLink = (token: string) => request(app).get(`/api/respond/${token}`);
const accept = (token: string) => request(app).post(`/api/respond/${token}/accept`).send({});
const decline = (token: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/respond/${token}/decline`).send(body);

/** JOB-1042 as the fixture seed leaves it: dispatched to Bob, Lena as site contact. */
async function job1042(): Promise<{ jobId: string; assignmentId: string; proposedSlot: Date }> {
  const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
  const assignment = await db.assignment.findFirstOrThrow({ where: { jobId: job.id } });
  return { jobId: job.id, assignmentId: assignment.id, proposedSlot: assignment.proposedSlot as Date };
}

/** One more respond link on an assignment -- the way two messages (email, text) carry one each. */
async function link(assignmentId: string, expiresAt?: Date): Promise<string> {
  const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
  const minted = await mintCapabilityLink(db, {
    type: CapabilityTokenType.respond,
    assignmentId,
    expiresAt: (expiresAt ?? (assignment.proposedSlot as Date)).toISOString(),
  });
  return minted.url.split("/a/")[1] ?? "";
}

async function mikeId(): Promise<string> {
  return (await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } })).id;
}

interface DevTextRow {
  recipientBadge: string;
  toName: string | null;
  toNumber: string;
  text: string;
}
interface DevTextBlock {
  jobReference: string;
  step: string;
  texts: DevTextRow[];
}
async function devTexts(): Promise<DevTextBlock[]> {
  const res = await request(app).get("/api/dev/texts");
  expect(res.status).toBe(200);
  return (res.body as { blocks: DevTextBlock[] }).blocks;
}
async function textFor(reference: string, badge: string): Promise<DevTextRow | undefined> {
  const blocks = await devTexts();
  return blocks
    .filter((b) => b.jobReference === reference && b.step === "slot confirmed")
    .flatMap((b) => b.texts)
    .find((t) => t.recipientBadge === badge);
}

function mailTo(address: string, subjectPart: string) {
  return email.sent.find((m) => m.to === address && (m.message.subject ?? "").includes(subjectPart));
}

async function operatorPhone(): Promise<string> {
  return (await db.platformSettings.findFirstOrThrow()).operatorPhone;
}

async function makeNewJob(createdAt?: Date): Promise<{ id: string; reference: string }> {
  const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId: sarah.id,
      serviceTypeId: serviceType.id,
      customerCalloutRate: serviceType.customerCalloutRate,
      customerStandardRate: serviceType.customerStandardRate,
      postcode: HILTON.postcode,
      serviceLocation: { suburb: HILTON.suburb, state: "WA", country: "AU", lat: HILTON.lat, lng: HILTON.lng, placeId: HILTON.placeId },
      timezone: "Australia/Perth",
      description: "A test job.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: new Date(`${MONDAY}T00:00:00.000Z`),
      status: "new",
      ...(createdAt ? { createdAt } : {}),
    },
  });
  return { id: job.id, reference: job.reference };
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  registerProvider(email);
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/jobs", jobRoutes(db));
  app.use("/api/respond", respondRoutes(db));
  app.use("/api/dev", devTextsRoutes(db));
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

afterEach(async () => {
  await resetReferenceSequences(db);
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe("AC1 -- the migration", () => {
  test("AC1: Assignment.declinedAt and .declineNote exist and are empty on every assignment the seed made", async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Assignment' AND column_name IN ('declinedAt', 'declineNote')`;
    expect(columns.map((c) => c.column_name).sort()).toEqual(["declineNote", "declinedAt"]);

    const assignments = await db.assignment.findMany();
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment.declinedAt).toBeNull();
      expect(assignment.declineNote).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The read (AC2-AC6)
// ---------------------------------------------------------------------------

describe("the respond read", () => {
  test("AC2: Bob's read of JOB-1042 carries Plumbing, the slot in AWST, the address and Lena as the site contact", async () => {
    const { assignmentId } = await job1042();
    const res = await readLink(await link(assignmentId));
    expect(res.status).toBe(200);
    const body = res.body as Read;
    expect(body).toMatchObject({
      state: "open",
      jobReference: "JOB-1042",
      trade: "Plumbing",
      addressLine: "12 Paget Street, Hilton",
      contactLine: "Lena Park",
      contactIsSiteContact: true,
      contractorFirstName: "Bob",
      customerFirstName: "Sarah",
    });
    expect(body.slotLabel).toMatch(/^Thu \d\d\/\d\d, 8:00am AWST$/);
    // V3: the name only -- no phone and no email of the site contact anywhere in the read.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("0400 002 050");
    expect(raw).not.toContain("lena@idelta.com.au");
  });

  test("3003 AC12: the read carries Sarah's photos, oldest first; a job with none carries an empty list", async () => {
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "test-cloud");
    try {
      const { jobId, assignmentId } = await job1042();
      const token = await link(assignmentId);
      expect(((await readLink(token)).body as Read).photos).toEqual([]);

      await db.attachment.create({
        data: {
          jobId,
          uploadedByRole: "customer",
          storageKey: "tradeservice/enquiry-photos/tap-aaa",
          fileName: "leaking mixer tap.jpg",
        },
      });
      const body = (await readLink(token)).body as Read;
      expect(body.photos).toEqual([
        {
          fileName: "leaking mixer tap.jpg",
          thumbnailUrl:
            "https://res.cloudinary.com/test-cloud/image/upload/c_fill,g_auto,w_240,h_240,f_auto,q_auto/tradeservice/enquiry-photos/tap-aaa",
          fullUrl: "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto/tradeservice/enquiry-photos/tap-aaa",
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("AC3: a job with no site contact names the customer", async () => {
    const { jobId, assignmentId } = await job1042();
    await db.job.update({ where: { id: jobId }, data: { siteContact: Prisma.DbNull } });
    const body = (await readLink(await link(assignmentId))).body as Read;
    expect(body.contactLine).toBe("Sarah Chen");
    expect(body.contactIsSiteContact).toBe(false);
  });

  test("AC4: the read carries Sarah's description and her answers", async () => {
    const { jobId, assignmentId } = await job1042();
    await db.job.update({
      where: { id: jobId },
      data: {
        description: "Mixer tap drips all night under the kitchen sink.",
        selectedOptions: ["Where is the leak?: Kitchen tap", "Is the water off?: Yes"],
      },
    });
    const body = (await readLink(await link(assignmentId))).body as Read;
    expect(body.description).toBe("Mixer tap drips all night under the kitchen sink.");
    expect(body.answers).toEqual(["Where is the leak?: Kitchen tap", "Is the water off?: Yes"]);
  });

  test("AC5: the read carries the Instruction notes and none of the General, Complaint or Dispute ones", async () => {
    const { jobId, assignmentId } = await job1042();
    const operatorId = await mikeId();
    const at = (hour: number): string => new Date(Date.UTC(2026, 9, 3, hour, 0, 0)).toISOString();
    await db.job.update({
      where: { id: jobId },
      data: {
        operatorNotes: [
          { id: "n1", at: at(1), operatorId, type: "instruction", note: "Dog in the back yard - use the side gate." },
          { id: "n2", at: at(2), operatorId, type: "general", note: "GENERAL-ONLY note" },
          { id: "n3", at: at(3), operatorId, type: "complaint", note: "COMPLAINT-ONLY note" },
          { id: "n4", at: at(4), operatorId, type: "dispute", note: "DISPUTE-ONLY note" },
        ],
      },
    });
    const res = await readLink(await link(assignmentId));
    const body = res.body as Read;
    expect(body.instructions).toHaveLength(1);
    expect(body.instructions?.[0]).toMatchObject({ authorFirstName: "Mike", note: "Dog in the back yard - use the side gate." });
    expect(body.instructions?.[0]?.dateLabel).toMatch(/\d\d\/\d\d\/26/);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("GENERAL-ONLY");
    expect(raw).not.toContain("COMPLAINT-ONLY");
    expect(raw).not.toContain("DISPUTE-ONLY");
  });

  test("AC6: the read carries no money -- no rate, price or pay figure, and no dollar sign", async () => {
    const { assignmentId } = await job1042();
    const res = await readLink(await link(assignmentId));
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk(res.body);
    expect(keys.filter((key) => /rate|price|pay|cost|total|amount|money|dollar|cents/i.test(key))).toEqual([]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("$");
    expect(raw).not.toContain("25000");
    expect(raw).not.toContain("18000");
  });

  test("reading never burns the link", async () => {
    const { assignmentId } = await job1042();
    const token = await link(assignmentId);
    expect((await readLink(token)).status).toBe(200);
    expect((await readLink(token)).status).toBe(200);
    const stored = await db.capabilityToken.findFirstOrThrow({ where: { assignmentId, type: "respond" } });
    expect(stored.usedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Accept (AC7-AC9, AC17)
// ---------------------------------------------------------------------------

describe("accept", () => {
  test("AC7: Bob accepts -> accepted, acceptedAt set, confirmedSlot = the proposed slot, JOB-1042 scheduled", async () => {
    const { jobId, assignmentId, proposedSlot } = await job1042();
    const res = await accept(await link(assignmentId));
    expect(res.status).toBe(200);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment.status).toBe("accepted");
    expect(assignment.acceptedAt).not.toBeNull();
    expect(assignment.confirmedSlot?.toISOString()).toBe(proposedSlot.toISOString());
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("scheduled");
  });

  test("AC8: after Bob accepts, the calendar block is still there, on the same assignment", async () => {
    const { assignmentId } = await job1042();
    const before = await db.calendarEvent.findMany({ where: { assignmentId } });
    expect(before).toHaveLength(1);
    await accept(await link(assignmentId));
    const after = await db.calendarEvent.findMany({ where: { assignmentId } });
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
  });

  test("AC9 (BKLG-027): accepted through the email link -> the text link opens as Already answered, naming the accept; answers through it are refused", async () => {
    const { assignmentId } = await job1042();
    const emailLink = await link(assignmentId);
    const textLink = await link(assignmentId);
    expect((await accept(emailLink)).status).toBe(200);

    const read = await readLink(textLink);
    expect(read.status).toBe(410);
    const body = read.body as Read;
    expect(body).toMatchObject({ state: "answered", answer: "accepted", jobReference: "JOB-1042" });
    expect(body.answeredAtLabel).toMatch(/AWST/);

    const acceptAgain = await accept(textLink);
    expect(acceptAgain.status).toBe(410);
    const declineAfter = await decline(textLink, { note: "changed my mind" });
    expect(declineAfter.status).toBe(410);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment.status).toBe("accepted");
    expect(assignment.declinedAt).toBeNull();
    // Burned, never deleted: both rows are still there.
    expect(await db.capabilityToken.count({ where: { assignmentId, type: "respond", usedAt: { not: null } } })).toBe(2);
  });

  test("AC17: Bob's accept arriving twice -- one after the other, and at the same instant -- creates no second set of messages", async () => {
    const { jobId, assignmentId } = await job1042();
    const token = await link(assignmentId);
    const first = await accept(token);
    const second = await accept(token);
    expect([first.status, second.status]).toEqual([200, 410]);
    // Customer email + text, Lena's text + email.
    expect(await db.notification.count({ where: { jobId, type: "slot_confirmed" } })).toBe(4);

    // The asker itself is idempotent too: asking again lands on the same rows.
    await sendSlotConfirmed(db, {
      assignmentId,
      jobId,
      jobReference: "JOB-1042",
      jobTimezone: "Australia/Perth",
      trade: "Plumbing",
      contractorName: "Bob Reilly",
      contractorCode: "CON-014",
      proposedSlot: new Date(),
      slotLabel: "",
      note: null,
    });
    expect(await db.notification.count({ where: { jobId, type: "slot_confirmed" } })).toBe(4);

  });

  test("AC17: two taps at the same instant -- one answer wins, one is refused, one set of messages", async () => {
    const { jobId, assignmentId } = await job1042();
    const token = await link(assignmentId);
    const results = await Promise.all([accept(token), accept(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(await db.notification.count({ where: { jobId, type: "slot_confirmed" } })).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The slot confirmation (AC11-AC16, AC27, AC28)
// ---------------------------------------------------------------------------

describe("the slot confirmation", () => {
  test("AC11: Sarah's email and text carry Bob, the address, day and start in AWST, the job, the trade, the rates and the office number -- no Track button, no reminder line", async () => {
    const { assignmentId } = await job1042();
    await accept(await link(assignmentId));
    await drainOnce(db);
    const office = await operatorPhone();

    const mail = mailTo("sarah@idelta.com.au", "Booked");
    expect(mail).toBeDefined();
    const text = mail?.message.text ?? "";
    const html = mail?.message.html ?? "";
    for (const part of ["Bob", "12 Paget Street, Hilton", "JOB-1042", "Plumbing", "$250 call-out including the first hour, then $180 an hour", office]) {
      expect(text).toContain(part);
    }
    expect(text).toMatch(/Thu \d\d\/\d\d, 8:00am AWST/);
    expect(html).toContain("$250 call-out including the first hour, then $180 an hour");
    for (const body of [text, html]) {
      expect(body).not.toMatch(/track/i);
      expect(body).not.toMatch(/remind/i);
      expect(body).not.toContain("http");
    }

    const sms = await textFor("JOB-1042", "CUSTOMER SMS");
    expect(sms).toBeDefined();
    for (const part of ["Bob", "12 Paget Street, Hilton", "JOB-1042", "Plumbing", "$250 call-out including the first hour, then $180 an hour", office]) {
      expect(sms?.text).toContain(part);
    }
    expect(sms?.text).toMatch(/Thu \d\d\/\d\d, 8:00am AWST/);
    expect(sms?.text).not.toMatch(/track|remind|http/i);
  });

  test("AC12: a job dispatched for a Saturday states the weekend price -- the frozen card times the weekend multiplier", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const job = await makeNewJob();
    const dispatched = await request(app)
      .post(`/api/jobs/${job.reference}/dispatch`)
      .set("Cookie", mike)
      .send({ contractorCode: "CON-014", date: SATURDAY, startMinutes: 480, holdMinutes: 60, emergency: false });
    expect(dispatched.status).toBe(201);
    const assignment = await db.assignment.findFirstOrThrow({ where: { jobId: job.id } });
    await accept(await link(assignment.id));
    await drainOnce(db);

    const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const multipliers = serviceType.serviceLevelMultipliers as { normal: number; weekend: number };
    expect(multipliers.weekend).not.toBe(multipliers.normal);
    const callout = formatDollars(Math.round(serviceType.customerCalloutRate * multipliers.weekend));
    const standard = formatDollars(Math.round(serviceType.customerStandardRate * multipliers.weekend));

    const mail = mailTo("sarah@idelta.com.au", job.reference);
    expect(mail?.message.text).toContain(`${callout} call-out including the first hour, then ${standard} an hour`);
    expect(mail?.message.text).not.toContain("$250");
  });

  test("AC13: with Lena as site contact, Sarah's wording says the site contact has been told and never names Lena", async () => {
    const { assignmentId } = await job1042();
    await accept(await link(assignmentId));
    await drainOnce(db);
    const mail = mailTo("sarah@idelta.com.au", "Booked");
    expect(mail?.message.text).toContain("The site contact has been told.");
    expect(mail?.message.html).toContain("The site contact has been told.");
    const sms = await textFor("JOB-1042", "CUSTOMER SMS");
    expect(sms?.text).toContain("The site contact has been told.");
    for (const body of [mail?.message.text, mail?.message.html, sms?.text]) {
      expect(body).not.toContain("Lena");
      expect(body).not.toContain("0400 002 050");
    }
  });

  test("AC14: Lena gets a text and an email in her own wording -- Bob, the address, the day and start, no price, no link; both rows site_contact named Lena Park", async () => {
    const { jobId, assignmentId } = await job1042();
    await accept(await link(assignmentId));
    await drainOnce(db);

    const mail = mailTo("lena@idelta.com.au", "will be at");
    expect(mail).toBeDefined();
    const sms = await textFor("JOB-1042", "SITE CONTACT SMS");
    expect(sms).toBeDefined();
    expect(sms?.toName).toBe("Lena Park");
    expect(sms?.toNumber).toBe("0400 002 050");
    for (const body of [mail?.message.text ?? "", mail?.message.html ?? "", sms?.text ?? ""]) {
      expect(body).toContain("Bob");
      expect(body).toContain("12 Paget Street, Hilton");
      expect(body).toMatch(/Thu \d\d\/\d\d, 8:00am AWST/);
      expect(body).not.toContain("$");
      expect(body).not.toMatch(/http|track/i);
    }
    expect(mail?.message.text).toContain("Hi Lena,");
    expect(mail?.message.text).not.toContain("Sarah");

    const rows = await db.notification.findMany({ where: { jobId, type: "slot_confirmed", recipientType: "site_contact" } });
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
    for (const row of rows) {
      expect(row.recipientId).toBe(jobId);
      expect((row.context as { recipientName?: string }).recipientName).toBe("Lena Park");
    }
  });

  test("AC15: a site contact who gave no email gets the text only -- no email row", async () => {
    const { jobId, assignmentId } = await job1042();
    await db.job.update({ where: { id: jobId }, data: { siteContact: { name: LENA.name, phone: LENA.phone } } });
    await accept(await link(assignmentId));
    await drainOnce(db);
    const rows = await db.notification.findMany({ where: { jobId, type: "slot_confirmed", recipientType: "site_contact" } });
    expect(rows.map((r) => r.channel)).toEqual(["sms"]);
    expect(await textFor("JOB-1042", "SITE CONTACT SMS")).toBeDefined();
  });

  test("AC16: with no site contact, Sarah's wording has no site contact line and no site_contact row is made", async () => {
    const { jobId, assignmentId } = await job1042();
    await db.job.update({ where: { id: jobId }, data: { siteContact: Prisma.DbNull } });
    await accept(await link(assignmentId));
    await drainOnce(db);
    const mail = mailTo("sarah@idelta.com.au", "Booked");
    expect(mail).toBeDefined();
    expect(mail?.message.text).not.toMatch(/site contact/i);
    expect(mail?.message.html).not.toMatch(/site contact/i);
    const sms = await textFor("JOB-1042", "CUSTOMER SMS");
    expect(sms?.text).not.toMatch(/site contact/i);
    expect(await db.notification.count({ where: { jobId, recipientType: "site_contact" } })).toBe(0);
  });

  test("AC27: the Texts sent page shows Lena's slot-confirmed text under JOB-1042", async () => {
    const { assignmentId } = await job1042();
    await accept(await link(assignmentId));
    await drainOnce(db);
    const blocks = await devTexts();
    const block = blocks.find((b) => b.jobReference === "JOB-1042" && b.step === "slot confirmed");
    expect(block).toBeDefined();
    const lena = block?.texts.find((t) => t.recipientBadge === "SITE CONTACT SMS");
    expect(lena).toMatchObject({ toName: "Lena Park", toNumber: "0400 002 050" });
    expect(lena?.text).toContain("Bob");
    // Sarah's text sits in the same block.
    expect(block?.texts.some((t) => t.recipientBadge === "CUSTOMER SMS")).toBe(true);
  });

  test("AC28: the Messages card names the two new types \"Slot confirmed\" and \"Contractor declined\"", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const { assignmentId } = await job1042();
    await accept(await link(assignmentId));
    await drainOnce(db);
    let detail = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      messages: { to: string; what: string; channel: string }[];
    };
    const confirmed = detail.messages.filter((m) => m.what === "Slot confirmed");
    expect(confirmed).toHaveLength(4);
    expect(confirmed.filter((m) => m.to === "Lena Park").map((m) => m.channel).sort()).toEqual(["Email", "Text"]);
    expect(confirmed.filter((m) => m.to === "Sarah Chen")).toHaveLength(2);

    // A second booking on the same job, declined, adds the other name.
    const job = await db.job.findUniqueOrThrow({ where: { reference: "JOB-1042" } });
    await db.assignment.update({ where: { id: assignmentId }, data: { status: "cancelled" } });
    await db.job.update({ where: { id: job.id }, data: { status: "new" } });
    const fresh = await db.assignment.create({
      data: {
        jobId: job.id,
        contractorId: (await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } })).id,
        specialtyId: (await db.contractorSpecialty.findFirstOrThrow({ where: { contractor: { code: "CON-014" }, trade: "Plumbing" } })).id,
        proposedSlot: new Date(Date.now() + 3 * 3_600_000),
      },
    });
    await db.job.update({ where: { id: job.id }, data: { status: "assigned" } });
    await decline(await link(fresh.id));
    await drainOnce(db);
    detail = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as typeof detail;
    expect(detail.messages.find((m) => m.what === "Contractor declined")).toMatchObject({ to: "Office inbox", channel: "Email" });
  });
});

// ---------------------------------------------------------------------------
// Decline (AC10, AC18-AC23)
// ---------------------------------------------------------------------------

const KALAMUNDA_NOTE = "Still on another job in Kalamunda that morning";

describe("decline", () => {
  test("AC10 (BKLG-027): declined through one link -> the other opens as Already answered, naming the decline", async () => {
    const { assignmentId } = await job1042();
    const emailLink = await link(assignmentId);
    const textLink = await link(assignmentId);
    expect((await decline(emailLink)).status).toBe(200);
    const read = await readLink(textLink);
    expect(read.status).toBe(410);
    expect(read.body as Read).toMatchObject({ state: "answered", answer: "declined", jobReference: "JOB-1042" });
    expect((await accept(textLink)).status).toBe(410);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("declined");
  });

  test("AC18: Bob declines with a note -> declined with declinedAt and the note, JOB-1042 is new, the calendar block is gone", async () => {
    const { jobId, assignmentId } = await job1042();
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(1);
    const res = await decline(await link(assignmentId), { note: KALAMUNDA_NOTE });
    expect(res.status).toBe(200);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment.status).toBe("declined");
    expect(assignment.declinedAt).not.toBeNull();
    expect(assignment.declineNote).toBe(KALAMUNDA_NOTE);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("new");
    expect(await db.calendarEvent.count({ where: { assignmentId } })).toBe(0);
  });

  test("AC19: no note, a blank note -> the decline goes through, declineNote empty; a 501-character note is refused and nothing changes", async () => {
    const { assignmentId } = await job1042();
    const tooLong = await decline(await link(assignmentId), { note: "x".repeat(501) });
    expect(tooLong.status).toBe(400);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("assigned");

    const blank = await decline(await link(assignmentId), { note: "   " });
    expect(blank.status).toBe(200);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment.status).toBe("declined");
    expect(assignment.declineNote).toBeNull();
  });

  test("AC19: no note at all", async () => {
    const { assignmentId } = await job1042();
    expect((await decline(await link(assignmentId))).status).toBe(200);
    const assignment = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(assignment.status).toBe("declined");
    expect(assignment.declineNote).toBeNull();
  });

  test("AC20: the office inbox gets one \"Contractor declined\" email naming Bob Reilly, CON-014, JOB-1042, the slot, his note and a link to the job", async () => {
    const { jobId, assignmentId } = await job1042();
    await decline(await link(assignmentId), { note: KALAMUNDA_NOTE });
    await drainOnce(db);
    const ops = (await db.platformSettings.findFirstOrThrow()).operatorEmail;
    const mails = email.sent.filter((m) => m.to === ops && (m.message.subject ?? "").includes("Declined"));
    expect(mails).toHaveLength(1);
    const text = mails[0]?.message.text ?? "";
    for (const part of ["Bob Reilly", "CON-014", "JOB-1042", KALAMUNDA_NOTE, "/ops/jobs/JOB-1042"]) {
      expect(text).toContain(part);
    }
    expect(text).toMatch(/Thu \d\d\/\d\d, 8:00am AWST/);
    expect(mails[0]?.message.html).toContain('href="');
    expect(await db.notification.count({ where: { jobId, type: "contractor_declined" } })).toBe(1);
    // Sarah is only ever told a confirmed slot.
    expect(email.sent.some((m) => m.to === "sarah@idelta.com.au")).toBe(false);
  });

  test("AC20: with no note the email says so", async () => {
    const { assignmentId } = await job1042();
    await decline(await link(assignmentId));
    await drainOnce(db);
    const ops = (await db.platformSettings.findFirstOrThrow()).operatorEmail;
    const mail = email.sent.find((m) => m.to === ops && (m.message.subject ?? "").includes("Declined"));
    expect(mail?.message.text).toContain("He gave no note.");
  });

  test("AC21: the queue lists JOB-1042 among the new jobs in its place by when the enquiry arrived, badged with who declined and the note", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const { jobId, assignmentId } = await job1042();
    const sarahJob = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    const earlier = await makeNewJob(new Date(sarahJob.createdAt.getTime() - 3_600_000));
    const later = await makeNewJob(new Date(sarahJob.createdAt.getTime() + 3_600_000));

    await decline(await link(assignmentId), { note: KALAMUNDA_NOTE });

    const res = await request(app).get("/api/jobs").query({ status: "new" }).set("Cookie", mike);
    const rows = (res.body as { rows: { reference: string; declined: { by: string; note: string | null } | null }[] }).rows;
    expect(rows.map((r) => r.reference)).toEqual([earlier.reference, "JOB-1042", later.reference]);
    expect(rows.find((r) => r.reference === "JOB-1042")?.declined).toEqual({ by: "Bob Reilly", note: KALAMUNDA_NOTE });
    expect(rows.find((r) => r.reference === earlier.reference)?.declined).toBeNull();
  });

  test("AC22: once Mike dispatches JOB-1042 again, its queue row carries no badge", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const { assignmentId } = await job1042();
    await decline(await link(assignmentId), { note: KALAMUNDA_NOTE });

    const redo = await request(app)
      .post("/api/jobs/JOB-1042/dispatch")
      .set("Cookie", mike)
      .send({ contractorCode: "CON-014", date: MONDAY, startMinutes: 480, holdMinutes: 60, emergency: false });
    expect(redo.status).toBe(201);

    const res = await request(app).get("/api/jobs").query({ q: "JOB-1042" }).set("Cookie", mike);
    const row = (res.body as { rows: { reference: string; status: string; declined: unknown }[] }).rows[0];
    expect(row).toMatchObject({ reference: "JOB-1042", status: "assigned", declined: null });
  });

  test("AC23: the job page lists Bob's declined booking under Earlier bookings -- before and after a fresh dispatch", async () => {
    const mike = await signInCookie("mike@idelta.com.au");
    const { assignmentId, proposedSlot } = await job1042();
    expect(((await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as { earlierBookings: unknown[] }).earlierBookings).toEqual([]);

    await decline(await link(assignmentId), { note: KALAMUNDA_NOTE });
    interface Earlier {
      contractorName: string;
      contractorCode: string;
      what: string;
      whenLabel: string;
      slotLabel: string | null;
      note: string | null;
    }
    const before = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as { earlierBookings: Earlier[] };
    expect(before.earlierBookings).toHaveLength(1);
    expect(before.earlierBookings[0]).toMatchObject({
      contractorName: "Bob Reilly",
      contractorCode: "CON-014",
      what: "Declined",
      note: KALAMUNDA_NOTE,
    });
    expect(before.earlierBookings[0]?.whenLabel).toMatch(/AWST/);
    expect(before.earlierBookings[0]?.slotLabel).toMatch(/Thu \d\d\/\d\d, 8:00am AWST/);
    expect(proposedSlot.getTime()).toBeGreaterThan(0);

    const redo = await request(app)
      .post("/api/jobs/JOB-1042/dispatch")
      .set("Cookie", mike)
      .send({ contractorCode: "CON-014", date: MONDAY, startMinutes: 480, holdMinutes: 60, emergency: false });
    expect(redo.status).toBe(201);
    const after = (await request(app).get("/api/jobs/JOB-1042").set("Cookie", mike)).body as {
      earlierBookings: Earlier[];
      contractor: { code: string } | null;
    };
    // Bob again, a fresh booking in play: the declined one is listed, the live one is not.
    expect(after.contractor?.code).toBe("CON-014");
    expect(after.earlierBookings).toHaveLength(1);
    expect(after.earlierBookings[0]).toMatchObject({ contractorCode: "CON-014", note: KALAMUNDA_NOTE });
  });
});

// ---------------------------------------------------------------------------
// Dead links (AC24, AC25)
// ---------------------------------------------------------------------------

describe("dead links", () => {
  test("AC24: a link opened after its slot has started reads expired with the job reference and the office number; an accept through it is refused", async () => {
    const { assignmentId } = await job1042();
    const token = await link(assignmentId, new Date(Date.now() - 1000));
    const read = await readLink(token);
    expect(read.status).toBe(410);
    expect(read.body as Read).toEqual({ state: "expired", jobReference: "JOB-1042", officePhone: await operatorPhone() });

    expect((await accept(token)).status).toBe(410);
    expect((await decline(token)).status).toBe(410);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("assigned");
  });

  test("AC25: a link that does not exist reads \"doesn't work\" with the office number", async () => {
    const read = await readLink("no-such-token-at-all");
    expect(read.status).toBe(404);
    expect(read.body as Read).toEqual({ state: "unknown", officePhone: await operatorPhone() });
    expect((await accept("no-such-token-at-all")).status).toBe(404);
  });

  test("AC25: a token of another type does not open the respond page", async () => {
    const { jobId } = await job1042();
    const minted = await mintCapabilityLink(db, { type: CapabilityTokenType.track, jobId });
    const read = await readLink(minted.url.split("/track/")[1] ?? "");
    expect(read.status).toBe(404);
    expect((read.body as Read).state).toBe("unknown");
  });
});
