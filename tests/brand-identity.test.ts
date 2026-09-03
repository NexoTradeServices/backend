// Feature 1014 -- brand strings go to config
//
// AC1  the migration backfills displayName on the existing row; a fresh
//      seed carries the same value; GET /api/settings returns it
// AC2  the owner changes the name and saves; a reload shows it; a blank
//      name is refused server-side with the field error
// AC3  GET /api/identity needs no login and returns displayName; after a
//      settings save it returns the new name on the very next call
// AC4  the password-reset email signs "-- <name>" in text and HTML, and the
//      provider call carries the name as fromName; the address is unchanged
// AC5  the password-reset template has no name of its own: a context
//      missing platformName throws
// AC8  a literal scan of src/ finds the interim wording nowhere but the
//      seed; MAILJET_FROM_NAME appears nowhere in backend/
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter, seedCast, setProviders, type CastIds } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { settingsRoutes } from "../src/settings/routes.js";
import { identityRoutes } from "../src/settings/identity-routes.js";
import { invalidateIdentityCache } from "../src/settings/identity-cache.js";
import { sendNotification, drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import { passwordResetEmail } from "../src/notifications/templates/password-reset.email.js";
import type { PrismaClient } from "../src/db/client.js";

const INTERIM_WORDING = "Perth Trades & Services";
const DISPLAY_NAME_MIGRATION_SQL = new URL(
  "../prisma/migrations/20260902100000_platform_settings_display_name/migration.sql",
  import.meta.url,
);

let db: PrismaClient;
let auth: Auth;
let app: Express;

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
    displayName: INTERIM_WORDING,
    timezone: "Australia/Perth",
    payoutCycle: "weekly",
    payoutDay: "fri",
    emailProvider: "mailjet",
    smsProvider: "clicksend",
    ...overrides,
  };
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email, password: DEV_PASSWORD });
  return cookieHeader(res);
}

async function seedCastForApp(): Promise<void> {
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
}

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  app.use("/api/identity", identityRoutes(db));
  app.use(express.json());
  app.use("/api/settings", settingsRoutes(db));
});

beforeEach(async () => {
  await truncateAll(db);
  invalidateIdentityCache();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC1 -- the backfilled/seeded name", () => {
  test("AC1: the base seed carries the interim wording", async () => {
    await seedBase(db);
    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.displayName).toBe(INTERIM_WORDING);
  });

  test("AC1: the migration backfills existing rows via a column DEFAULT", async () => {
    const sql = await readFile(DISPLAY_NAME_MIGRATION_SQL, "utf8");
    expect(sql).toContain(`ADD COLUMN "displayName" TEXT NOT NULL DEFAULT 'Perth Trades & Services'`);
  });

  test("AC1: GET /api/settings returns it, owner-only", async () => {
    await seedCastForApp();
    const cookie = await signInCookie("owner@idelta.com.au");
    const res = await request(app).get("/api/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect((res.body as { displayName: string }).displayName).toBe(INTERIM_WORDING);
  });
});

describe("AC2 -- the owner renames it", () => {
  test("AC2: a save changes displayName and a reload shows it", async () => {
    await seedCastForApp();
    const cookie = await signInCookie("owner@idelta.com.au");

    const putRes = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ displayName: "Stand-In Trades" }));
    expect(putRes.status).toBe(200);
    expect((putRes.body as { displayName: string }).displayName).toBe("Stand-In Trades");

    const getRes = await request(app).get("/api/settings").set("Cookie", cookie);
    expect((getRes.body as { displayName: string }).displayName).toBe("Stand-In Trades");

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.displayName).toBe("Stand-In Trades");
  });

  test("AC2: a blank name is refused server-side with the field error, and the row is unchanged", async () => {
    await seedCastForApp();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ displayName: "   " }));
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toBe("displayName");

    const settings = await db.platformSettings.findFirstOrThrow();
    expect(settings.displayName).toBe(INTERIM_WORDING);
  });

  test("AC2: a name over 80 characters is refused server-side", async () => {
    await seedCastForApp();
    const cookie = await signInCookie("owner@idelta.com.au");

    const res = await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ displayName: "x".repeat(81) }));
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toBe("displayName");
  });
});

describe("AC3 -- the public identity endpoint", () => {
  test("AC3: GET /api/identity needs no login and returns the current displayName", async () => {
    await seedBase(db);
    const res = await request(app).get("/api/identity");
    expect(res.status).toBe(200);
    expect((res.body as { displayName: string }).displayName).toBe(INTERIM_WORDING);
  });

  test("AC3: after a settings save, the very next identity call returns the new name", async () => {
    await seedCastForApp();
    const cookie = await signInCookie("owner@idelta.com.au");

    const before = await request(app).get("/api/identity");
    expect((before.body as { displayName: string }).displayName).toBe(INTERIM_WORDING);

    await request(app)
      .put("/api/settings")
      .set("Cookie", cookie)
      .send(validBody({ displayName: "Renamed Trades" }));

    const after = await request(app).get("/api/identity");
    expect((after.body as { displayName: string }).displayName).toBe("Renamed Trades");
  });
});

describe("AC4 -- the password-reset email signs the current name", () => {
  const email = recordingAdapter("test-email-1014", "email");
  let cast: CastIds;

  beforeEach(async () => {
    cast = await seedCast(db);
    registerProvider(email);
    await setProviders(db, { emailProvider: email.name });
    email.reset();
  });

  afterAll(() => {
    resetProviders();
  });

  test("AC4: after a rename, Sarah's reset email signs the stand-in in text and HTML, and the provider call carries it as fromName", async () => {
    await db.platformSettings.update({
      where: { id: (await db.platformSettings.findFirstOrThrow()).id },
      data: { displayName: "Stand-In Trades" },
    });

    await sendNotification(
      {
        type: "password_reset",
        channel: "email",
        recipientType: "customer",
        recipientId: cast.sarahId,
        idempotencyKey: `password_reset:customer:${cast.sarahId}:1014`,
        context: { name: "Sarah", resetUrl: "https://idelta.com.au/reset/abc123" },
      },
      db,
    );
    await drainOnce(db);

    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0];
    expect(sent?.to).toBe("sarah@idelta.com.au");
    expect(sent?.fromName).toBe("Stand-In Trades");
    expect(sent?.message.text).toContain("-- Stand-In Trades");
    expect(sent?.message.html).toContain("-- Stand-In Trades");
  });
});

describe("AC5 -- the template carries no name of its own", () => {
  test("AC5: rendering with no platformName in the context throws", () => {
    expect(() =>
      passwordResetEmail.render({ name: "Sarah", resetUrl: "https://idelta.com.au/reset/abc123" }),
    ).toThrow(/platformName/);
  });
});

describe("AC8 -- the literal scan", () => {
  const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

  async function tsFilesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated") continue; // Prisma's own output, not hand-written code
        files.push(...(await tsFilesUnder(full)));
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
    return files;
  }

  test("AC8: the interim wording appears in src/ only in the seed", async () => {
    const files = await tsFilesUnder(SRC_DIR);
    const hits: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (content.includes(INTERIM_WORDING)) hits.push(path.relative(SRC_DIR, file));
    }
    expect(hits).toEqual(["db/seed/base.ts"]);
  });

  test("AC8: the retired Mailjet sender-name env var appears nowhere in backend/", async () => {
    // Named indirectly, and this file is excluded from its own walk --
    // spelling the var plainly here would trip the scan on itself.
    const RETIRED_VAR = ["MAILJET", "FROM", "NAME"].join("_");
    const backendDir = fileURLToPath(new URL("..", import.meta.url));
    const thisFile = fileURLToPath(import.meta.url);
    const skip = new Set(["node_modules", "dist", "generated", ".git"]);

    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await walk(full)));
        } else if (entry.name.endsWith(".ts") || entry.name === ".env.example") {
          files.push(full);
        }
      }
      return files;
    }

    const files = (await walk(backendDir)).filter((file) => file !== thisFile);
    const hits: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (content.includes(RETIRED_VAR)) hits.push(path.relative(backendDir, file));
    }
    expect(hits).toEqual([]);
  });
});
