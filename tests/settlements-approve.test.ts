// Feature 6003 -- settlement run: the contractor's approve link
//
// AC5  the approve page reads the invoice; Approve sets it approved (approvedAt, the
//      contractorGstRegistered snapshot, GST from the snapshot), the link is spent, and opening
//      it again says "Already approved"
// AC6  a contractor whose GST registration is not asked can open the draft but Approve is refused
//      ("gst_not_recorded" with the office phone); once Mike records a yes or no, the same link
//      approves
// and the dead states: replaced (410), approved (410), unknown (404) - each with the office phone
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { MONDAY_19_OCT, completedVisit } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { approveRoutes } from "../src/approve/routes.js";
import { CapabilityTokenType, mintCapabilityLink } from "../src/capability-tokens/index.js";
import { dayLabel, payDayFor } from "../src/settlements/calendar.js";
import { runWeekly } from "../src/settlements/sweep.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;

beforeAll(() => {
  db = testClient();
  app = express();
  app.use(express.json());
  app.use("/api/approve", approveRoutes(db));
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
});

/** Bob's three jobs for the week, swept into CINV-518 by the Monday run. */
async function bobsDraft(): Promise<{ id: string; token: string }> {
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3, partCents: 4500 });
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-15", hours: 1.5 });
  await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-17", hours: 1 });
  await runWeekly(db, MONDAY_19_OCT);
  return draftWithLink("CON-014");
}

async function draftWithLink(code: string): Promise<{ id: string; token: string }> {
  const settlement = await db.contractorSettlement.findFirstOrThrow({ where: { contractor: { code }, status: "draft" } });
  return { id: settlement.id, token: await newLink(settlement.id) };
}

/** A further approve link on a settlement - the way a second email carries its own. */
async function newLink(settlementId: string): Promise<string> {
  const minted = await mintCapabilityLink(db, { type: CapabilityTokenType.approve, settlementId });
  return minted.url.split("/approve/")[1] ?? "";
}

async function officePhone(): Promise<string> {
  return (await db.platformSettings.findFirstOrThrow()).operatorPhone;
}

async function livePayDay(): Promise<string> {
  const settings = await db.platformSettings.findFirstOrThrow();
  return dayLabel(payDayFor(settings, new Date()));
}

const read = (token: string) => request(app).get(`/api/approve/${token}`);
const approve = (token: string) => request(app).post(`/api/approve/${token}`).send({});

interface OpenBody {
  state: string;
  firstName: string;
  payDay: string;
  officePhone: string;
  invoice: {
    reference: string;
    heading: string;
    gstRegistered: boolean;
    gstNotRecorded: boolean;
    lines: { jobReference: string; day: string; trade: string; hours: number; amount: number; weekend: boolean }[];
    subtotal: number;
    gst: number | null;
    materials: { amount: number }[];
    materialsTotal: number;
    total: number;
    dateLabel: string;
    weekendMultiplier: number;
  };
}

describe("AC5 -- the approve page reads the invoice", () => {
  test("AC5: the open link shows the Tax Invoice - a line per job, T1.5 on the weekend one, GST on top, parts apart", async () => {
    const { token } = await bobsDraft();
    const res = await read(token);
    expect(res.status).toBe(200);
    const body = res.body as OpenBody;
    expect(body.state).toBe("open");
    expect(body.firstName).toBe("Bob");
    expect(body.payDay).toBe(await livePayDay());
    expect(body.officePhone).toBe(await officePhone());
    expect(body.invoice).toMatchObject({
      reference: "CINV-518",
      heading: "Tax Invoice",
      gstRegistered: true,
      subtotal: 107_500,
      gst: 10_750,
      materialsTotal: 4500,
      total: 122_750,
      dateLabel: "Draft",
      weekendMultiplier: 1.5,
    });
    expect(body.invoice.lines.map((line) => [line.day, line.trade, line.hours, line.amount, line.weekend])).toEqual([
      ["Wed 14 Oct", "Plumbing", 3, 50_000, false],
      ["Thu 15 Oct", "Plumbing", 1.5, 27_500, false],
      ["Sat 17 Oct", "Plumbing", 1, 30_000, true],
    ]);
  });

  test("AC5: opening the page burns nothing - it can be read again and again", async () => {
    const { token } = await bobsDraft();
    expect((await read(token)).status).toBe(200);
    expect((await read(token)).status).toBe(200);
    expect((await db.capabilityToken.findFirstOrThrow({ where: { type: "approve" } })).usedAt).toBeNull();
  });

  test("AC5: Approve freezes the invoice - approvedAt, the registration snapshot, GST from the snapshot - and spends the link", async () => {
    const { id, token } = await bobsDraft();
    const res = await approve(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "approved", reference: "CINV-518", payDay: await livePayDay() });

    const settlement = await db.contractorSettlement.findUniqueOrThrow({ where: { id } });
    expect(settlement.status).toBe("approved");
    expect(settlement.approvedAt).not.toBeNull();
    expect(settlement.contractorGstRegistered).toBe(true);
    expect(settlement.gstAmount).toBe(10_750);
    expect((await db.capabilityToken.findFirstOrThrow({ where: { type: "approve" } })).usedAt).not.toBeNull();
  });

  test("AC5: a later change to Bob's registration never re-prices the approved invoice", async () => {
    const { id, token } = await bobsDraft();
    await approve(token);
    await db.contractor.update({ where: { code: "CON-014" }, data: { gstRegistered: false } });
    const settlement = await db.contractorSettlement.findUniqueOrThrow({ where: { id } });
    expect(settlement.gstAmount).toBe(10_750);
    expect(settlement.contractorGstRegistered).toBe(true);
    const again = await read(token);
    expect(again.status).toBe(410);
  });

  test("AC5: opening the link again shows Already approved, with the invoice, the date and the pay day", async () => {
    const { token } = await bobsDraft();
    await approve(token);
    const res = await read(token);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      state: "approved",
      reference: "CINV-518",
      payDay: await livePayDay(),
      paid: false,
      officePhone: await officePhone(),
    });
    expect((res.body as { approvedLabel: string }).approvedLabel).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  });

  test("AC5: a second Approve is the same tap - refused as already approved, nothing changes", async () => {
    const { id, token } = await bobsDraft();
    await approve(token);
    const first = await db.contractorSettlement.findUniqueOrThrow({ where: { id } });
    const res = await approve(token);
    expect(res.status).toBe(410);
    expect((res.body as { state: string }).state).toBe("approved");
    expect((await db.contractorSettlement.findUniqueOrThrow({ where: { id } })).approvedAt?.getTime()).toBe(first.approvedAt?.getTime());
  });

  test("AC5: every other approve link on the same draft says Already approved once one is used", async () => {
    const { id, token } = await bobsDraft();
    const other = await newLink(id);
    await approve(token);
    const res = await read(other);
    expect(res.status).toBe(410);
    expect((res.body as { state: string }).state).toBe("approved");
  });

  test("AC5: Dave, not registered, approves a plain Invoice - snapshot false, no GST", async () => {
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-13", hours: 2 });
    await runWeekly(db, MONDAY_19_OCT);
    const { id, token } = await draftWithLink("CON-021");
    const open = (await read(token)).body as OpenBody;
    expect(open.invoice).toMatchObject({ heading: "Invoice", gst: null, gstRegistered: false });
    expect((await approve(token)).status).toBe(200);
    const settlement = await db.contractorSettlement.findUniqueOrThrow({ where: { id } });
    expect(settlement).toMatchObject({ contractorGstRegistered: false, gstAmount: null, status: "approved" });
  });

  test("a paid invoice's link still explains itself, and says it has been paid", async () => {
    const { id, token } = await bobsDraft();
    await approve(token);
    await db.contractorSettlement.update({ where: { id }, data: { status: "paid", paidAt: new Date() } });
    const res = await read(token);
    expect(res.status).toBe(410);
    expect((res.body as { paid: boolean }).paid).toBe(true);
  });
});

describe("AC6 -- GST registration not asked", () => {
  async function priyasDraft(): Promise<{ id: string; token: string }> {
    await completedVisit(db, { contractorCode: "CON-030", day: "2026-10-14", hours: 2 });
    await runWeekly(db, MONDAY_19_OCT);
    return draftWithLink("CON-030");
  }

  test("AC6: Priya can open the draft - a plain Invoice for now, flagged as not recorded", async () => {
    const { token } = await priyasDraft();
    const res = await read(token);
    expect(res.status).toBe(200);
    expect((res.body as OpenBody).invoice).toMatchObject({ heading: "Invoice", gstNotRecorded: true, gst: null });
  });

  test("AC6: Approve is refused - 409 gst_not_recorded with the office phone - and the draft stays a draft", async () => {
    const { id, token } = await priyasDraft();
    const res = await approve(token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "gst_not_recorded", officePhone: await officePhone() });
    expect((await db.contractorSettlement.findUniqueOrThrow({ where: { id } })).status).toBe("draft");
    expect((await db.capabilityToken.findFirstOrThrow({ where: { type: "approve" } })).usedAt).toBeNull();
  });

  test("AC6: once Mike records a yes, the same link approves - and it is a Tax Invoice by then", async () => {
    const { id, token } = await priyasDraft();
    await approve(token);
    await db.contractor.update({ where: { code: "CON-030" }, data: { gstRegistered: true } });
    expect(((await read(token)).body as OpenBody).invoice).toMatchObject({ heading: "Tax Invoice", gstNotRecorded: false });
    expect((await approve(token)).status).toBe(200);
    const settlement = await db.contractorSettlement.findUniqueOrThrow({ where: { id } });
    expect(settlement.contractorGstRegistered).toBe(true);
    expect(settlement.gstAmount).toBe(Math.round(settlement.totalAmount / 10));
  });

  test("AC6: a recorded no approves too, with no GST", async () => {
    const { id, token } = await priyasDraft();
    await db.contractor.update({ where: { code: "CON-030" }, data: { gstRegistered: false } });
    expect((await approve(token)).status).toBe(200);
    expect(await db.contractorSettlement.findUniqueOrThrow({ where: { id } })).toMatchObject({ contractorGstRegistered: false, gstAmount: null });
  });
});

describe("a dead link explains itself", () => {
  test("an unknown token is a 404 'unknown' with the office phone", async () => {
    const res = await read("not-a-real-token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ state: "unknown", officePhone: await officePhone() });
    expect((await approve("not-a-real-token")).status).toBe(404);
  });

  test("a link of another kind does not open an invoice", async () => {
    await bobsDraft();
    const job = await db.job.findFirstOrThrow();
    const assignment = await db.assignment.findFirstOrThrow();
    const respond = await mintCapabilityLink(db, {
      type: CapabilityTokenType.respond,
      jobId: job.id,
      assignmentId: assignment.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const res = await read(respond.url.split("/a/")[1] ?? "");
    expect(res.status).toBe(404);
    expect((res.body as { state: string }).state).toBe("unknown");
  });

  test("a draft's link that has run out (60 days) reads as a link that does not work", async () => {
    const { token } = await bobsDraft();
    await db.capabilityToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await read(token);
    expect(res.status).toBe(404);
    expect((res.body as { state: string }).state).toBe("unknown");
  });

  test("a replaced draft's link says it was replaced (410)", async () => {
    const { id, token } = await bobsDraft();
    await db.contractorSettlement.update({ where: { id }, data: { status: "superseded", supersededAt: new Date() } });
    const res = await read(token);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ state: "replaced", officePhone: await officePhone() });
    expect((await approve(token)).status).toBe(410);
  });
});
