// Feature 5001 -- the contractor's job screen and Complete
//
// AC1  own accepted job opens; a job still waiting for his answer, a stranger's
//      job and an unknown reference answer not found
// AC2  slot, site address, ask-for NAME (never a phone), what the customer said,
//      Instruction notes only
// AC3  On site: accepted -> in progress (assignment and job); a second tap changes nothing
// AC4  two time entries, notes and a part save and reread; finish before start is refused on that row
// AC6  parts over the cap IN TOTAL are refused on the price of the line that tips it over; a part with no receipt is
//      refused; a receipt is an Attachment on the job and his assignment;
//      signing lives in its own folder, with its own key check, 503 when not set up
// AC7  Complete with no entry / no notes is refused on that field; otherwise
//      completed, billedHours and completedAt stored, nothing sent
// AC8  after Complete Save, Complete, On site and receipts are refused
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { contractorDashboardRoutes } from "../src/contractors/dashboard-routes.js";
import { contractorJobRoutes, type ContractorJobView } from "../src/contractors/job-routes.js";
import { ENQUIRY_PHOTO_FOLDER, RECEIPT_FOLDER, isEnquiryPhotoKey, isReceiptKey, type CloudinaryConfig } from "../src/photos/cloudinary.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;
let configured: CloudinaryConfig | null;

const CONFIG: CloudinaryConfig = {
  cloudName: "test-cloud",
  apiKey: "123456789012345",
  apiSecret: "test-only-api-secret-value",
  uploadPreset: "tradeservice-enquiry-photos",
};

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
  app = express();
  app.use("/api/auth", contractorLoginRoutes(auth, db));
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/contractor", contractorDashboardRoutes(db));
  app.use("/api/contractor/jobs", contractorJobRoutes(db, { cloudinaryConfig: () => configured }));
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  configured = CONFIG;
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
});

/**
 * Sarah's leaking-tap job in Hilton with Lena Park as site contact, one
 * Instruction note and one General note, accepted by Bob.
 */
async function acceptedJob(reference = "JOB-5001"): Promise<{ jobId: string; assignmentId: string }> {
  const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
  const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("fixture Bob has no Plumbing specialty");
  const slot = new Date(Date.UTC(2026, 9, 7, 0, 0));
  const job = await db.job.create({
    data: {
      reference,
      customerId: sarah.id,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      siteAddress: { street: "5 Carrington Street", suburb: "Hilton", state: "WA", country: "AU", postcode: "6163", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      siteContact: { name: "Lena Park", phone: "0400 111 222" },
      timezone: "Australia/Perth",
      description: "The mixer tap in the kitchen leaks.",
      selectedOptions: ["Where is the leak?: Kitchen tap"],
      source: "web",
      preferredWindow: "morning",
      preferredDate: slot,
      status: "scheduled",
      operatorNotes: [
        { id: "n1", at: "2026-10-05T01:00:00.000Z", operatorId: mike.id, type: "instruction", note: "Side gate code 4471" },
        { id: "n2", at: "2026-10-05T02:00:00.000Z", operatorId: mike.id, type: "general", note: "Customer pays by transfer" },
      ],
    },
  });
  const assignment = await db.assignment.create({
    data: {
      jobId: job.id,
      contractorId: bob.id,
      specialtyId: specialty.id,
      status: "accepted",
      proposedSlot: slot,
      confirmedSlot: slot,
      acceptedAt: new Date(),
    },
  });
  return { jobId: job.id, assignmentId: assignment.id };
}

async function receiptFor(assignmentId: string, jobId: string): Promise<string> {
  const row = await db.attachment.create({
    data: { jobId, assignmentId, uploadedByRole: "contractor", storageKey: `${RECEIPT_FOLDER}/abc123`, fileName: "receipt.jpg" },
  });
  return row.id;
}

const ENTRIES = [
  { date: "2026-10-07", start: "08:07", end: "11:05", note: "" },
  { date: "2026-10-09", start: "09:00", end: "09:20", note: "Back for the washer" },
];

async function get(cookie: string, reference: string): Promise<request.Response> {
  return request(app).get(`/api/contractor/jobs/${reference}`).set("Cookie", cookie);
}

async function view(cookie: string, reference: string): Promise<ContractorJobView> {
  const res = await get(cookie, reference);
  expect(res.status).toBe(200);
  return res.body as ContractorJobView;
}

describe("AC1 -- whose job opens", () => {
  test("AC1: Bob opens his accepted job; a job still waiting for his answer, Dave opening Bob's job, and an unknown reference are not found", async () => {
    await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    expect((await get(bob, "JOB-5001")).status).toBe(200);
    // JOB-1042 is Bob's but still `assigned`: answered from the link, not opened here.
    expect((await get(bob, "JOB-1042")).status).toBe(404);
    expect((await get(bob, "JOB-0000")).status).toBe(404);
    const dave = await signInCookie("dave@idelta.com.au");
    expect((await get(dave, "JOB-5001")).status).toBe(404);
    // ... and he cannot act on it either.
    const put = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", dave).send({ timeEntries: ENTRIES });
    expect(put.status).toBe(404);
  });

  test("AC1: no session is refused", async () => {
    await acceptedJob();
    expect((await request(app).get("/api/contractor/jobs/JOB-5001")).status).toBe(401);
  });
});

describe("AC2 -- what the screen shows", () => {
  test("AC2: slot, address, the ask-for NAME (never a phone), the customer's words, Instruction notes only", async () => {
    await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const body = await view(bob, "JOB-5001");
    expect(body.reference).toBe("JOB-5001");
    expect(body.slotLabel).toContain("8:00am");
    expect(body.addressLine).toBe("5 Carrington Street, Hilton");
    expect(body.contactLine).toBe("Lena Park");
    expect(body.contactIsSiteContact).toBe(true);
    expect(JSON.stringify(body)).not.toContain("0400 111 222");
    expect(body.description).toBe("The mixer tap in the kitchen leaks.");
    expect(body.answers).toEqual(["Where is the leak?: Kitchen tap"]);
    expect(body.instructions.map((n) => n.note)).toEqual(["Side gate code 4471"]);
    expect(body.instructions[0]?.authorFirstName).toBe("Mike");
    expect(JSON.stringify(body)).not.toContain("transfer");
    expect(body.canOnSite).toBe(true);
    expect(body.frozen).toBe(false);
  });

  test("AC2: the dashboard card for an accepted job opens; the waiting one stays flat", async () => {
    await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await request(app).get("/api/contractor/dashboard").set("Cookie", bob);
    const jobs = (res.body as { jobs: { reference: string; opens: boolean }[] }).jobs;
    expect(jobs.find((j) => j.reference === "JOB-5001")?.opens).toBe(true);
    expect(jobs.find((j) => j.reference === "JOB-1042")?.opens).toBe(false);
  });
});

describe("AC3 -- On site", () => {
  test("AC3: accepted -> in progress on assignment and job; a second tap changes nothing", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const first = await request(app).post("/api/contractor/jobs/JOB-5001/on-site").set("Cookie", bob);
    expect(first.status).toBe(200);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("in_progress");
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("in_progress");
    expect((first.body as ContractorJobView).canOnSite).toBe(false);
    const second = await request(app).post("/api/contractor/jobs/JOB-5001/on-site").set("Cookie", bob);
    expect(second.status).toBe(200);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("in_progress");
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("in_progress");
  });
});

describe("AC4 -- Save", () => {
  test("AC4: two time entries, notes and a part are saved and reread; the live billed hours are 3.5", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const receipt = await receiptFor(assignmentId, jobId);
    const bob = await signInCookie("bob@idelta.com.au");
    const body = {
      timeEntries: [ENTRIES[1], ENTRIES[0]], // typed in reverse order
      completionNotes: "Replaced the cartridge.",
      parts: [{ name: "Tap cartridge", description: "", qty: 1, unitPrice: 4500, receiptAttachmentId: receipt }],
    };
    const put = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send(body);
    expect(put.status).toBe(200);
    const again = await view(bob, "JOB-5001");
    expect(again.timeEntries).toEqual([ENTRIES[0], ENTRIES[1]]);
    expect(again.completionNotes).toBe("Replaced the cartridge.");
    expect(again.parts).toHaveLength(1);
    expect(again.parts[0]).toMatchObject({ name: "Tap cartridge", qty: 1, unitPrice: 4500, lineTotal: 4500, receiptAttachmentId: receipt });
    expect(again.billedHours).toBe(3.5);
    // Nothing completed, nothing moved.
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("accepted");
  });

  test("AC4: Save replaces as a whole -- fewer entries on the next save leaves fewer", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ timeEntries: ENTRIES });
    await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ timeEntries: [ENTRIES[0]] });
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(1);
  });

  test("AC4: finish before start is refused on that row, and nothing is written", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const bad = [ENTRIES[0], { date: "2026-10-09", start: "10:00", end: "09:00", note: "" }];
    const res = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ timeEntries: bad });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "timeEntries[1].end", error: "Finish must be after start." });
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(0);
  });

  test("AC4: times are read and written in the job's zone -- 8:07am Perth is 00:07 UTC", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ timeEntries: [ENTRIES[0]] });
    const row = await db.assignmentTimeLog.findFirstOrThrow({ where: { assignmentId } });
    expect(row.startedAt.toISOString()).toBe("2026-10-07T00:07:00.000Z");
    expect(row.endedAt.toISOString()).toBe("2026-10-07T03:05:00.000Z");
  });

  test("AC4: a date not on the calendar is refused on its date", async () => {
    await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await request(app)
      .put("/api/contractor/jobs/JOB-5001")
      .set("Cookie", bob)
      .send({ timeEntries: [{ date: "2026-02-31", start: "08:00", end: "09:00" }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "timeEntries[0].date" });
  });
});

describe("AC6 -- parts and receipts", () => {
  test("AC6: parts over the cap in total are refused on the price, the amount read from settings", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const receipt = await receiptFor(assignmentId, jobId);
    const bob = await signInCookie("bob@idelta.com.au");
    const over = { name: "Mixer tap", qty: 1, unitPrice: 15_001, receiptAttachmentId: receipt };
    const res = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [over] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "parts[0].unitPrice", error: "Parts are over $150 in total - ring the office, they order it" });
    // The cap is the settings row's, not a constant.
    await db.platformSettings.updateMany({ data: { maxContractorPartAmount: 20_000 } });
    const ok = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [over] });
    expect(ok.status).toBe(200);
    const exactly = { name: "Mixer tap", qty: 2, unitPrice: 10_000, receiptAttachmentId: receipt };
    expect((await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [exactly] })).status).toBe(200);
    const above = { ...exactly, qty: 2.01 };
    expect((await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [above] })).status).toBe(400);
  });

  test("AC6: several parts are capped as a TOTAL -- $100 and $60 is over $150, refused on the second line; $100 and $50 is fine", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const receipt = await receiptFor(assignmentId, jobId);
    const bob = await signInCookie("bob@idelta.com.au");
    const part = (name: string, unitPrice: number) => ({ name, qty: 1, unitPrice, receiptAttachmentId: receipt });
    const over = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [part("Valve", 10_000), part("Trap", 6_000)] });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ field: "parts[1].unitPrice", error: "Parts are over $150 in total - ring the office, they order it" });
    expect(await db.assignmentPart.count({ where: { assignmentId } })).toBe(0);
    const fine = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [part("Valve", 10_000), part("Trap", 5_000)] });
    expect(fine.status).toBe(200);
  });

  test("AC6: a part with no receipt photo is refused; so is another assignment's receipt", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const none = { name: "Washer", qty: 1, unitPrice: 300 };
    const res = await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ parts: [none] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: "parts[0].receipt" });

    // A receipt on someone else's assignment (Tom's JOB-1051) is not his to use.
    const toms = await db.assignment.findFirstOrThrow({ where: { job: { reference: "JOB-1051" } } });
    const foreign = await receiptFor(toms.id, toms.jobId);
    const stolen = await request(app)
      .put("/api/contractor/jobs/JOB-5001")
      .set("Cookie", bob)
      .send({ parts: [{ ...none, receiptAttachmentId: foreign }] });
    expect(stolen.status).toBe(400);
    expect(stolen.body).toMatchObject({ field: "parts[0].receipt" });
    expect(await db.assignmentPart.count({ where: { assignmentId } })).toBe(0);
    expect(jobId).toBeTruthy();
  });

  test("AC6: confirming an upload stores an Attachment on the job with Bob's assignment, and the read shows its thumbnail", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await request(app)
      .post("/api/contractor/jobs/JOB-5001/receipts")
      .set("Cookie", bob)
      .send({ storageKey: `${RECEIPT_FOLDER}/r1`, fileName: "bunnings.jpg" });
    expect(res.status).toBe(201);
    const row = await db.attachment.findUniqueOrThrow({ where: { id: (res.body as { id: string }).id } });
    expect(row).toMatchObject({ jobId, assignmentId, uploadedByRole: "contractor", storageKey: `${RECEIPT_FOLDER}/r1`, fileName: "bunnings.jpg" });
  });

  test("AC6: a receipt key outside the receipts folder -- the enquiry folder's, or a traversal -- is refused", async () => {
    await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    for (const key of [`${ENQUIRY_PHOTO_FOLDER}/x`, `${RECEIPT_FOLDER}/../enquiry-photos/x`, RECEIPT_FOLDER, "elsewhere/x"]) {
      const res = await request(app).post("/api/contractor/jobs/JOB-5001/receipts").set("Cookie", bob).send({ storageKey: key, fileName: "x.jpg" });
      expect(res.status).toBe(400);
    }
    expect(isReceiptKey(`${RECEIPT_FOLDER}/x`)).toBe(true);
    expect(isEnquiryPhotoKey(`${RECEIPT_FOLDER}/x`)).toBe(false);
    expect(await db.attachment.count({ where: { uploadedByRole: "contractor" } })).toBe(0);
  });

  test("AC6: the signature is for the receipts folder, never the secret; not set up answers 503; a stranger gets 404", async () => {
    await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await request(app).post("/api/contractor/jobs/JOB-5001/receipt-signature").set("Cookie", bob).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cloudName: "test-cloud", folder: RECEIPT_FOLDER });
    expect(JSON.stringify(res.body)).not.toContain("test-only-api-secret-value");
    expect(RECEIPT_FOLDER).toBe("tradeservice/receipts");

    configured = null;
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/receipt-signature").set("Cookie", bob).send({})).status).toBe(503);
    // The rest of the screen still saves.
    expect((await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ timeEntries: ENTRIES })).status).toBe(200);

    configured = CONFIG;
    const dave = await signInCookie("dave@idelta.com.au");
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/receipt-signature").set("Cookie", dave).send({})).status).toBe(404);
  });
});

describe("AC7 -- Complete", () => {
  test("AC7: no time entry is refused on timeEntries; no completion notes on completionNotes", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const noEntry = await request(app).post("/api/contractor/jobs/JOB-5001/complete").set("Cookie", bob).send({ completionNotes: "Done." });
    expect(noEntry.status).toBe(400);
    expect(noEntry.body).toMatchObject({ field: "timeEntries" });
    const noNotes = await request(app).post("/api/contractor/jobs/JOB-5001/complete").set("Cookie", bob).send({ timeEntries: ENTRIES, completionNotes: "  " });
    expect(noNotes.status).toBe(400);
    expect(noNotes.body).toMatchObject({ field: "completionNotes" });
    const row = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(row.status).toBe("accepted");
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(0);
  });

  test("AC7: Complete saves, stores billedHours and completedAt, completes assignment and job, and sends nothing", async () => {
    const { jobId, assignmentId } = await acceptedJob();
    const receipt = await receiptFor(assignmentId, jobId);
    const bob = await signInCookie("bob@idelta.com.au");
    const notifications = await db.notification.count();
    const res = await request(app)
      .post("/api/contractor/jobs/JOB-5001/complete")
      .set("Cookie", bob)
      .send({
        timeEntries: ENTRIES,
        completionNotes: "Replaced the cartridge.",
        parts: [{ name: "Tap cartridge", qty: 1, unitPrice: 4500, receiptAttachmentId: receipt }],
      });
    expect(res.status).toBe(200);
    expect((res.body as ContractorJobView).frozen).toBe(true);
    const row = await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(row.status).toBe("completed");
    expect(Number(row.billedHours)).toBe(3.5);
    expect(row.completedAt).not.toBeNull();
    expect(row.completionNotes).toBe("Replaced the cartridge.");
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("completed");
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(2);
    expect(await db.assignmentPart.count({ where: { assignmentId } })).toBe(1);
    // 6001's, not this feature's: no invoice, no message.
    expect(await db.invoice.count()).toBe(0);
    expect(await db.notification.count()).toBe(notifications);
  });

  test("AC7: a refused part rolls Complete back whole -- the job is not completed", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const res = await request(app)
      .post("/api/contractor/jobs/JOB-5001/complete")
      .set("Cookie", bob)
      .send({ timeEntries: ENTRIES, completionNotes: "Done.", parts: [{ name: "Tap", qty: 1, unitPrice: 4500 }] });
    expect(res.status).toBe(400);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("accepted");
    expect(await db.assignmentTimeLog.count({ where: { assignmentId } })).toBe(0);
  });

  test("AC7: Complete straight from On site (in progress) works too", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    await request(app).post("/api/contractor/jobs/JOB-5001/on-site").set("Cookie", bob);
    const res = await request(app).post("/api/contractor/jobs/JOB-5001/complete").set("Cookie", bob).send({ timeEntries: [ENTRIES[0]], completionNotes: "Done." });
    expect(res.status).toBe(200);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe("completed");
  });
});

describe("AC8 -- after Complete", () => {
  test("AC8: Save, a second Complete, On site and receipts are refused; the job leaves his dashboard; the read says frozen", async () => {
    const { assignmentId } = await acceptedJob();
    const bob = await signInCookie("bob@idelta.com.au");
    const done = { timeEntries: ENTRIES, completionNotes: "Done." };
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/complete").set("Cookie", bob).send(done)).status).toBe(200);

    expect((await request(app).put("/api/contractor/jobs/JOB-5001").set("Cookie", bob).send({ ...done, completionNotes: "Changed." })).status).toBe(409);
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/complete").set("Cookie", bob).send(done)).status).toBe(409);
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/on-site").set("Cookie", bob)).status).toBe(409);
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/receipt-signature").set("Cookie", bob).send({})).status).toBe(409);
    expect((await request(app).post("/api/contractor/jobs/JOB-5001/receipts").set("Cookie", bob).send({ storageKey: `${RECEIPT_FOLDER}/z`, fileName: "z.jpg" })).status).toBe(409);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).completionNotes).toBe("Done.");

    const body = await view(bob, "JOB-5001");
    expect(body.frozen).toBe(true);
    expect(body.canOnSite).toBe(false);
    expect(body.completionNotes).toBe("Done.");

    const dash = await request(app).get("/api/contractor/dashboard").set("Cookie", bob);
    expect((dash.body as { jobs: { reference: string }[] }).jobs.map((j) => j.reference)).not.toContain("JOB-5001");
  });
});
