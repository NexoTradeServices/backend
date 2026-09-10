// Feature 2003 -- contractor dashboard + rates screen
//
// AC1  only assigned/accepted/in_progress; declined/cancelled/completed never appear
// AC2  unanswered beats sooner: Sarah (awaiting answer) above Tom (accepted, sooner)
// AC3  Margaret's on-hold job, no return date, sorts last
// AC4  a card's slot renders in the job's timezone, labelled
// AC5  no live jobs -> an empty jobs array
// AC6  ready, nothing missing -> Bob sees no readiness items at all
// AC7  Priya's panel: her own two items (each with key/pen), Mike's insurance
//      item, and no address/emergency-contact nudge (her fixture has both)
// AC8  a contractor whose only gap is his own address stays `ready`
// AC9  Bob's rates: Plumbing, two rows (normal/weekend), no emergency anywhere
// AC10 Dave's rates: Electrical + Air conditioning as separate specialties;
//      an expired licence is still returned, tagged by its own status/expiry
// AC11 the rates door is session-only -- Bob never sees Dave's specialties
// AC12 the fixture seed's job/assignment shape
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { toNodeHandler } from "better-auth/node";
import { testClient, truncateAll } from "./helpers/database.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { seedAuthFixtures, DEV_PASSWORD } from "../src/db/seed/auth.js";
import { buildAuth, type Auth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { contractorDashboardRoutes } from "../src/contractors/dashboard-routes.js";
import { formatSlotLabel, zoneForState } from "../src/time/index.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;
let auth: Auth;
let app: Express;

interface JobCard {
  reference: string;
  jobStatus: string;
  customerName: string;
  trade: string;
  suburb: string;
  slotLabel: string | null;
}

interface ReadinessItem {
  key: string;
  copy: string;
  pen: "own" | "mikes";
  route: string | null;
  blocking: boolean;
}

interface DashboardBody {
  ready: boolean;
  missing: ReadinessItem[];
  jobs: JobCard[];
}

interface RateSpecialty {
  trade: string;
  status: string;
  licenceNumber: string;
  licenceExpiry: string;
  normal: { callout: number; standard: number };
  weekend: { callout: number; standard: number };
}

interface RatesBody {
  specialties: RateSpecialty[];
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
  const res = await request(app).post("/api/auth/sign-in/email").send({ email, password: DEV_PASSWORD });
  return cookieHeader(res);
}

async function dashboard(cookie: string): Promise<DashboardBody> {
  const res = await request(app).get("/api/contractor/dashboard").set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as DashboardBody;
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
  app.use("/api/contractor", contractorDashboardRoutes(db));
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await seedCast();
});

describe("AC1-AC4 -- Bob's live job list, sorted", () => {
  test("AC1: only assigned/accepted/in_progress ride the list; declined/cancelled/completed never do", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const before = await dashboard(cookie);
    expect(before.jobs.map((j) => j.reference).sort()).toEqual(["JOB-1039", "JOB-1042", "JOB-1051"]);

    // Add one assignment of each excluded status -- none may appear.
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const plumbing = bob.specialties.find((s) => s.trade === "Plumbing");
    if (!plumbing) throw new Error("fixture Bob has no Plumbing specialty");
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });

    for (const [reference, status] of [
      ["JOB-9101", "declined"],
      ["JOB-9102", "cancelled"],
      ["JOB-9103", "completed"],
    ] as const) {
      const job = await db.job.create({
        data: {
          reference,
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
          status: "cancelled",
        },
      });
      await db.assignment.create({ data: { jobId: job.id, contractorId: bob.id, specialtyId: plumbing.id, status } });
    }

    const after = await dashboard(cookie);
    expect(after.jobs.map((j) => j.reference).sort()).toEqual(["JOB-1039", "JOB-1042", "JOB-1051"]);
  });

  test("AC2/AC3: unanswered first, then soonest, then no-slot last", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const body = await dashboard(cookie);
    expect(body.jobs.map((j) => j.reference)).toEqual(["JOB-1042", "JOB-1051", "JOB-1039"]);

    const sarahCard = body.jobs.find((j) => j.reference === "JOB-1042");
    const tomCard = body.jobs.find((j) => j.reference === "JOB-1051");
    const margaretCard = body.jobs.find((j) => j.reference === "JOB-1039");
    expect(sarahCard?.jobStatus).toBe("assigned");
    expect(sarahCard?.customerName).toBe("Sarah Chen");
    expect(sarahCard?.trade).toBe("Plumbing");
    expect(sarahCard?.suburb).toBe("Hilton");
    expect(tomCard?.jobStatus).toBe("scheduled");
    expect(tomCard?.customerName).toBe("Tom");
    expect(tomCard?.suburb).toBe("Kalamunda");
    expect(margaretCard?.jobStatus).toBe("on_hold");
    expect(margaretCard?.customerName).toBe("Margaret");
    expect(margaretCard?.suburb).toBe("Applecross");
    // AC3: on hold, no return date -- no sortable slot at all.
    expect(margaretCard?.slotLabel).toBeNull();
  });

  test("AC4: the slot renders in the job's timezone, labelled -- a fixed example", async () => {
    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" }, include: { specialties: true } });
    const plumbing = bob.specialties.find((s) => s.trade === "Plumbing");
    if (!plumbing) throw new Error("fixture Bob has no Plumbing specialty");
    const sarah = await db.customer.findUniqueOrThrow({ where: { code: "CUS-1050" } });
    const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const zone = zoneForState("WA");
    // A fixed instant, well clear of "today" either way.
    const fixedSlot = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    fixedSlot.setUTCHours(0, 0, 0, 0);
    const job = await db.job.create({
      data: {
        reference: "JOB-9104",
        customerId: sarah.id,
        serviceTypeId: serviceType.id,
        customerCalloutRate: serviceType.customerCalloutRate,
        customerStandardRate: serviceType.customerStandardRate,
        postcode: "6163",
        serviceLocation: { suburb: "Hilton", state: "WA", country: "AU", lat: -32.07, lng: 115.78, placeId: "x" },
        timezone: zone,
        source: "web",
        preferredWindow: "morning",
        preferredDate: fixedSlot,
        status: "assigned",
      },
    });
    await db.assignment.create({
      data: { jobId: job.id, contractorId: bob.id, specialtyId: plumbing.id, status: "assigned", proposedSlot: fixedSlot },
    });

    const cookie = await signInCookie("bob@idelta.com.au");
    const body = await dashboard(cookie);
    const card = body.jobs.find((j) => j.reference === "JOB-9104");
    expect(card?.slotLabel).toBe(formatSlotLabel(zone, fixedSlot));
    expect(card?.slotLabel).toMatch(/^[A-Z][a-z]{2} \d{2}\/\d{2}, \d{1,2}:\d{2}(am|pm) AWST$/);
  });
});

describe("AC5 -- no live jobs", () => {
  test("AC5: Dave has no assignments at all -- an empty jobs array", async () => {
    const cookie = await signInCookie("dave@idelta.com.au");
    const body = await dashboard(cookie);
    expect(body.jobs).toEqual([]);
  });
});

describe("AC6-AC8 -- the readiness panel", () => {
  test("AC6: Bob is ready and has nothing missing at all -- no panel", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const body = await dashboard(cookie);
    expect(body.ready).toBe(true);
    expect(body.missing).toEqual([]);
  });

  test("AC7: Priya's panel -- her own two items, Mike's one, no address/EC nudge", async () => {
    const cookie = await signInCookie("priya@idelta.com.au");
    const body = await dashboard(cookie);
    expect(body.ready).toBe(false);

    const byKey = new Map(body.missing.map((item) => [item.key, item]));
    expect(byKey.get("service_area")).toMatchObject({ pen: "own", blocking: true, route: "/contractor/service-area" });
    expect(byKey.get("payout_details")).toMatchObject({ pen: "own", blocking: true });
    expect(byKey.get("insurance_renewal")).toMatchObject({ pen: "mikes", blocking: true, route: null });
    expect(byKey.has("address")).toBe(false);
    expect(byKey.has("emergency_contact")).toBe(false);
    expect(body.missing).toHaveLength(3);

    // RVW1.3: "his own first ... Mike's after" (plan.md, Frontend task
    // breakdown) -- her own two rows must precede Mike's, whatever order
    // the underlying checks run in.
    expect(body.missing.map((item) => item.pen)).toEqual(["own", "own", "mikes"]);
  });

  test("AC8: a contractor whose only gap is his own address stays ready, no tag", async () => {
    await db.contractor.update({ where: { code: "CON-014" }, data: { address: Prisma.JsonNull } });
    const cookie = await signInCookie("bob@idelta.com.au");
    const body = await dashboard(cookie);
    expect(body.ready).toBe(true);
    const addressItem = body.missing.find((item) => item.key === "address");
    expect(addressItem).toMatchObject({ pen: "own", blocking: false });
  });
});

describe("AC9-AC11 -- rates", () => {
  test("AC9: Bob's rates -- Plumbing, two rows, no third (emergency) row anywhere", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const res = await request(app).get("/api/contractor/rates").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const body = res.body as RatesBody;
    expect(body.specialties).toHaveLength(1);
    const plumbing = body.specialties[0];
    expect(plumbing?.trade).toBe("Plumbing");
    expect(plumbing?.normal).toEqual({ callout: 20_000, standard: 15_000 });
    expect(plumbing?.weekend).toEqual({ callout: 30_000, standard: 22_500 });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("emergency");
  });

  test("AC10: Dave's rates -- Electrical + Air conditioning as separate cards; an expired licence still returns, tagged by its own status/expiry", async () => {
    const dave = await db.contractor.findUniqueOrThrow({ where: { code: "CON-021" }, include: { specialties: true } });
    const aircon = dave.specialties.find((s) => s.trade === "Air conditioning");
    if (!aircon) throw new Error("fixture Dave has no Air conditioning specialty");
    await db.contractorSpecialty.update({ where: { id: aircon.id }, data: { licenceExpiry: new Date("2020-01-01") } });

    const cookie = await signInCookie("dave@idelta.com.au");
    const res = await request(app).get("/api/contractor/rates").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const body = res.body as RatesBody;
    expect(body.specialties.map((s) => s.trade).sort()).toEqual(["Air conditioning", "Electrical"]);

    const electrical = body.specialties.find((s) => s.trade === "Electrical");
    expect(electrical?.normal).toEqual({ callout: 21_000, standard: 15_500 });
    expect(electrical?.weekend).toEqual({ callout: 31_500, standard: 23_250 });

    const air = body.specialties.find((s) => s.trade === "Air conditioning");
    expect(air?.licenceExpiry).toBe("2020-01-01");
    expect(air?.status).toBe("active"); // status is a separate, manual switch (Expiry alerts) -- expiry alone never flips it
    expect(air?.normal).toEqual({ callout: 21_500, standard: 16_000 });
    expect(air?.weekend).toEqual({ callout: 32_250, standard: 24_000 });
  });

  test("AC11: the rates door is session-only -- Bob's request never yields Dave's rates", async () => {
    const cookie = await signInCookie("bob@idelta.com.au");
    const res = await request(app).get("/api/contractor/rates").set("Cookie", cookie);
    const body = res.body as RatesBody;
    expect(body.specialties.some((s) => s.trade === "Electrical")).toBe(false);
    expect(body.specialties.some((s) => s.trade === "Air conditioning")).toBe(false);

    const loggedOut = await request(app).get("/api/contractor/rates");
    expect(loggedOut.status).toBe(401);
  });
});

describe("AC12 -- the fixture seed's job/assignment shape", () => {
  test("AC12: Bob's three jobs and assignments, cast-true", async () => {
    const jobs = await db.job.findMany({ where: { reference: { in: ["JOB-1042", "JOB-1051", "JOB-1039"] } } });
    expect(jobs).toHaveLength(3);

    const sarahJob = jobs.find((j) => j.reference === "JOB-1042");
    const tomJob = jobs.find((j) => j.reference === "JOB-1051");
    const margaretJob = jobs.find((j) => j.reference === "JOB-1039");
    expect(sarahJob?.postcode).toBe("6163");
    expect(sarahJob?.status).toBe("assigned");
    expect(tomJob?.postcode).toBe("6076");
    expect(tomJob?.status).toBe("scheduled");
    expect(margaretJob?.postcode).toBe("6153");
    expect(margaretJob?.status).toBe("on_hold");

    const bob = await db.contractor.findUniqueOrThrow({ where: { code: "CON-014" } });
    const assignments = await db.assignment.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } } });
    expect(assignments).toHaveLength(3);
    expect(assignments.every((a) => a.contractorId === bob.id)).toBe(true);
  });
});
