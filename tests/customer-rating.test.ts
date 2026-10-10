// Feature 4010 -- the customer rating card's figures
//
// AC1  the label from her completed jobs in the 365 days, never the job on the page, never cancelled or no-show
// AC2  the line: count and last job's date, "1 job", "No earlier jobs with us", "No jobs in the last 12 months"
// AC3  missed visits, and how many of them were waived (no call-out invoice)
// AC4  late cancellations: cancelled after an acceptance only; a no-show is not one
// AC5  disputes: a dispute or complaint note; other note types do not count
// AC6  overdue invoices and total due: sent, not zero-dollar; paid, void and zero-dollar never count
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { nextReference } from "../src/db/reference.js";
import { customerRatingOf, labelOf, lineOf } from "../src/jobs/customer-rating.js";
import type { PrismaClient } from "../src/db/client.js";
import type { AssignmentStatus, CancelReason, JobStatus } from "../src/generated/prisma/enums.js";

let db: PrismaClient;
const ZONE = "Australia/Perth";
const NOW = new Date("2026-10-10T04:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let customerId: string;

beforeAll(() => {
  db = testClient();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  const customer = await db.customer.create({
    data: { code: await nextReference("CUS", db), name: "Rating Test", email: "rating.test@example.com" },
  });
  customerId = customer.id;
});

interface JobOptions {
  status?: JobStatus;
  cancelReason?: CancelReason;
  assignment?: { status: AssignmentStatus; acceptedAt?: Date | null; completedAt?: Date | null };
  notes?: { type: string; note: string }[];
  invoice?: { amount?: number; dueAt?: Date; status?: "sent" | "paid" | "void"; isZeroDollar?: boolean; callout?: boolean };
}

async function makeJob(options: JobOptions = {}): Promise<string> {
  const plumbing = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
  const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
  const specialty = bob.specialties.find((s) => s.trade === "Plumbing");
  if (!specialty) throw new Error("fixture Bob has no Plumbing specialty");
  const status = options.status ?? "new";
  const job = await db.job.create({
    data: {
      reference: await nextReference("JOB", db),
      customerId,
      serviceTypeId: plumbing.id,
      customerCalloutRate: plumbing.customerCalloutRate,
      customerStandardRate: plumbing.customerStandardRate,
      postcode: "6163",
      serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.0731, lng: 115.7797, placeId: "fixture-place-hilton" },
      timezone: ZONE,
      selectedOptions: [],
      source: "web",
      preferredWindow: "morning",
      preferredDate: ago(1),
      status,
      ...(options.cancelReason === undefined ? {} : { cancelReason: options.cancelReason, cancelledAt: ago(1) }),
      ...(options.notes === undefined
        ? {}
        : {
            operatorNotes: options.notes.map((note, index) => ({
              id: `note-${String(index)}`,
              at: ago(1).toISOString(),
              operatorId: "x",
              type: note.type,
              note: note.note,
            })),
          }),
    },
  });
  let assignmentId: string | undefined;
  if (options.assignment) {
    const assignment = await db.assignment.create({
      data: {
        jobId: job.id,
        contractorId: bob.id,
        specialtyId: specialty.id,
        status: options.assignment.status,
        acceptedAt: options.assignment.acceptedAt ?? null,
        completedAt: options.assignment.completedAt ?? null,
      },
    });
    assignmentId = assignment.id;
  }
  if (options.invoice) {
    if (assignmentId === undefined) throw new Error("an invoice needs an assignment");
    const amount = options.invoice.isZeroDollar ? 0 : (options.invoice.amount ?? 10_000);
    const invoice = await db.invoice.create({
      data: {
        reference: await nextReference("INV", db),
        jobId: job.id,
        assignmentId,
        customerId,
        amount,
        labourAmount: amount,
        materialsAmount: 0,
        gstAmount: 0,
        gstApplied: false,
        isZeroDollar: options.invoice.isZeroDollar ?? false,
        billedTo: { name: "Rating Test" },
        status: options.invoice.status ?? "sent",
        dueAt: options.invoice.dueAt ?? ago(-14),
        sentAt: ago(2),
      },
    });
    if (options.invoice.callout) {
      await db.invoiceLine.create({
        data: { invoiceId: invoice.id, kind: "callout", description: "Call-out", qty: 1, unitPrice: amount, lineTotal: amount },
      });
    }
  }
  return job.id;
}

const completed = (days: number): JobOptions => ({
  status: "completed",
  assignment: { status: "completed", acceptedAt: ago(days + 1), completedAt: ago(days) },
});

async function rating(currentJobId = "none") {
  return customerRatingOf(db, customerId, currentJobId, ZONE, NOW);
}

describe("AC1 / AC2 -- the label and its line", () => {
  test("no earlier job -> First-time, 'No earlier jobs with us'", async () => {
    const current = await makeJob();
    const result = await rating(current);
    expect(result.label).toBe("first_time");
    expect(result.line).toBe("No earlier jobs with us");
    expect(result.lastJobLabel).toBeNull();
  });

  test("1 job in 12 months -> Returning, '1 job ...'", async () => {
    await makeJob(completed(20));
    const result = await rating();
    expect(result.label).toBe("returning");
    expect(result.jobsInLastYear).toBe(1);
    expect(result.line).toBe(`1 job in the last 12 months - last job ${result.lastJobLabel ?? ""}`);
    expect(result.lastJobLabel).toBe("20 Sep 2026");
  });

  test("5 -> Returning, 6 -> Regular, with the plural line", async () => {
    for (let i = 0; i < 5; i += 1) await makeJob(completed(10 + i));
    expect((await rating()).label).toBe("returning");
    await makeJob(completed(30));
    const result = await rating();
    expect(result.label).toBe("regular");
    expect(result.line).toBe("6 jobs in the last 12 months - last job 30 Sep 2026");
  });

  test("some before but none in 12 months -> Old; the 365-day edge", async () => {
    await makeJob(completed(366));
    const old = await rating();
    expect(old.label).toBe("old");
    expect(old.line).toBe("No jobs in the last 12 months - last job 9 Oct 2025");
    await makeJob(completed(364));
    expect((await rating()).label).toBe("returning");
    expect(labelOf([ago(365)], NOW)).toBe("old");
    expect(labelOf([ago(364)], NOW)).toBe("returning");
  });

  test("the job on the page never counts; cancelled and no-show jobs never count", async () => {
    const current = await makeJob(completed(1));
    await makeJob({ status: "cancelled", cancelReason: "customer_changed_mind", assignment: { status: "cancelled", acceptedAt: ago(5) } });
    await makeJob({ status: "cancelled", cancelReason: "customer_no_show" });
    const result = await rating(current);
    expect(result.label).toBe("first_time");
    expect(result.jobsInLastYear).toBe(0);
  });

  test("lineOf: wording", () => {
    expect(lineOf("regular", 7, "2 Oct 2026")).toBe("7 jobs in the last 12 months - last job 2 Oct 2026");
    expect(lineOf("returning", 1, "2 Oct 2026")).toBe("1 job in the last 12 months - last job 2 Oct 2026");
  });
});

describe("AC3 -- missed visits and waived", () => {
  test("none -> 0 (0 waived)", async () => {
    const result = await rating();
    expect(result.missedVisits).toBe(0);
    expect(result.waived).toBe(0);
  });

  test("two no-shows, one with a call-out invoice and one without -> 2 with 1 waived", async () => {
    await makeJob({
      status: "cancelled",
      cancelReason: "customer_no_show",
      assignment: { status: "cancelled", acceptedAt: ago(5) },
      invoice: { callout: true },
    });
    await makeJob({ status: "cancelled", cancelReason: "customer_no_show", assignment: { status: "cancelled", acceptedAt: ago(6) } });
    const result = await rating();
    expect(result.missedVisits).toBe(2);
    expect(result.waived).toBe(1);
  });
});

describe("AC4 -- late cancellations", () => {
  test("cancelled after acceptance counts; before any acceptance does not; a no-show is not one", async () => {
    await makeJob({ status: "cancelled", cancelReason: "customer_changed_mind", assignment: { status: "cancelled", acceptedAt: ago(5) } });
    await makeJob({ status: "cancelled", cancelReason: "customer_changed_mind", assignment: { status: "cancelled", acceptedAt: null } });
    await makeJob({ status: "cancelled", cancelReason: "customer_no_show", assignment: { status: "cancelled", acceptedAt: ago(5) } });
    expect((await rating()).lateCancellations).toBe(1);
  });
});

describe("AC5 -- disputes", () => {
  test("a dispute or complaint note counts once per job; instruction and general do not", async () => {
    await makeJob({ notes: [{ type: "dispute", note: "a" }, { type: "complaint", note: "b" }] });
    await makeJob({ notes: [{ type: "instruction", note: "c" }, { type: "general", note: "d" }] });
    await makeJob({ notes: [{ type: "complaint", note: "e" }] });
    expect((await rating()).disputes).toBe(2);
  });
});

describe("AC6 -- overdue invoices and total due", () => {
  test("overdue, due later, paid, void and zero-dollar", async () => {
    await makeJob({ ...completed(10), invoice: { amount: 20_000, dueAt: ago(3) } });
    await makeJob({ ...completed(9), invoice: { amount: 28_000, dueAt: ago(-5) } });
    await makeJob({ ...completed(8), invoice: { amount: 5_000, dueAt: ago(3), status: "paid" } });
    await makeJob({ ...completed(7), invoice: { amount: 5_000, dueAt: ago(3), status: "void" } });
    await makeJob({ ...completed(6), invoice: { isZeroDollar: true, dueAt: ago(3) } });
    const result = await rating();
    expect(result.overdueInvoices).toBe(1);
    expect(result.totalDue).toBe(48_000);
  });
});
