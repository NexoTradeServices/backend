// Feature 2001 -- contractor onboarding (Mike's path)
//
// AC1  Mike/the owner see Bob, Dave, Priya, all Not ready to dispatch;
//      Priya names "insurance renewal (expired)", all three name "service
//      area (not set up yet)"; Bob (contractor) gets 403 from every endpoint
// AC2  Add a contractor with just name/phone/email: a Contractor + User (no
//      credential) + one queued contractor_onboarding Notification
// AC3  the queued welcome email renders with the display name, a
//      set-password link, no "reset"; the link sets a password and logs in
// AC4  saving /new with mike's email is refused, nothing written
// AC5  a full trade row round-trips; rates stored as whole cents
// AC6  a blank licence expiry refuses the whole save; a past expiry saves
//      with a warning-worthy state and names the missing item
// AC7  suspending one of Bob's trades stamps the audit pair; reactivating
//      stamps it again
// AC8  deactivating Bob stamps the audit pair, kills his session, and his
//      next correct-password login carries the operatorPhone message;
//      wrong password stays the generic refusal
// AC9  reactivating Bob stamps the pair and his old password logs him in
// AC10 Resend mints a fresh notification and the earlier link dies
// AC12 the migration/seed shape: Bob and Dave carry insurance + payout,
//      Priya's insurance is already expired
// 6003 AC1 GST registration is a three-way answer (not asked, yes, no): not asked is
//      Not ready, once answered it cannot go back, the migration maps false -> empty
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
import { contractorRoutes } from "../src/contractors/routes.js";
import { getTemplate } from "../src/notifications/templates/registry.js";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

async function seedCast(): Promise<void> {
  await seedBase(db);
  await seedFixtures(db);
  await seedAuthFixtures(db);
}

/** Feature 2006: a published agreement, written straight to the table (the publish endpoint is tested in tests/contractor-agreement.test.ts). */
async function publishAgreement(label: string): Promise<{ id: string }> {
  const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@idelta.com.au" } });
  return db.contractorAgreementVersion.create({
    data: { version: label, storageKey: `tradeservice/agreements/${label}.pdf`, documentHash: "ab".repeat(32), issuedByUserId: owner.id },
  });
}

function cookieHeader(res: request.Response): string {
  const raw = res.headers["set-cookie"] as string[] | string | undefined;
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error(`no session cookie in response: ${JSON.stringify(cookies)}`);
  return sessionCookie.split(";")[0];
}

async function signInCookie(email: string, password: string = DEV_PASSWORD): Promise<string> {
  const res = await request(app).post("/api/auth/sign-in/email").send({ email, password });
  return cookieHeader(res);
}

function tokenFromResetUrl(resetUrl: string): string {
  const match = /\/reset-password\/([^?]+)/.exec(resetUrl);
  if (!match?.[1]) throw new Error(`could not read a token out of ${resetUrl}`);
  return match[1];
}

async function latestInviteToken(email: string): Promise<{ token: string; context: { name?: string; resetUrl?: string } }> {
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const notification = await db.notification.findFirstOrThrow({
    where: { recipientType: "user", recipientId: user.id, type: "contractor_onboarding" },
    orderBy: { createdAt: "desc" },
  });
  const context = notification.context as { name?: string; resetUrl?: string };
  if (!context.resetUrl) throw new Error("notification carries no resetUrl");
  return { token: tokenFromResetUrl(context.resetUrl), context };
}

function validTradeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trade: "Plumbing",
    contractorCalloutRate: 20_000,
    contractorStandardRate: 15_000,
    licenceNumber: "PL-8841",
    licenceExpiry: "2028-05-31",
    active: true,
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "New Contractor",
    email: "newbie@idelta.com.au",
    phone: "0412 345 678",
    ...overrides,
  };
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
  app.use("/api/contractors", contractorRoutes(db, auth));
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("AC1 -- the seeded list, ops+owner, Bob refused", () => {
  // Feature 2002, decision 13: Bob's fixture carries a saved service area
  // (lastRadiusKm 30 + a fixed served-postcode list). Feature 4002, plan
  // decision 16 (AC36): Dave's fixture now carries one too (Victoria Park,
  // 25km) -- Ready to dispatch on unchanged seed data, since a service area
  // was his only gap. Priya still names "service area (not set up yet)":
  // she has never saved one. The address check dropped from readyToDispatch
  // (design, "Managing the contractor record" -- address never counts) is
  // what makes Bob and Dave ready straight from the fixture seed: neither's
  // fixture gives him an address.
  test("AC1: Mike sees Bob and Dave ready; Priya Not ready, her insurance expired and no service area", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");

    const res = await request(app).get("/api/contractors").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const rows = res.body as { code: string; status: string; ready: boolean; missing: string[] }[];
    expect(rows).toHaveLength(3);

    for (const row of rows) {
      expect(row.status).toBe("active");
    }
    const bob = rows.find((r) => r.code === "CON-014");
    const dave = rows.find((r) => r.code === "CON-021");
    const priya = rows.find((r) => r.code === "CON-030");
    expect(bob?.ready).toBe(true);
    expect(dave?.ready).toBe(true);
    expect(priya?.ready).toBe(false);
    expect(bob?.missing).not.toContain("service area (not set up yet)");
    expect(dave?.missing).not.toContain("service area (not set up yet)");
    expect(priya?.missing).toContain("service area (not set up yet)");
    expect(priya?.missing).toContain("insurance renewal (expired)");
  });

  test("AC1: the owner sees the same list", async () => {
    await seedCast();
    const cookie = await signInCookie("owner@idelta.com.au");
    const res = await request(app).get("/api/contractors").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBe(3);
  });

  test("AC1: Bob (contractor) gets 403 from every endpoint", async () => {
    await seedCast();
    const cookie = await signInCookie("bob@idelta.com.au");

    expect((await request(app).get("/api/contractors").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get("/api/contractors/CON-014").set("Cookie", cookie)).status).toBe(403);
    expect(
      (await request(app).post("/api/contractors").set("Cookie", cookie).send(validBody())).status,
    ).toBe(403);
    expect(
      (await request(app).put("/api/contractors/CON-014").set("Cookie", cookie).send(validBody())).status,
    ).toBe(403);
  });
});

describe("trade options -- the frontend's trade-row select, ops-accessible (not the pricing pen)", () => {
  test("Mike gets the seeded trade names; Bob (contractor) is refused", async () => {
    await seedCast();
    const mike = await signInCookie("mike@idelta.com.au");
    const res = await request(app).get("/api/contractors/trade-options").set("Cookie", mike);
    expect(res.status).toBe(200);
    expect((res.body as { trades: string[] }).trades).toEqual(
      expect.arrayContaining(["Plumbing", "Electrical", "Air conditioning"]),
    );

    const bob = await signInCookie("bob@idelta.com.au");
    expect(
      (await request(app).get("/api/contractors/trade-options").set("Cookie", bob)).status,
    ).toBe(403);
  });
});

describe("AC2 -- add a contractor with just the three required fields", () => {
  test("AC2: saving creates the Contractor, a passwordless User, and one queued invite", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");

    const res = await request(app)
      .post("/api/contractors")
      .set("Cookie", cookie)
      .send(validBody());
    expect(res.status).toBe(201);
    const body = res.body as { code: string; ready: boolean; missing: string[]; hasCredential: boolean };
    expect(body.code).toMatch(/^CON-\d+$/);
    expect(body.ready).toBe(false);
    expect(body.hasCredential).toBe(false);
    expect(body.missing.length).toBeGreaterThan(0);

    const user = await db.user.findUniqueOrThrow({ where: { email: "newbie@idelta.com.au" } });
    expect(user.role).toBe("contractor");
    const credential = await db.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
    expect(credential).toBeNull();

    const notifications = await db.notification.findMany({
      where: { recipientType: "user", recipientId: user.id, type: "contractor_onboarding" },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.channel).toBe("email");
  });
});

describe("AC3 -- the invite email, and using its link", () => {
  test("AC3: rendered with the display name, a set-password link, never the word reset; the link sets a password and logs in at /contractor", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    await request(app).post("/api/contractors").set("Cookie", cookie).send(validBody());

    const { token, context } = await latestInviteToken("newbie@idelta.com.au");
    const settings = await db.platformSettings.findFirstOrThrow();
    const template = getTemplate("contractor_onboarding", "email");
    if (!template) throw new Error("contractor_onboarding email template is not registered");
    const rendered = template.render({ ...context, platformName: settings.displayName });

    expect(rendered.subject).toContain(settings.displayName);
    expect(rendered.text).toContain(settings.displayName);
    // The word "reset" is banned from the WORDING, not from the URL path
    // Better Auth's own route happens to carry -- strip the link first.
    const proseOnly = rendered.text.replace(context.resetUrl ?? "", "");
    expect(proseOnly.toLowerCase()).not.toContain("reset");
    expect(rendered.text).toContain(context.resetUrl);

    const setRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "a-brand-new-password-1", token });
    expect(setRes.status).toBe(200);

    const loginRes = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "newbie@idelta.com.au", password: "a-brand-new-password-1" });
    expect(loginRes.status).toBe(200);

    const fullDetail = await request(app).get("/api/contractors").set("Cookie", cookie);
    const row = (fullDetail.body as { email: string; hasCredential: boolean }[]).find(
      (r) => r.email === "newbie@idelta.com.au",
    );
    expect(row?.hasCredential).toBe(true);
  });
});

describe("AC4 -- an email that already has a login is refused", () => {
  test("AC4: saving /new with mike's email writes nothing", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await db.contractor.count();

    const res = await request(app)
      .post("/api/contractors")
      .set("Cookie", cookie)
      .send(validBody({ email: "mike@idelta.com.au" }));
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toBe("email");
    expect((res.body as { error?: string }).error).toBe("This email already has a login");

    expect(await db.contractor.count()).toBe(before);
    expect(await db.notification.count({ where: { type: "contractor_onboarding" } })).toBe(0);
  });
});

describe("AC5 -- a full trade row round-trips as whole cents", () => {
  test("AC5: Bob's Plumbing row saves and reopens with every value intact", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });

    const res = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(
        validBody({
          name: bob.name,
          email: bob.email,
          phone: bob.phone,
          businessName: bob.businessName,
          abn: bob.abn,
          address: bob.address,
          emergencyContactName: bob.emergencyContactName,
          emergencyContactPhone: bob.emergencyContactPhone,
          specialties: [validTradeRow()],
          insurer: "QBE",
          insurancePolicyNo: "PL-2291-884",
          insuranceExpiry: "2028-02-28",
          payoutBsb: "066-000",
          payoutAccountNo: "12345678",
          payoutAccountName: "B Reilly",
        }),
      );
    expect(res.status).toBe(200);

    const stored = await db.contractorSpecialty.findFirstOrThrow({
      where: { contractorId: bob.id, trade: "Plumbing" },
    });
    expect(stored.contractorCalloutRate).toBe(20_000);
    expect(stored.contractorStandardRate).toBe(15_000);
    expect(stored.licenceNumber).toBe("PL-8841");

    const reopen = await request(app).get(`/api/contractors/${bob.code}`).set("Cookie", cookie);
    const missing = (reopen.body as { missing: string[] }).missing;
    // Address never counts toward Ready to dispatch (design, "Managing the
    // contractor record"); his fixture-seeded service area (2002, decision
    // 13) covers the last blocking item, and his fixture-seeded own address
    // + emergency contact (2003, AC6) cover the two non-blocking nudges --
    // this PUT round-trips all three, leaving him with nothing missing.
    expect(missing).toEqual([]);
  });

  test("a legacy street-only address (pre-2001 migration, AC12) round-trips on an ordinary Save; a genuinely malformed one is still refused", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const bob = await db.contractor.update({
      where: { code: "CON-014" },
      data: { address: { street: "Fremantle WA 6160" } },
    });

    const ok = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, specialties: [validTradeRow()] }));
    expect(ok.status).toBe(200);
    expect((ok.body as { address: { street: string } }).address).toEqual({ street: "Fremantle WA 6160" });

    const bad = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(
        validBody({
          name: bob.name,
          email: bob.email,
          phone: bob.phone,
          specialties: [validTradeRow()],
          address: { foo: "bar" },
        }),
      );
    expect(bad.status).toBe(400);
    expect((bad.body as { field?: string }).field).toBe("address");
  });
});

describe("AC6 -- a trade row is all or nothing", () => {
  test("AC6: a blank licence expiry refuses the whole save; nothing is written", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await db.contractor.count();

    const res = await request(app)
      .post("/api/contractors")
      .set("Cookie", cookie)
      .send(validBody({ specialties: [validTradeRow({ licenceExpiry: "" })] }));
    expect(res.status).toBe(400);
    expect((res.body as { field?: string }).field).toContain("specialties[0]");
    expect(await db.contractor.count()).toBe(before);
  });

  test("AC6: a past expiry saves and names the missing licence item", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");

    const res = await request(app)
      .post("/api/contractors")
      .set("Cookie", cookie)
      .send(validBody({ email: "expiredtrade@idelta.com.au", specialties: [validTradeRow({ licenceExpiry: "2020-01-01" })] }));
    expect(res.status).toBe(201);
    expect((res.body as { missing: string[] }).missing).toContain(
      "at least one active trade with a current licence",
    );
  });
});

describe("AC7 -- per-trade suspend/reactivate stamps the audit pair", () => {
  test("AC7: suspending Bob's Plumbing trade stamps who and when; reactivating stamps it again", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });

    const suspendRes = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, specialties: [validTradeRow({ active: false })] }));
    expect(suspendRes.status).toBe(200);

    const suspended = await db.contractorSpecialty.findFirstOrThrow({ where: { contractorId: bob.id, trade: "Plumbing" } });
    expect(suspended.status).toBe("suspended");
    expect(suspended.statusChangedByUserId).toBe(mike.id);
    expect(suspended.statusChangedAt).not.toBeNull();

    const reactivateRes = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, specialties: [validTradeRow({ active: true })] }));
    expect(reactivateRes.status).toBe(200);
    const reactivated = await db.contractorSpecialty.findFirstOrThrow({ where: { contractorId: bob.id, trade: "Plumbing" } });
    expect(reactivated.status).toBe("active");
    expect(reactivated.statusChangedAt?.getTime()).toBeGreaterThanOrEqual(suspended.statusChangedAt?.getTime() ?? 0);
  });
});

describe("AC8 -- deactivating Bob", () => {
  test("AC8: the audit pair stamps, his session dies, and correct-password login carries the operatorPhone message", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const mike = await db.user.findUniqueOrThrow({ where: { email: "mike@idelta.com.au" } });
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const settings = await db.platformSettings.findFirstOrThrow();

    const bobCookie = await signInCookie("bob@idelta.com.au");
    expect((await request(app).get("/api/me").set("Cookie", bobCookie)).status).toBe(200);

    const res = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, active: false, specialties: [validTradeRow()] }));
    expect(res.status).toBe(200);

    const updated = await db.contractor.findUniqueOrThrow({ where: { id: bob.id } });
    expect(updated.status).toBe("suspended");
    expect(updated.statusChangedByUserId).toBe(mike.id);
    expect(updated.statusChangedAt).not.toBeNull();

    // his existing session is refused on its next request
    expect((await request(app).get("/api/me").set("Cookie", bobCookie)).status).toBe(401);

    // correct password, deactivated -> the specific message, no cookie
    const correctLogin = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "bob@idelta.com.au", password: DEV_PASSWORD });
    expect(correctLogin.status).toBe(403);
    expect((correctLogin.body as { code?: string }).code).toBe("ACCOUNT_NOT_ACTIVE");
    expect((correctLogin.body as { message?: string }).message).toBe(
      `Your account is not active. Call us on ${settings.operatorPhone}.`,
    );
    expect(correctLogin.headers["set-cookie"]).toBeUndefined();

    // wrong password, deactivated -> the ordinary generic refusal
    const wrongLogin = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "bob@idelta.com.au", password: "definitely-wrong" });
    expect(wrongLogin.status).not.toBe(200);
    expect((wrongLogin.body as { code?: string }).code).not.toBe("ACCOUNT_NOT_ACTIVE");
  });
});

describe("AC9 -- reactivating Bob", () => {
  test("AC9: the pair is stamped, no email is queued, and his old password logs him in", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });

    await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, active: false, specialties: [validTradeRow()] }));

    const notificationsBefore = await db.notification.count();

    const res = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, active: true, specialties: [validTradeRow()] }));
    expect(res.status).toBe(200);

    const reactivated = await db.contractor.findUniqueOrThrow({ where: { id: bob.id } });
    expect(reactivated.status).toBe("active");
    expect(reactivated.statusChangedAt).not.toBeNull();
    expect(await db.notification.count()).toBe(notificationsBefore);

    const loginRes = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "bob@idelta.com.au", password: DEV_PASSWORD });
    expect(loginRes.status).toBe(200);
  });
});

describe("AC10 -- Resend welcome email", () => {
  test("AC10: mints a fresh notification and the earlier link dies", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const created = await request(app).post("/api/contractors").set("Cookie", cookie).send(validBody());
    const code = (created.body as { code: string }).code;

    const first = await latestInviteToken("newbie@idelta.com.au");

    const resendRes = await request(app)
      .post(`/api/contractors/${code}/resend-welcome`)
      .set("Cookie", cookie);
    expect(resendRes.status).toBe(200);

    const second = await latestInviteToken("newbie@idelta.com.au");
    expect(second.token).not.toBe(first.token);

    const oldLinkRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "a-brand-new-password-1", token: first.token });
    expect(oldLinkRes.status).not.toBe(200);

    const newLinkRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "a-brand-new-password-1", token: second.token });
    expect(newLinkRes.status).toBe(200);
  });
});

describe("AC12 -- the migration and seed shape", () => {
  test("AC12: Bob and Dave carry insurance and payout details; Priya's insurance is already expired", async () => {
    await seedCast();
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" } });
    const priya = await db.contractor.findUniqueOrThrow({ where: { code: "CON-030" } });

    for (const contractor of [bob, dave]) {
      expect(contractor.insurer).not.toBeNull();
      expect(contractor.insurancePolicyNo).not.toBeNull();
      expect(contractor.insuranceExpiry).not.toBeNull();
      expect(contractor.insuranceExpiry && contractor.insuranceExpiry.getTime()).toBeGreaterThan(Date.now());
      expect(contractor.payoutBsb).not.toBeNull();
      expect(contractor.payoutAccountNo).not.toBeNull();
      expect(contractor.payoutAccountName).not.toBeNull();
    }

    expect(priya.insuranceExpiry).not.toBeNull();
    expect(priya.insuranceExpiry && priya.insuranceExpiry.getTime()).toBeLessThan(Date.now());

    // Feature 2003, AC6: his own address + emergency contact are seeded too,
    // so his dashboard shows no readiness panel at all.
    expect(bob.address).not.toBeNull();
    expect(bob.coreLocation).not.toBeNull();
    expect(bob.emergencyContactName).not.toBeNull();
    // agreementVersion/agreementAcceptedAt: still nullable/optional, unset --
    // acceptance is 2006's, out of this feature's scope.
    expect(bob.agreementVersion).toBeNull();
    expect(bob.agreementAcceptedAt).toBeNull();
  });
});

describe("decision 8 -- a specialty used on a job cannot be removed", () => {
  test("removing a trade row that has an Assignment on it is refused server-side", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const plumbing = bob.specialties.find((s) => s.trade === "Plumbing");
    if (!plumbing) throw new Error("fixture Bob has no Plumbing specialty");

    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const job = await db.job.create({
      data: {
        reference: "JOB-9001",
        customerId: sarah.id,
        serviceTypeId: serviceType.id,
        customerCalloutRate: serviceType.customerCalloutRate,
        customerStandardRate: serviceType.customerStandardRate,
        postcode: "6163",
        serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.07, lng: 115.78, placeId: "x" },
        timezone: "Australia/Perth",
        source: "web",
        preferredWindow: "morning",
        preferredDate: new Date(),
      },
    });
    await db.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: plumbing.id },
    });

    const res = await request(app)
      .put(`/api/contractors/${bob.code}`)
      .set("Cookie", cookie)
      .send(validBody({ name: bob.name, email: bob.email, phone: bob.phone, specialties: [] }));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("cannot be removed");

    const stillThere = await db.contractorSpecialty.findUnique({ where: { id: plumbing.id } });
    expect(stillThere).not.toBeNull();
  });
});

describe("2006 AC7 / AC14 -- the agreement on the ops list and record", () => {
  interface Dto {
    code: string;
    ready: boolean;
    missing: string[];
    agreement: { state: string; currentVersion: string | null; acceptedVersion: string | null; acceptedAt: string | null; recordAvailable: boolean };
  }

  test("AC7: Bob is Not ready on the ops list and record, naming the agreement", async () => {
    await seedCast();
    await publishAgreement("1");
    const mike = await signInCookie("mike@idelta.com.au");
    const list = (await request(app).get("/api/contractors").set("Cookie", mike)).body as Dto[];
    const bob = list.find((r) => r.code === "CON-014");
    expect(bob?.ready).toBe(false);
    expect(bob?.missing).toContain("contractor agreement (not accepted)");
    const record = (await request(app).get("/api/contractors/CON-014").set("Cookie", mike)).body as Dto;
    expect(record.ready).toBe(false);
    expect(record.missing).toContain("contractor agreement (not accepted)");
  });

  test("AC14: nothing published reads none_published", async () => {
    await seedCast();
    const mike = await signInCookie("mike@idelta.com.au");
    const record = (await request(app).get("/api/contractors/CON-014").set("Cookie", mike)).body as Dto;
    expect(record.agreement).toMatchObject({ state: "none_published", currentVersion: null, recordAvailable: false });
  });

  test("AC14: Bob accepted version 2 reads accepted with its date and a record to open; Dave reads not yet accepted", async () => {
    await seedCast();
    await publishAgreement("1");
    await new Promise((r) => setTimeout(r, 5));
    await publishAgreement("2");
    const acceptedAt = new Date("2026-09-09T02:00:00Z");
    await db.contractor.update({ where: { code: "CON-014" }, data: { agreementVersion: "2", agreementAcceptedAt: acceptedAt } });
    const mike = await signInCookie("mike@idelta.com.au");

    const bob = (await request(app).get("/api/contractors/CON-014").set("Cookie", mike)).body as Dto;
    expect(bob.agreement).toEqual({
      state: "accepted",
      currentVersion: "2",
      acceptedVersion: "2",
      acceptedAt: acceptedAt.toISOString(),
      recordAvailable: true,
    });
    const dave = (await request(app).get("/api/contractors/CON-021").set("Cookie", mike)).body as Dto;
    expect(dave.agreement).toMatchObject({ state: "not_accepted", currentVersion: "2", acceptedVersion: null, recordAvailable: false });
  });
});

describe("6003 AC1 -- GST registration is a three-way answer", () => {
  const GST_ITEM = "GST registration (not asked)";

  async function record(cookie: string, code: string): Promise<{ gstRegistered: boolean | null; ready: boolean; missing: string[] }> {
    const res = await request(app).get(`/api/contractors/${code}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    return res.body as { gstRegistered: boolean | null; ready: boolean; missing: string[] };
  }

  test("AC1: the seed reads yes for Bob, no for Dave, not asked for Priya - and only Priya shows the item", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    expect((await record(cookie, "CON-014")).gstRegistered).toBe(true);
    expect((await record(cookie, "CON-021")).gstRegistered).toBe(false);
    const priya = await record(cookie, "CON-030");
    expect(priya.gstRegistered).toBeNull();
    expect(priya.missing).toContain(GST_ITEM);
    expect((await record(cookie, "CON-014")).missing).not.toContain(GST_ITEM);
  });

  test("AC1: adding a contractor without an answer leaves it not asked, and Not ready with the item", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const res = await request(app).post("/api/contractors").set("Cookie", cookie).send(validBody());
    expect(res.status).toBe(201);
    const body = res.body as { gstRegistered: boolean | null; ready: boolean; missing: string[] };
    expect(body.gstRegistered).toBeNull();
    expect(body.ready).toBe(false);
    expect(body.missing).toContain(GST_ITEM);
  });

  test("AC1: yes, no and not asked are all accepted when adding; anything else is refused", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const answers: [string, boolean | null][] = [["a", true], ["b", false], ["c", null]];
    for (const [tag, answer] of answers) {
      const res = await request(app)
        .post("/api/contractors")
        .set("Cookie", cookie)
        .send(validBody({ email: `${tag}@idelta.com.au`, gstRegistered: answer }));
      expect(res.status).toBe(201);
      expect((res.body as { gstRegistered: boolean | null }).gstRegistered).toBe(answer);
    }
    const bad = await request(app).post("/api/contractors").set("Cookie", cookie).send(validBody({ email: "d@idelta.com.au", gstRegistered: "yes" }));
    expect(bad.status).toBe(400);
    expect((bad.body as { field: string }).field).toBe("gstRegistered");
  });

  test("AC1: Mike records an answer on the record, and the item goes", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const before = await record(cookie, "CON-030");
    const res = await request(app).put("/api/contractors/CON-030").set("Cookie", cookie).send({ ...before, gstRegistered: false, specialties: [] });
    expect(res.status).toBe(200);
    const after = await record(cookie, "CON-030");
    expect(after.gstRegistered).toBe(false);
    expect(after.missing).not.toContain(GST_ITEM);
  });

  test("AC1: once answered it cannot go back to not asked - 400 with a field error", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const bob = await record(cookie, "CON-014");
    const res = await request(app)
      .put("/api/contractors/CON-014")
      .set("Cookie", cookie)
      .send({ ...bob, gstRegistered: null, specialties: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Once answered, GST registration is yes or no.", field: "gstRegistered" });
    expect((await record(cookie, "CON-014")).gstRegistered).toBe(true);
  });

  test("AC1: a save that does not carry the answer leaves it exactly as it was", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const dave = await record(cookie, "CON-021");
    const { gstRegistered: _left, ...withoutAnswer } = dave;
    void _left;
    await request(app).put("/api/contractors/CON-021").set("Cookie", cookie).send({ ...withoutAnswer, specialties: [] }).expect(200);
    expect((await record(cookie, "CON-021")).gstRegistered).toBe(false);
  });

  test("AC1: not asked stays not asked when a save carries null", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const priya = await record(cookie, "CON-030");
    await request(app).put("/api/contractors/CON-030").set("Cookie", cookie).send({ ...priya, gstRegistered: null, specialties: [] }).expect(200);
    expect((await record(cookie, "CON-030")).gstRegistered).toBeNull();
  });

  test("AC1: the missing item is Mike's, blocks dispatch, and shows on the ops list", async () => {
    await seedCast();
    const cookie = await signInCookie("mike@idelta.com.au");
    const res = await request(app).get("/api/contractors").set("Cookie", cookie);
    const priya = (res.body as { code: string; ready: boolean; missing: string[] }[]).find((row) => row.code === "CON-030");
    expect(priya?.missing).toContain(GST_ITEM);
    await db.contractor.update({ where: { code: "CON-014" }, data: { gstRegistered: null } });
    const bob = ((await request(app).get("/api/contractors").set("Cookie", cookie)).body as { code: string; ready: boolean; missing: string[] }[]).find((row) => row.code === "CON-014");
    expect(bob).toMatchObject({ ready: false });
    expect(bob?.missing).toEqual([GST_ITEM]);
  });

  test("AC1: the migration - the column has no default, an old no reads not asked, an old yes stays yes", async () => {
    await seedCast();
    const column = await db.$queryRaw<{ is_nullable: string; column_default: string | null }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'Contractor' AND column_name = 'gstRegistered'`;
    expect(column[0]).toEqual({ is_nullable: "YES", column_default: null });

    // The migration's own statement: every old "false" -> empty, "true" untouched.
    const sql = readFileSync(new URL("../prisma/migrations/20261011100000_settlement_run/migration.sql", import.meta.url), "utf8");
    const statement = /^UPDATE "Contractor"[^;]*;/m.exec(sql)?.[0];
    expect(statement).toBeDefined();
    await db.contractor.update({ where: { code: "CON-014" }, data: { gstRegistered: true } });
    await db.contractor.update({ where: { code: "CON-021" }, data: { gstRegistered: false } });
    await db.$executeRawUnsafe(statement ?? "");
    const answers = await db.contractor.findMany({ select: { code: true, gstRegistered: true }, orderBy: { code: "asc" } });
    expect(answers.map((row) => row.gstRegistered)).toEqual([true, null, null]);
  });
});
