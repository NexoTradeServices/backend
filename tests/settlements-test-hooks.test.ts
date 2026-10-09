// Feature 6003 -- the test-data hooks the settlement browser tests and UAT hand checks use
//
// POST /api/test-data/settlements/run                    the Monday run as of `now`
// POST /api/test-data/settlements/:reference/approve-link a fresh approve link for a labelled settlement
// POST /api/test-data/jobs/:reference/correction-note    the `correction` note Correct & reissue will write
//
// Non-production only; with a test-run cookie the run sweeps that label's own work and nothing else.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { MONDAY_19_OCT, completedVisit } from "./helpers/settlements.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { approveRoutes } from "../src/approve/routes.js";
import { testRunSignal } from "../src/test-data/label.js";
import { mountTestDataRoutes } from "../src/test-data/routes.js";
import { correctedSince } from "../src/settlements/service.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

function buildApp(): Express {
  const app = express();
  app.use(testRunSignal);
  app.use(express.json());
  mountTestDataRoutes(app, db);
  app.use("/api/approve", approveRoutes(db));
  return app;
}

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
  await seedAuthFixtures(db);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetReferenceSequences(db);
});

const E2E = "ts-test-run=e2e";
const RUN = { now: MONDAY_19_OCT.toISOString() };

describe("the run hook", () => {
  test("with the e2e cookie it sweeps only e2e work - another label's visit stays where it was", async () => {
    const mine = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1, testData: "e2e" });
    const owners = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-15", hours: 1, testData: "uat-6003" });
    const res = await request(buildApp()).post("/api/test-data/settlements/run").set("Cookie", E2E).send(RUN);
    expect(res.status).toBe(200);
    expect((res.body as { made: unknown[] }).made).toHaveLength(1);

    const draft = await db.contractorSettlement.findFirstOrThrow();
    expect(draft.testData).toBe("e2e");
    expect(draft.totalAmount).toBe(20_000);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: mine.assignmentId } })).settlementId).toBe(draft.id);
    expect((await db.assignment.findUniqueOrThrow({ where: { id: owners.assignmentId } })).settlementId).toBeNull();
  });

  test("with the e2e cookie it leaves another label's draft alone - and makes none beside it", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-13", hours: 1, testData: "uat-6003" });
    await request(buildApp()).post("/api/test-data/settlements/run").send(RUN).expect(200);
    const owners = await db.contractorSettlement.findFirstOrThrow();
    expect(owners.testData).toBe("uat-6003");

    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1, testData: "e2e" });
    const res = await request(buildApp()).post("/api/test-data/settlements/run").set("Cookie", E2E).send(RUN);
    expect((res.body as { made: unknown[] }).made).toEqual([]);
    const all = await db.contractorSettlement.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: owners.id, status: "draft" });
  });

  test("without a cookie it is the whole run, whatever the label", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1, testData: "uat-6003" });
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-14", hours: 1, testData: "e2e" });
    const res = await request(buildApp()).post("/api/test-data/settlements/run").send(RUN);
    expect((res.body as { made: unknown[] }).made).toHaveLength(2);
  });

  test("a 'now' that is not a date-time is refused", async () => {
    await request(buildApp()).post("/api/test-data/settlements/run").send({ now: "next monday" }).expect(400);
    await request(buildApp()).post("/api/test-data/settlements/run").send({ now: 5 }).expect(400);
  });

  test("it does not exist in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = buildApp();
    await request(app).post("/api/test-data/settlements/run").send(RUN).expect(404);
    await request(app).post("/api/test-data/settlements/CINV-518/approve-link").expect(404);
    await request(app).post("/api/test-data/jobs/JOB-1043/correction-note").expect(404);
  });
});

describe("the approve-link hook", () => {
  test("mints a working link for a settlement labelled as test data, and refuses a real one", async () => {
    await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1, testData: "e2e" });
    await completedVisit(db, { contractorCode: "CON-021", day: "2026-10-14", hours: 1 });
    await request(buildApp()).post("/api/test-data/settlements/run").send(RUN).expect(200);
    const labelled = await db.contractorSettlement.findFirstOrThrow({ where: { testData: "e2e" } });
    const real = await db.contractorSettlement.findFirstOrThrow({ where: { testData: null } });

    const res = await request(buildApp()).post(`/api/test-data/settlements/${labelled.reference}/approve-link`);
    expect(res.status).toBe(200);
    const { path } = res.body as { url: string; path: string };
    expect(path).toMatch(/^\/approve\/[\w-]+$/);
    const opened = await request(buildApp()).get(`/api${path}`);
    expect(opened.status).toBe(200);
    expect((opened.body as { invoice: { reference: string } }).invoice.reference).toBe(labelled.reference);

    await request(buildApp()).post(`/api/test-data/settlements/${real.reference}/approve-link`).expect(404);
    await request(buildApp()).post("/api/test-data/settlements/CINV-404/approve-link").expect(404);
  });
});

describe("the correction-note hook", () => {
  test("writes a correction note dated now onto a labelled job, which flags a draft made before it", async () => {
    const visit = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1, testData: "e2e" });
    await request(buildApp()).post("/api/test-data/settlements/run").send(RUN).expect(200);
    const draft = await db.contractorSettlement.findFirstOrThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await request(buildApp()).post(`/api/test-data/jobs/${visit.jobReference}/correction-note`).expect(200);
    const job = await db.job.findUniqueOrThrow({ where: { id: visit.jobId } });
    expect(job.operatorNotes).toEqual([expect.objectContaining({ type: "correction" })]);
    expect(correctedSince(draft.createdAt, [job.operatorNotes])).toBe(true);
  });

  test("refuses a job that is not test data", async () => {
    const visit = await completedVisit(db, { contractorCode: "CON-014", day: "2026-10-14", hours: 1 });
    await request(buildApp()).post(`/api/test-data/jobs/${visit.jobReference}/correction-note`).expect(404);
  });
});
