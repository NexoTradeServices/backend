// Feature 5004 -- "On my way"
//
// AC1  Bob's dashboard card carries the button only for a job booked today (scheduled); never another day,
//      a card awaiting his answer, an on-hold or completed job
// AC2  the tap sends the customer one email and one text, in the wording, with no money and no link
// AC3  with a site contact: her own text and email (no offer, no money); the customer's copy says she has been informed
// AC4  after the tap both the card and the job screen carry the sent time in the job's zone
// AC5  a second tap, or a tap from the other place, sends nothing more
// AC6  the tap changes no status; I've arrived still works after it
// AC7  no visit today -> 409; another contractor's job -> 404; nothing sent
// AC8  Mike's job page message list names the rows "On my way"
// AC9  a return visit's own block offers it again and sends again
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
import { contractorDashboardRoutes } from "../src/contractors/dashboard-routes.js";
import { contractorJobRoutes } from "../src/contractors/job-routes.js";
import { devTextsRoutes } from "../src/notifications/dev-texts-routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { jobMessages } from "../src/jobs/messages.js";
import { sentLabelOf } from "../src/contractors/on-my-way.js";
import { todayIn, zonedDateTimeToUtc } from "../src/time/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email-5004", "email");
const ZONE = "Australia/Perth";
const LENA = { name: "Lena Park", phone: "0400 002 050", email: "lena@idelta.com.au" };

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email: address, password: DEV_PASSWORD });
  return cookieHeader(res);
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
  app.use("/api/contractor", contractorDashboardRoutes(db));
  app.use("/api/contractor/jobs", contractorJobRoutes(db));
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

/** Noon on the job's own calendar day, `daysFromToday` away -- "today" whatever the clock says. */
function noon(daysFromToday: number): Date {
  const today = zonedDateTimeToUtc(ZONE, todayIn(ZONE), 12, 0);
  return new Date(today.getTime() + daysFromToday * 24 * 3_600_000);
}

interface Made {
  jobId: string;
  assignmentId: string;
  eventId: string;
}

async function makeVisit(opts: {
  reference: string;
  contractorCode?: string;
  siteContact?: Record<string, string> | null;
  day?: number;
  jobStatus?: "scheduled" | "in_progress" | "on_hold" | "completed" | "assigned";
  assignmentStatus?: "assigned" | "accepted" | "in_progress" | "completed";
}): Promise<Made> {
  const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const contractor = await db.contractor.findUniqueOrThrow({ where: { code: opts.contractorCode ?? "CON-014" }, include: { specialties: true } });
  const specialty = contractor.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("no Plumbing specialty");
  const start = noon(opts.day ?? 0);
  const job = await db.job.create({
    data: {
      reference: opts.reference,
      customerId: sarah.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      siteAddress: { street: "12 Paget Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      ...(opts.siteContact === null ? {} : { siteContact: opts.siteContact ?? LENA }),
      timezone: ZONE,
      description: "The mixer tap leaks.",
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: start,
      status: opts.jobStatus ?? "scheduled",
    },
  });
  const assignment = await db.assignment.create({
    data: {
      jobId: job.id,
      contractorId: contractor.id,
      specialtyId: specialty.id,
      status: opts.assignmentStatus ?? "accepted",
      proposedSlot: start,
      confirmedSlot: start,
      acceptedAt: new Date(),
    },
  });
  const event = await db.calendarEvent.create({
    data: { contractorId: contractor.id, type: "job", jobId: job.id, assignmentId: assignment.id, startTime: start, endTime: new Date(start.getTime() + 3_600_000) },
  });
  return { jobId: job.id, assignmentId: assignment.id, eventId: event.id };
}

const tap = (cookie: string, reference: string) => request(app).post(`/api/contractor/jobs/${reference}/on-my-way`).set("Cookie", cookie).send({});
const view = (cookie: string, reference: string) => request(app).get(`/api/contractor/jobs/${reference}`).set("Cookie", cookie);
const dashboard = async (cookie: string) =>
  ((await request(app).get("/api/contractor/dashboard").set("Cookie", cookie)).body as { jobs: { reference: string; onMyWay: unknown }[] }).jobs;

async function rowsFor(jobId: string) {
  return db.notification.findMany({ where: { jobId, type: "on_my_way" }, orderBy: [{ channel: "asc" }, { recipientType: "asc" }] });
}

interface DevTextBlock {
  jobReference: string;
  step: string;
  texts: { recipientBadge: string; text: string }[];
}
async function onMyWayTexts(reference: string) {
  const res = await request(app).get("/api/dev/texts");
  const blocks = (res.body as { blocks: DevTextBlock[] }).blocks;
  return blocks.filter((b) => b.jobReference === reference && b.step === "on my way").flatMap((b) => b.texts);
}

describe("On my way", () => {
  test("AC1: the dashboard offers it only for a job booked today and scheduled", async () => {
    await makeVisit({ reference: "JOB-5101" });
    await makeVisit({ reference: "JOB-5102", day: 1 });
    await makeVisit({ reference: "JOB-5103", assignmentStatus: "assigned", jobStatus: "assigned" });
    await makeVisit({ reference: "JOB-5104", jobStatus: "on_hold" });
    await makeVisit({ reference: "JOB-5105", jobStatus: "completed", assignmentStatus: "completed" });
    const cookie = await signInCookie("bob@idelta.com.au");
    const jobs = await dashboard(cookie);
    const byRef = Object.fromEntries(jobs.map((j) => [j.reference, j.onMyWay]));
    expect(byRef["JOB-5101"]).toEqual({ sent: false });
    expect(byRef["JOB-5102"]).toBeNull();
    expect(byRef["JOB-5103"]).toBeNull();
    expect(byRef["JOB-5104"]).toBeNull();
    expect(byRef["JOB-5105"]).toBeUndefined(); // a completed job is not on the list at all
  });

  test("AC2: the tap sends Sarah one email and one text, with no money and no link", async () => {
    const made = await makeVisit({ reference: "JOB-5101", siteContact: null });
    const cookie = await signInCookie("bob@idelta.com.au");
    const res = await tap(cookie, "JOB-5101");
    expect(res.status).toBe(200);
    await drainOnce(db);

    const rows = await rowsFor(made.jobId);
    expect(rows.map((r) => `${r.recipientType}:${r.channel}`)).toEqual(["customer:email", "customer:sms"]);
    const mail = email.sent.find((m) => m.to === "sarah@idelta.com.au" && (m.message.subject ?? "") === "On my way - JOB-5101");
    expect(mail).toBeDefined();
    const phone = (await db.platformSettings.findFirstOrThrow()).operatorPhone;
    for (const part of ["Hi Sarah,", "Bob is on the way to 12 Paget Street, Hilton now for your plumbing job JOB-5101.", `To change anything, please ring the office on ${phone}.`]) {
      expect(mail?.message.text).toContain(part);
    }
    expect(mail?.message.text).not.toContain("The site contact has been informed.");
    const body = mail?.message.text ?? "";
    expect(body.split("-- ")[0]).not.toContain("$");
    expect(body.split("-- ")[0]).not.toMatch(/https?:/);

    const sms = (await onMyWayTexts("JOB-5101")).find((t) => t.recipientBadge === "CUSTOMER SMS");
    expect(sms?.text).toContain("Bob is on the way to 12 Paget Street, Hilton now for your job JOB-5101. Questions? Ring " + phone);
    expect(sms?.text.split("\n\n")[0]).not.toContain("$");
  });

  test("AC3: Lena gets her own text and email; Sarah's copy says the site contact has been informed", async () => {
    const made = await makeVisit({ reference: "JOB-5101" });
    const cookie = await signInCookie("bob@idelta.com.au");
    expect((await tap(cookie, "JOB-5101")).status).toBe(200);
    await drainOnce(db);

    const rows = await rowsFor(made.jobId);
    expect(rows.map((r) => `${r.recipientType}:${r.channel}`)).toEqual(["customer:email", "site_contact:email", "customer:sms", "site_contact:sms"]);
    const sarahMail = email.sent.find((m) => m.to === "sarah@idelta.com.au" && (m.message.subject ?? "").startsWith("On my way"));
    expect(sarahMail?.message.text).toContain("The site contact has been informed.");
    const lenaMail = email.sent.find((m) => m.to === "lena@idelta.com.au" && (m.message.subject ?? "") === "On my way - JOB-5101");
    expect(lenaMail?.message.text).toContain("Hi Lena,");
    expect(lenaMail?.message.text).toContain("Bob is on the way to 12 Paget Street, Hilton now for a plumbing job (JOB-5101).");
    expect(lenaMail?.message.text).toContain("If you need anything, please ring the office on");
    for (const body of [lenaMail?.message.text, lenaMail?.message.html]) {
      expect(body).not.toContain("$");
      expect(body).not.toMatch(/https?:|Set a password|Manage your jobs/);
    }
    const lenaSms = (await onMyWayTexts("JOB-5101")).find((t) => t.recipientBadge === "SITE CONTACT SMS");
    expect(lenaSms?.text).toContain("Bob is on the way to 12 Paget Street, Hilton now for a plumbing job (JOB-5101). Questions? Ring ");
    expect(lenaSms?.text).not.toMatch(/\$|https?:/);
  });

  test("AC4: after the tap the card and the job screen carry the sent time in the job's zone", async () => {
    const made = await makeVisit({ reference: "JOB-5101" });
    const cookie = await signInCookie("bob@idelta.com.au");
    expect(((await view(cookie, "JOB-5101")).body as { onMyWay: unknown }).onMyWay).toEqual({ sent: false });
    await tap(cookie, "JOB-5101");
    const row = (await rowsFor(made.jobId))[0];
    const label = sentLabelOf(ZONE, row.createdAt);
    expect(label).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);
    expect(((await view(cookie, "JOB-5101")).body as { onMyWay: unknown }).onMyWay).toEqual({ sent: true, sentLabel: label });
    expect((await dashboard(cookie)).find((j) => j.reference === "JOB-5101")?.onMyWay).toEqual({ sent: true, sentLabel: label });
  });

  test("the sent time reads 7:42am on the Perth wall clock", () => {
    expect(sentLabelOf(ZONE, new Date("2027-03-15T23:42:00.000Z"))).toBe("7:42am");
    expect(sentLabelOf(ZONE, new Date("2027-03-15T07:05:00.000Z"))).toBe("3:05pm");
  });

  test("AC5: a second tap, or a tap from another phone, sends nothing more", async () => {
    const made = await makeVisit({ reference: "JOB-5101" });
    const first = await signInCookie("bob@idelta.com.au");
    const second = await signInCookie("bob@idelta.com.au");
    await Promise.all([tap(first, "JOB-5101"), tap(second, "JOB-5101")]);
    await tap(first, "JOB-5101");
    await drainOnce(db);
    const rows = await rowsFor(made.jobId);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(4);
    expect(email.sent.filter((m) => (m.message.subject ?? "").startsWith("On my way"))).toHaveLength(2);
  });

  test("AC6: the tap changes no status, and I've arrived still works after it", async () => {
    const made = await makeVisit({ reference: "JOB-5101" });
    const cookie = await signInCookie("bob@idelta.com.au");
    const res = await tap(cookie, "JOB-5101");
    expect(res.body).toMatchObject({ canOnSite: true, jobStatus: "scheduled", assignmentStatus: "accepted" });
    expect((await db.job.findUniqueOrThrow({ where: { id: made.jobId } })).status).toBe("scheduled");
    expect((await db.assignment.findUniqueOrThrow({ where: { id: made.assignmentId } })).status).toBe("accepted");
    const arrived = await request(app).post("/api/contractor/jobs/JOB-5101/on-site").set("Cookie", cookie).send({});
    expect(arrived.status).toBe(200);
    expect(arrived.body).toMatchObject({ assignmentStatus: "in_progress", jobStatus: "in_progress", onMyWay: null });
  });

  test("AC7: no visit today -> 409; another contractor's job -> 404; nothing sent", async () => {
    const tomorrow = await makeVisit({ reference: "JOB-5102", day: 1 });
    const bobs = await makeVisit({ reference: "JOB-5101" });
    const bob = await signInCookie("bob@idelta.com.au");
    const dave = await signInCookie("dave@idelta.com.au");
    const refused = await tap(bob, "JOB-5102");
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "There is no visit booked for today." });
    expect((await tap(dave, "JOB-5101")).status).toBe(404);
    expect((await tap(dave, "JOB-9999")).status).toBe(404);
    expect(await rowsFor(tomorrow.jobId)).toHaveLength(0);
    expect(await rowsFor(bobs.jobId)).toHaveLength(0);
  });

  test("AC8: Mike's job page lists the rows as On my way", async () => {
    const made = await makeVisit({ reference: "JOB-5101" });
    const cookie = await signInCookie("bob@idelta.com.au");
    await tap(cookie, "JOB-5101");
    const messages = await jobMessages(db, made.jobId, ZONE);
    const mine = messages.filter((m) => m.what === "On my way");
    expect(mine.length).toBe(4);
  });

  test("AC9: a return visit's own block offers it again and sends again", async () => {
    const made = await makeVisit({ reference: "JOB-5101", siteContact: null });
    const cookie = await signInCookie("bob@idelta.com.au");
    await tap(cookie, "JOB-5101");
    // The first block moves to yesterday; a block for today is booked on the same assignment.
    await db.calendarEvent.update({ where: { id: made.eventId }, data: { startTime: noon(-1), endTime: new Date(noon(-1).getTime() + 3_600_000) } });
    expect(((await view(cookie, "JOB-5101")).body as { onMyWay: unknown }).onMyWay).toBeNull();
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const second = await db.calendarEvent.create({
      data: { contractorId: bob.id, type: "job", jobId: made.jobId, assignmentId: made.assignmentId, startTime: noon(0), endTime: new Date(noon(0).getTime() + 3_600_000) },
    });
    expect(((await view(cookie, "JOB-5101")).body as { onMyWay: unknown }).onMyWay).toEqual({ sent: false });
    await tap(cookie, "JOB-5101");
    const rows = await rowsFor(made.jobId);
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.idempotencyKey.includes(second.id))).toBe(true);
  });
});
