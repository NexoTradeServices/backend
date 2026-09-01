// Feature 1010, cast emails go real
//
// AC1  a fresh dev seed carries exactly cast.md's six idelta.com.au addresses;
//      "example.com" appears in no seed file
// AC2  Mike and the owner log in with the re-pointed emails, dev password unchanged
// AC3  a password reset for Bob writes its notification row addressed to
//      bob@idelta.com.au
// AC4  Sarah's address re-points but she stays a guest -- no User row,
//      Customer.userId empty
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { recordingAdapter } from "./helpers/notifications.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { drainOnce } from "../src/notifications/index.js";
import { registerProvider, resetProviders } from "../src/notifications/providers/registry.js";
import type { PrismaClient } from "../src/db/client.js";

const FIXTURES_SEED_FILE = new URL("../src/db/seed/fixtures.ts", import.meta.url);
const AUTH_SEED_FILE = new URL("../src/db/seed/auth.ts", import.meta.url);

let db: PrismaClient;
let auth: Auth;
let app: Express;

const email = recordingAdapter("test-email", "email");

beforeAll(() => {
  db = testClient();
  auth = buildAuth({ client: db });
  app = express();
  app.all("/api/auth/*splat", toNodeHandler(auth));
  app.use(attachSession(auth, db));
  app.use("/api", authRoutes(db));
  registerProvider(email);
});

beforeEach(async () => {
  await truncateAll(db);
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
  await db.platformSettings.updateMany({ data: { emailProvider: email.name } });
  email.reset();
});

afterAll(async () => {
  resetProviders();
  await db.$disconnect();
});

async function signIn(emailAddress: string, password: string): Promise<request.Response> {
  return request(app).post("/api/auth/sign-in/email").send({ email: emailAddress, password });
}

describe("AC1 -- the fresh seed carries the cast's six idelta.com.au addresses", () => {
  test("AC1: mike, owner, bob, dave, priya and sarah all carry their idelta.com.au address", async () => {
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@idelta.com.au" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    const priya = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });

    expect(mike.email).toBe("mike@idelta.com.au");
    expect(owner.email).toBe("owner@idelta.com.au");
    expect(bob.email).toBe("bob@idelta.com.au");
    expect(dave.email).toBe("dave@idelta.com.au");
    expect(priya.email).toBe("priya@idelta.com.au");
    expect(sarah.email).toBe("sarah@idelta.com.au");
  });

  test('AC1: the string "example.com" appears in neither seed file', async () => {
    const fixturesSource = await readFile(FIXTURES_SEED_FILE, "utf8");
    const authSource = await readFile(AUTH_SEED_FILE, "utf8");
    expect(fixturesSource).not.toContain("example.com");
    expect(authSource).not.toContain("example.com");
  });
});

describe("AC2 -- Mike and the owner log in re-pointed, dev password unchanged", () => {
  test("AC2: Mike and the owner sign in with their idelta.com.au address and the unchanged dev password", async () => {
    const mikeRes = await signIn("mike@idelta.com.au", DEV_PASSWORD);
    expect(mikeRes.status).toBe(200);

    const ownerRes = await signIn("owner@idelta.com.au", DEV_PASSWORD);
    expect(ownerRes.status).toBe(200);
  });
});

describe("AC3 -- Bob's password reset notification is addressed to bob@idelta.com.au", () => {
  test("AC3: requesting Bob's reset and draining the queue sends to bob@idelta.com.au", async () => {
    const res = await request(app)
      .post("/api/auth/request-password-reset")
      .send({ email: "bob@idelta.com.au", redirectTo: "https://idelta.com.au/reset-password" });
    expect(res.status).toBe(200);

    await drainOnce(db);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("bob@idelta.com.au");
  });
});

describe("AC4 -- Sarah re-points but stays a guest", () => {
  test("AC4: Sarah carries the re-pointed address, has no User row, and Customer.userId is empty", async () => {
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    expect(sarah.email).toBe("sarah@idelta.com.au");
    expect(sarah.userId).toBeNull();

    const user = await db.user.findUnique({ where: { email: "sarah@idelta.com.au" } });
    expect(user).toBeNull();
  });
});
