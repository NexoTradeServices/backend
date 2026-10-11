// Feature 1018 -- the test-data hook the customer-portal browser tests use
//
// POST /api/test-data/customer-login    a labelled customer User with the dev password
//
// The seeded cast has no customer login (Sarah is a guest by design), so a browser test of the
// customer portal makes its own. Non-production only, and only with the test-run cookie.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth } from "../src/auth/config.js";
import { testRunSignal } from "../src/test-data/label.js";
import { mountTestDataRoutes } from "../src/test-data/routes.js";
import { sweepTestData } from "../src/test-data/sweep.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

function buildApp(): Express {
  const app = express();
  app.use(testRunSignal);
  app.all("/api/auth/*splat", toNodeHandler(buildAuth({ client: db })));
  app.use(express.json());
  mountTestDataRoutes(app, db);
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
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
});

describe("the customer-login hook", () => {
  test("with the e2e cookie it makes a labelled customer that can log in, and the sweep removes it", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/test-data/customer-login").set("Cookie", "ts-test-run=e2e");
    expect(res.status).toBe(200);
    const made = res.body as { email: string; name: string; password: string };
    expect(made.password).toBe(DEV_PASSWORD);

    const user = await db.user.findUniqueOrThrow({ where: { email: made.email } });
    expect(user).toMatchObject({ role: "customer", testData: "e2e", name: made.name });

    const signedIn = await request(app).post("/api/auth/sign-in/email").send({ email: made.email, password: made.password });
    expect(signedIn.status).toBe(200);

    await sweepTestData(db, "e2e");
    expect(await db.user.findUnique({ where: { email: made.email } })).toBeNull();
  });

  test("without the test-run cookie it is refused and makes nothing", async () => {
    const before = await db.user.count();
    await request(buildApp()).post("/api/test-data/customer-login").expect(400);
    expect(await db.user.count()).toBe(before);
  });

  test("it does not exist in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = buildApp();
    await request(app).post("/api/test-data/customer-login").set("Cookie", "ts-test-run=e2e").expect(404);
    vi.unstubAllEnvs();
  });
});
