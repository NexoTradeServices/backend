// Feature 6003 -- settlement run: supersede and Rebuild
//
// AC7  a draft left unapproved is superseded by the next Monday run (supersededAt only): ONE fresh
//      draft carries both weeks, its period from the first week's Monday, a fresh email goes out,
//      and the old link says "replaced"
// AC8  an unapproved draft whose job got a `correction` note after it was made shows "Job
//      corrected since"; Rebuild supersedes it with supersededByUserId + supersededAt, makes a
//      fresh draft with the same period end, emails a fresh link; the old link explains itself
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { MONDAY_12_OCT, MONDAY_19_OCT, completedVisit, settlementApp, signIn } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { CapabilityTokenType, mintCapabilityLink } from "../src/capability-tokens/index.js";
import { correctedSince } from "../src/settlements/service.js";
import { runWeekly } from "../src/settlements/sweep.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let app: Express;
let mike: string;
let bob: string;

beforeAll(() => {
  db = testClient();
  app = settlementApp(db);
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
  mike = await signIn(app, "mike@idelta.com.au");
  bob = await signIn(app, "bob@idelta.com.au");
});

async function newLink(settlementId: string): Promise<string> {
  const minted = await mintCapabilityLink(db, { type: CapabilityTokenType.approve, settlementId });
  return minted.url.split("/approve/")[1] ?? "";
}

async function settlementsOf(code: string) {
  return db.contractorSettlement.findMany({ where: { contractor: { code } }, orderBy: { createdAt: "asc" } });
}

async function mikeId(): Promise<string> {
  return (await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } })).id;
}

describe("AC7 -- an ignored draft is superseded by the next run", () => {
  test("AC7: the next Monday run replaces it with ONE fresh draft carrying both weeks, period from the first Monday", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await runWeekly(db, MONDAY_12_OCT);
    const [first] = await settlementsOf("CON-014");
    expect(first?.reference).toBe("CINV-518");
    const staleLink = await newLink(first?.id ?? "");

    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3 });
    const result = await runWeekly(db, MONDAY_19_OCT);
    expect(result.made).toHaveLength(1);
    expect(result.made[0]?.replacedId).toBe(first?.id);

    const [old, fresh] = await settlementsOf("CON-014");
    expect(old).toMatchObject({ id: first?.id, status: "superseded", supersededByUserId: null });
    expect(old?.supersededAt).not.toBeNull();
    expect(fresh).toMatchObject({ reference: "CINV-519", status: "draft", totalAmount: 20_000 + 50_000 });
    expect(fresh?.periodStart.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(fresh?.periodEnd.toISOString().slice(0, 10)).toBe("2026-10-18");
    expect(fresh?.breakdownByTrade).toEqual([{ trade: "Plumbing", count: 2, amount: 70_000 }]);

    // Both weeks' visits sit on the fresh draft and none on the old one.
    expect(await db.assignment.count({ where: { settlementId: fresh?.id } })).toBe(2);
    expect(await db.assignment.count({ where: { settlementId: old?.id } })).toBe(0);
    // There is only ever one outstanding draft per contractor.
    expect((await settlementsOf("CON-014")).filter((row) => row.status === "draft")).toHaveLength(1);

    // A fresh email goes out, beside the first; the old link says it was replaced.
    expect(await db.notification.count({ where: { type: "settlement_draft" } })).toBe(2);
    const res = await request(app).get(`/api/approve/${staleLink}`);
    expect(res.status).toBe(410);
    expect((res.body as { state: string }).state).toBe("replaced");
    expect((await db.capabilityToken.findFirstOrThrow({ where: { settlementId: old?.id } })).usedAt).not.toBeNull();
  });

  test("AC7: an ignored draft is re-swept even with no new work - one fresh draft with the same visits", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await runWeekly(db, MONDAY_12_OCT);
    const result = await runWeekly(db, MONDAY_19_OCT);
    expect(result.made).toHaveLength(1);
    const [old, fresh] = await settlementsOf("CON-014");
    expect(old?.status).toBe("superseded");
    expect(fresh).toMatchObject({ status: "draft", totalAmount: 20_000 });
    expect(fresh?.periodStart.toISOString().slice(0, 10)).toBe("2026-10-05");
  });

  test("AC7: a draft that WAS approved is left alone - the new week gets its own draft", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await runWeekly(db, MONDAY_12_OCT);
    await db.contractorSettlement.updateMany({ data: { status: "approved", approvedAt: MONDAY_12_OCT, contractorGstRegistered: true, gstAmount: 2000 } });
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1 });
    await runWeekly(db, MONDAY_19_OCT);

    const [approved, fresh] = await settlementsOf("CON-014");
    expect(approved?.status).toBe("approved");
    expect(fresh).toMatchObject({ status: "draft", totalAmount: 20_000 });
    expect(fresh?.periodStart.toISOString().slice(0, 10)).toBe("2026-10-12");
  });
});

describe("AC8 -- Job corrected since, and Rebuild", () => {
  async function bobsDraft(): Promise<{ id: string; reference: string; jobId: string; assignmentId: string }> {
    const visit = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 3 });
    await runWeekly(db, MONDAY_19_OCT);
    const [draft] = await settlementsOf("CON-014");
    return { id: draft?.id ?? "", reference: draft?.reference ?? "", jobId: visit.jobId, assignmentId: visit.assignmentId };
  }

  async function addNote(jobId: string, type: string, at: Date): Promise<void> {
    await db.job.update({
      where: { id: jobId },
      data: { operatorNotes: [{ id: "n1", at: at.toISOString(), operatorId: await mikeId(), type, note: "Added the missing hour." }] },
    });
  }

  interface OpsList {
    rows: { reference: string; correctedSince: boolean; gstNotRecorded: boolean; jobs: number }[];
  }

  test("correctedSince is true only for a correction note dated after the draft was made", () => {
    const made = new Date("2026-10-19T00:00:00.000Z");
    const note = (type: string, at: string) => [{ at, operatorId: "u", type, note: "x" }];
    expect(correctedSince(made, [note("correction", "2026-10-19T01:00:00.000Z")])).toBe(true);
    expect(correctedSince(made, [note("correction", "2026-10-18T23:00:00.000Z")])).toBe(false);
    expect(correctedSince(made, [note("general", "2026-10-19T01:00:00.000Z")])).toBe(false);
    expect(correctedSince(made, [null, "junk"])).toBe(false);
    expect(correctedSince(made, [])).toBe(false);
  });

  test("AC8: the Awaiting list flags a draft whose job was corrected after it was made - and only then", async () => {
    const draft = await bobsDraft();
    const flagged = async (): Promise<boolean> => {
      const res = await request(app).get("/api/settlements?view=awaiting").set("Cookie", mike);
      return (res.body as OpsList).rows.find((row) => row.reference === draft.reference)?.correctedSince ?? false;
    };
    expect(await flagged()).toBe(false);
    await addNote(draft.jobId, "correction", new Date(Date.now() - 86_400_000)); // before the draft was made
    expect(await flagged()).toBe(false);
    await addNote(draft.jobId, "correction", new Date(Date.now() + 60_000));
    expect(await flagged()).toBe(true);
  });

  test("AC8: Rebuild supersedes it (who + when), makes a fresh draft with the same period end, emails a fresh link", async () => {
    const draft = await bobsDraft();
    const staleLink = await newLink(draft.id);
    // Mike corrected the job after the draft: Bob is owed another hour.
    await db.assignment.update({ where: { id: draft.assignmentId }, data: { contractorPay: 65_000 } });

    const res = await request(app).post(`/api/settlements/${draft.reference}/rebuild`).set("Cookie", mike);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reference: "CINV-519", replaced: "CINV-518" });

    const [old, fresh] = await settlementsOf("CON-014");
    expect(old).toMatchObject({ status: "superseded", supersededByUserId: await mikeId() });
    expect(old?.supersededAt).not.toBeNull();
    expect(fresh).toMatchObject({ reference: "CINV-519", status: "draft", totalAmount: 65_000 });
    expect(fresh?.periodEnd.toISOString()).toBe(old?.periodEnd.toISOString());
    expect(fresh?.periodStart.toISOString()).toBe(old?.periodStart.toISOString());
    expect(await db.assignment.count({ where: { settlementId: fresh?.id } })).toBe(1);
    // The Monday email for the first draft, and a fresh one for the rebuilt draft.
    expect(await db.notification.count({ where: { type: "settlement_draft" } })).toBe(2);
    expect(await db.notification.count({ where: { type: "settlement_draft", relatedId: fresh?.id } })).toBe(1);

    const dead = await request(app).get(`/api/approve/${staleLink}`);
    expect(dead.status).toBe(410);
    expect((dead.body as { state: string }).state).toBe("replaced");
  });

  test("AC8: Rebuild keeps the older start of a two-week draft", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-07", hours: 1 });
    await runWeekly(db, MONDAY_12_OCT);
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1 });
    await runWeekly(db, MONDAY_19_OCT);
    const twoWeek = (await settlementsOf("CON-014")).find((row) => row.status === "draft");
    await request(app).post(`/api/settlements/${twoWeek?.reference ?? ""}/rebuild`).set("Cookie", mike).expect(200);
    const drafts = (await settlementsOf("CON-014")).filter((row) => row.status === "draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.periodStart.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(drafts[0]?.periodEnd.toISOString().slice(0, 10)).toBe("2026-10-18");
  });

  test("AC8: Rebuild is refused unless it is a draft - 409 'Only a draft can be rebuilt.'", async () => {
    const draft = await bobsDraft();
    await db.contractorSettlement.update({ where: { id: draft.id }, data: { status: "approved", approvedAt: new Date(), contractorGstRegistered: true } });
    const res = await request(app).post(`/api/settlements/${draft.reference}/rebuild`).set("Cookie", mike);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Only a draft can be rebuilt." });
    expect(await settlementsOf("CON-014")).toHaveLength(1);
  });

  test("Rebuild of an unknown invoice is a 404; a contractor cannot rebuild; a visitor is refused", async () => {
    const draft = await bobsDraft();
    await request(app).post("/api/settlements/CINV-999/rebuild").set("Cookie", mike).expect(404);
    await request(app).post(`/api/settlements/${draft.reference}/rebuild`).set("Cookie", bob).expect(403);
    await request(app).post(`/api/settlements/${draft.reference}/rebuild`).expect(401);
    expect((await settlementsOf("CON-014")).filter((row) => row.status === "draft")).toHaveLength(1);
  });
});
