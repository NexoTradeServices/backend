// Feature 1006 -- admin settings screen
//
// AC2  Mike (ops) and Bob (contractor) get 403 from both endpoints; the owner
//      gets 200 from GET
// AC3  the owner changes payment terms 7 -> 14 and saves; the row carries it
// AC4  flipping GST on with an empty businessAbn is refused; the stored
//      value stays false and nothing is half-saved
// AC5  with an ABN entered, the flip saves and stamps gstStatusChangedAt /
//      gstStatusChangedByUserId; a save that does not flip the switch does
//      not restamp
// AC6  operatorEmail is backfilled ops@idelta.com.au by the seed, and the
//      settings PUT can change it (B-004)
import { readFile } from "node:fs/promises";
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
import { settingsRoutes } from "../src/settings/routes.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

const OPERATOR_EMAIL_MIGRATION_SQL = new URL(
  "../prisma/migrations/20260901140000_platform_settings_operator_email/migration.sql",
  import.meta.url,
);

/** A full, valid PUT body matching the base seed -- tests override one field at a time. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gstRegistered: false,
    businessAbn: null,
    gstRatePercent: 10,
    paymentTermsDays: 7,
    serviceReachKm: 25,
    calloutFee: 15_000,
    returnVisitMinimumMinutes: 30,
    maxContractorPartAmount: 15_000,
    operatorPhone: "08 0000 0000",
    operatorEmail: "ops@idelta.com.au",
    displayName: "Perth Trades & Services",
    timezone: "Australia/Perth",
    payoutCycle: "weekly",
    payoutDay: "fri",
    emailProvider: "mailjet",
    smsProvider: "clicksend",
    ...overrides,
  };
}

async function seedCast(): Promise<void> {
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/sign-in/email")
    .send({ email, password: DEV_PASSWORD });
  return cookieHeader(res);
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use(express.json());
  app.use("/api/settings", settingsRoutes(db));
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC2 -- owner-only, both endpoints", () => {
  test("AC2: Mike (ops) gets 403 from GET and PUT /api/settings", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");

    const getRes = await request(app).get("/api/settings").set("Cookie", cookie);
    expect(getRes.status).toBe(403);

    const putRes = await request(app).put("/api/settings").set("Cookie", cookie).send(validBody());
    expect(putRes.status).toBe(403);
  });

  test("AC2: Bob (contractor) gets 403 from GET and PUT /api/settings", async () => {
    await seedCast();
    const cookie = await signInCookie("bob@idelta.com.au");

    const getRes = await request(app).get("/api/settings").set("Cookie", cookie);
    expect(getRes.status).toBe(403);

    const putRes = await request(app).put("/api/settings").set("Cookie", cookie).send(validBody());
    expect(putRes.status).toBe(403);
  });

  test("AC2: the owner gets 200 from GET /api/settings, carrying the seeded values", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app).get("/api/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect((res.body as { operatorEmail: string }).operatorEmail).toBe("ops@idelta.com.au");
  });
});

describe("AC3 -- the owner edits and saves", () => {
  test("AC3: payment terms 7 -> 14 saves and reloads as 14", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const putRes = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ paymentTermsDays: 14 }));
    expect(putRes.status).toBe(200);
    expect((putRes.body as { paymentTermsDays: number }).paymentTermsDays).toBe(14);

    const getRes = await request(app).get("/api/settings").set("Cookie", cookie);
    expect((getRes.body as { paymentTermsDays: number }).paymentTermsDays).toBe(14);

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.paymentTermsDays).toBe(14);
  });
});

describe("AC4 -- the ABN gate refuses an empty ABN", () => {
  test("AC4: flipping GST on with businessAbn empty is refused; the stored value stays false", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ gstRegistered: true, businessAbn: null }));
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toBe("businessAbn");

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.gstRegistered).toBe(false);
    expect(settings.gstStatusChangedAt).toBeNull();
  });
});

describe("AC5 -- with an ABN, the flip saves and stamps the audit pair", () => {
  test("AC5: gstStatusChangedAt / ByUserId stamp to the owner on the flip", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@idelta.com.au" } });

    const before = Date.now();
    const res = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ gstRegistered: true, businessAbn: "51 824 753 556" }));
    expect(res.status).toBe(200);

    const body = res.body as {
      gstRegistered: boolean;
      gstStatusChangedAt: string;
      gstStatusChangedByUserId: string;
      gstStatusChangedBy: { name: string } | null;
    };
    expect(body.gstRegistered).toBe(true);
    expect(new Date(body.gstStatusChangedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(body.gstStatusChangedByUserId).toBe(owner.id);
    expect(body.gstStatusChangedBy?.name).toBe("The owner");
  });

  test("AC5: a save that does not flip gstRegistered does not restamp the audit pair", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ gstRegistered: true, businessAbn: "51 824 753 556" }));
    const firstStamp = (await db.platformSettings.findFirstOrThrow()).gstStatusChangedAt;
    expect(firstStamp).not.toBeNull();

    const res = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ gstRegistered: true, businessAbn: "51 824 753 556", paymentTermsDays: 10 }));
    expect(res.status).toBe(200);

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.gstStatusChangedAt?.getTime()).toBe(firstStamp?.getTime());
  });
});

describe("AC6 -- operatorEmail, backfilled and editable", () => {
  test("AC6: the base seed carries operatorEmail ops@idelta.com.au", async () => {
    await seedBase(db);
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.operatorEmail).toBe("ops@idelta.com.au");
  });

  test("AC6: the migration backfills existing rows via a column DEFAULT", async () => {
    const sql = await readFile(OPERATOR_EMAIL_MIGRATION_SQL, "utf8");
    expect(sql).toContain('ADD COLUMN "operatorEmail" TEXT NOT NULL DEFAULT \'ops@idelta.com.au\'');
  });

  test("AC6: the Business inbox field (PUT) edits operatorEmail", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ operatorEmail: "admin@idelta.com.au" }));
    expect(res.status).toBe(200);
    expect((res.body as { operatorEmail: string }).operatorEmail).toBe("admin@idelta.com.au");

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.operatorEmail).toBe("admin@idelta.com.au");
  });
});
