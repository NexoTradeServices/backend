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
//      settings PUT can change it
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
import { Prisma } from "../src/generated/prisma/client.js";
import { settingsRoutes } from "../src/settings/routes.js";
import { agreementRoutes } from "../src/agreements/routes.js";
import { fakeStorage, makePdf } from "./helpers/agreements.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;
const storage = fakeStorage();

const OPERATOR_EMAIL_MIGRATION_SQL = new URL(
  "../prisma/migrations/20260901140000_platform_settings_operator_email/migration.sql",
  import.meta.url,
);

/** A full, valid PUT body matching the base seed -- tests override one field at a time. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gstRegistered: false,
    businessAbn: null,
    legalEntityName: "Trade Services",
    businessAddress: null,
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
  app.use("/api", agreementRoutes(db, { storage: () => storage }));
});

beforeEach(async () => {
  await truncateAll(db);
  storage.files.clear();
  storage.down = false;
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

// Feature 2006 -- the legal identity and the agreement's publishing
const PERTH_ADDRESS = {
  street: "1 Hay Street",
  suburb: "Perth",
  state: "WA",
  country: "Australia",
  postcode: "6000",
  lat: -31.9505,
  lng: 115.8605,
  placeId: "fixture-place-hay-street",
};

describe("2006 AC2 -- the legal identity fields", () => {
  test("AC2: the seed carries the placeholders; the owner saves both fields and they come back on reload", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");

    const before = await request(app).get("/api/settings").set("Cookie", cookie);
    expect(before.body).toMatchObject({ legalEntityName: "Trade Services", businessAbn: "123456789" });
    expect((before.body as { businessAddress: { street: string } }).businessAddress.street).toBe("1 Hay Street");

    const put = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ legalEntityName: "Trade Services Pty Ltd", businessAbn: "51 824 753 556", businessAddress: PERTH_ADDRESS }));
    expect(put.status).toBe(200);

    const after = await request(app).get("/api/settings").set("Cookie", cookie);
    expect(after.body).toMatchObject({ legalEntityName: "Trade Services Pty Ltd", businessAddress: PERTH_ADDRESS });
  });

  test("AC2: an empty legal name or a typed-in (unpicked) address is refused", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const empty = await request(app).put("/api/settings").set("Cookie", cookie).send(validBody({ legalEntityName: "  " }));
    expect(empty.status).toBe(400);
    expect((empty.body as { field: string }).field).toBe("legalEntityName");
    const typed = await request(app).put("/api/settings").set("Cookie", cookie).send(validBody({ businessAddress: { street: "1 Hay" } }));
    expect(typed.status).toBe(400);
    expect((typed.body as { field: string }).field).toBe("businessAddress");
  });

  test("AC2: Mike (ops) cannot read or write either field", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    expect((await request(app).get("/api/settings").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).put("/api/settings").set("Cookie", cookie).send(validBody({ legalEntityName: "X" }))).status).toBe(403);
  });
});

describe("2006 AC3 -- publishing a version", () => {
  async function publishAs(cookie: string, label: string, body: Buffer | string, query = `label=${label}`): Promise<request.Response> {
    return request(app).post(`/api/agreements?${query}`).set("Cookie", cookie).set("Content-Type", "application/pdf").send(body);
  }

  test("AC3: version 1 holds the label, the file's SHA-256, the Cloudinary key, when and by whom, and lists as Current", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const pdf = await makePdf("one");
    const res = await publishAs(cookie, "1", pdf);
    expect(res.status).toBe(201);

    const row = await db.contractorAgreementVersion.findFirstOrThrow({ include: { issuedBy: true } });
    expect(row.version).toBe("1");
    expect(row.documentHash).toBe((await import("node:crypto")).createHash("sha256").update(pdf).digest("hex"));
    expect(storage.files.has(row.storageKey)).toBe(true);
    expect(row.storageKey).toMatch(/^tradeservice\/agreements\//);
    expect(row.issuedBy.email).toBe("owner@idelta.com.au");
    expect(Math.abs(row.issuedAt.getTime() - Date.now())).toBeLessThan(60_000);

    const list = await request(app).get("/api/agreements").set("Cookie", cookie);
    expect(list.body).toMatchObject({ versions: [{ version: "1", current: true, issuedBy: row.issuedBy.name }] });
  });

  test("AC3: only the owner publishes or lists; Mike is refused", async () => {
    await seedCast();
    const mike = await signInCookie("mike@idelta.com.au");
    expect((await publishAs(mike, "1", await makePdf())).status).toBe(403);
    expect((await request(app).get("/api/agreements").set("Cookie", mike)).status).toBe(403);
  });
});

describe("2006 AC4 -- the refusals, each writing nothing", () => {
  async function refused(
    label: string,
    body: Buffer | string,
    message: string,
    field: string,
    status?: number,
  ): Promise<void> {
    const cookie = await signInCookie("owner@idelta.com.au");
    const res = await request(app)
      .post(`/api/agreements?label=${encodeURIComponent(label)}`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/pdf")
      .send(body);
    expect(res.status).toBe(status ?? 400);
    expect(res.body).toMatchObject({ error: message, field });
    expect(await db.contractorAgreementVersion.count()).toBe(0);
  }

  test("AC4: a file that is not a PDF - by its content, even named .pdf", async () => {
    await seedCast();
    await refused("1", "this is not a pdf, whatever its name says", "That isn't a PDF - choose a PDF file.", "file");
  });

  test("AC4: a file over 10MB", async () => {
    await seedCast();
    const big = Buffer.concat([await makePdf(), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    await refused("1", big, "That file is over 10MB - choose a smaller PDF.", "file");
  });

  test("AC4: an empty label, and an already-used one", async () => {
    await seedCast();
    await refused("  ", await makePdf(), "Enter a version label.", "version");
    const cookie = await signInCookie("owner@idelta.com.au");
    await request(app).post("/api/agreements?label=1").set("Cookie", cookie).set("Content-Type", "application/pdf").send(await makePdf());
    const again = await request(app).post("/api/agreements?label=1").set("Cookie", cookie).set("Content-Type", "application/pdf").send(await makePdf("two"));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ field: "version" });
    expect(await db.contractorAgreementVersion.count()).toBe(1);
  });

  test("AC4: an incomplete legal identity", async () => {
    await seedCast();
    await db.platformSettings.updateMany({ data: { businessAbn: null } });
    await refused("1", await makePdf(), "Fill in the legal name, ABN and address in Settings first", "legalIdentity", 409);
    await db.platformSettings.updateMany({ data: { businessAbn: "123456789", businessAddress: Prisma.DbNull } });
    await refused("1", await makePdf(), "Fill in the legal name, ABN and address in Settings first", "legalIdentity", 409);
  });

  test("AC4: Cloudinary unavailable", async () => {
    await seedCast();
    storage.down = true;
    await refused("1", await makePdf(), "Couldn't store the file - try again shortly", "file", 503);
  });
});

describe("2006 AC5 -- the count the dialog shows", () => {
  test("AC5: the list carries the number of ACTIVE contractors the publish will stop", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const all = await db.contractor.count({ where: { status: "active" } });
    expect(all).toBeGreaterThanOrEqual(3);
    expect((await request(app).get("/api/agreements").set("Cookie", cookie)).body).toMatchObject({ activeContractors: all });

    await db.contractor.update({ where: { code: "CON-030" }, data: { status: "suspended" } });
    expect((await request(app).get("/api/agreements").set("Cookie", cookie)).body).toMatchObject({ activeContractors: all - 1 });
  });
});
