// Feature 6012, service status page -- the backend half.
//
// Every outside call is faked through the StatusProbes seam: the tests never reach the network,
// send nothing, charge nothing.
//
// AC2  a service whose key is missing reads not_set_up, and no call is made to it
// AC3  an answering service is up; a refused key is down "The key was refused"; no answer in time
//      is down "No answer within 5 seconds" (a short test timeout stands in for the five seconds)
// AC4  reCAPTCHA: up when Google refuses only the dummy token, down when it refuses our secret
// AC7  ops 200, the owner 200, a contractor 403, no session 401
// AC8  nothing is written to the database by a call
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { toNodeHandler } from "better-auth/node";
import { buildAuth } from "../src/auth/config.js";
import { attachSession } from "../src/auth/middleware.js";
import { authRoutes } from "../src/auth/routes.js";
import { contractorLoginRoutes } from "../src/auth/login-routes.js";
import { statusRoutes } from "../src/status/routes.js";
import {
  REASON_REFUSED,
  REASON_TIMEOUT,
  REASON_UNREACHED,
  checkClickSend,
  checkCloudinary,
  checkMailjet,
  checkRecaptcha,
  checkStripe,
  runStatusChecks,
  setStatusProbes,
  type ProbeRequest,
  type ProbeResponse,
  type StatusProbes,
} from "../src/status/checks.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedAuthFixtures } from "../src/db/seed/auth.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import { signIn } from "./helpers/ops-app.js";
import { testClient, truncateAll } from "./helpers/database.js";
import type { PrismaClient } from "../src/db/client.js";

const ALL_KEYS = {
  MAILJET_API_KEY: "mj-key",
  MAILJET_API_SECRET: "mj-secret",
  CLICKSEND_USERNAME: "cs-user",
  CLICKSEND_API_KEY: "cs-key",
  STRIPE_SECRET_KEY: "sk_test_fake",
  RECAPTCHA_SECRET_KEY: "rc-secret",
  CLOUDINARY_CLOUD_NAME: "cloud",
  CLOUDINARY_API_KEY: "cl-key",
  CLOUDINARY_API_SECRET: "cl-secret",
  CLOUDINARY_UPLOAD_PRESET: "preset",
};

/** A fake that records every call and answers from `reply`. */
function fakeProbes(reply: (request: ProbeRequest) => Promise<ProbeResponse> | ProbeResponse = () => ({ status: 200, json: {} })) {
  const calls: ProbeRequest[] = [];
  const stripeCalls: string[] = [];
  const probes: StatusProbes = {
    http: (req) => {
      calls.push(req);
      return Promise.resolve(reply(req));
    },
    stripeBalance: (key) => {
      stripeCalls.push(key);
      return Promise.resolve();
    },
  };
  return { probes, calls, stripeCalls };
}

afterEach(() => {
  setStatusProbes(undefined);
});

describe("AC2 -- a missing key is not set up and nothing is called", () => {
  test.each([
    ["Mailjet", checkMailjet],
    ["ClickSend", checkClickSend],
    ["Stripe", checkStripe],
    ["reCAPTCHA", checkRecaptcha],
    ["Cloudinary", checkCloudinary],
  ] as const)("%s: no key -> not_set_up, the fake is never called", async (_name, check) => {
    const { probes, calls, stripeCalls } = fakeProbes();
    setStatusProbes(probes);
    expect(await check({})).toEqual({ state: "not_set_up" });
    expect(calls).toHaveLength(0);
    expect(stripeCalls).toHaveLength(0);
  });

  test("half a key pair counts as missing", async () => {
    const { probes, calls } = fakeProbes();
    setStatusProbes(probes);
    expect(await checkMailjet({ MAILJET_API_KEY: "only-the-key" })).toEqual({ state: "not_set_up" });
    expect(await checkCloudinary({ ...ALL_KEYS, CLOUDINARY_API_SECRET: "" })).toEqual({ state: "not_set_up" });
    expect(calls).toHaveLength(0);
  });
});

describe("AC3 -- up, refused, no answer", () => {
  test("a 200 answer is up, for each plain-HTTP service, and the right address is asked", async () => {
    const { probes, calls } = fakeProbes();
    setStatusProbes(probes);
    expect(await checkMailjet(ALL_KEYS)).toEqual({ state: "up" });
    expect(await checkClickSend(ALL_KEYS)).toEqual({ state: "up" });
    expect(await checkCloudinary(ALL_KEYS)).toEqual({ state: "up" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.mailjet.com/v3/REST/apikey",
      "https://rest.clicksend.com/v3/account",
      "https://api.cloudinary.com/v1_1/cloud/ping",
    ]);
    expect(calls.every((c) => c.method === "GET" && c.headers?.["authorization"]?.startsWith("Basic "))).toBe(true);
  });

  test("a refused key (401 or 403) is down with 'The key was refused'", async () => {
    setStatusProbes(fakeProbes(() => ({ status: 401, json: null })).probes);
    expect(await checkMailjet(ALL_KEYS)).toEqual({ state: "down", reason: REASON_REFUSED });
    setStatusProbes(fakeProbes(() => ({ status: 403, json: null })).probes);
    expect(await checkCloudinary(ALL_KEYS)).toEqual({ state: "down", reason: REASON_REFUSED });
  });

  test("any other answer is down with 'Unexpected answer (<status>)'", async () => {
    setStatusProbes(fakeProbes(() => ({ status: 503, json: null })).probes);
    expect(await checkClickSend(ALL_KEYS)).toEqual({ state: "down", reason: "Unexpected answer (503)" });
  });

  test("no answer in time is down with 'No answer within 5 seconds'", async () => {
    const never: StatusProbes = {
      http: () => new Promise<ProbeResponse>(() => undefined),
      stripeBalance: () => new Promise<void>(() => undefined),
    };
    setStatusProbes(never, 30);
    expect(await checkMailjet(ALL_KEYS)).toEqual({ state: "down", reason: REASON_TIMEOUT });
    expect(await checkStripe(ALL_KEYS)).toEqual({ state: "down", reason: REASON_TIMEOUT });
  });

  test("a network error is down, 'Could not be reached'", async () => {
    setStatusProbes({
      http: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
      stripeBalance: () => Promise.reject(new Error("socket hang up")),
    });
    expect(await checkMailjet(ALL_KEYS)).toEqual({ state: "down", reason: REASON_UNREACHED });
    expect(await checkStripe(ALL_KEYS)).toEqual({ state: "down", reason: REASON_UNREACHED });
  });

  test("Stripe: balance answers -> up; a 401 from Stripe -> key refused; a 500 -> unexpected", async () => {
    const { probes, stripeCalls } = fakeProbes();
    setStatusProbes(probes);
    expect(await checkStripe(ALL_KEYS)).toEqual({ state: "up" });
    expect(stripeCalls).toEqual(["sk_test_fake"]);

    setStatusProbes({ ...probes, stripeBalance: () => Promise.reject(Object.assign(new Error("bad key"), { statusCode: 401 })) });
    expect(await checkStripe(ALL_KEYS)).toEqual({ state: "down", reason: REASON_REFUSED });
    setStatusProbes({ ...probes, stripeBalance: () => Promise.reject(Object.assign(new Error("oops"), { statusCode: 500 })) });
    expect(await checkStripe(ALL_KEYS)).toEqual({ state: "down", reason: "Unexpected answer (500)" });
  });
});

describe("AC4 -- reCAPTCHA: only our secret being refused is a problem", () => {
  test("Google refuses only the dummy token -> up", async () => {
    const { probes, calls } = fakeProbes(() => ({
      status: 200,
      json: { success: false, "error-codes": ["invalid-input-response"] },
    }));
    setStatusProbes(probes);
    expect(await checkRecaptcha(ALL_KEYS)).toEqual({ state: "up" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain("secret=rc-secret");
  });

  test("Google refuses our secret -> down, key refused", async () => {
    setStatusProbes(fakeProbes(() => ({ status: 200, json: { success: false, "error-codes": ["invalid-input-secret"] } })).probes);
    expect(await checkRecaptcha(ALL_KEYS)).toEqual({ state: "down", reason: REASON_REFUSED });
    setStatusProbes(fakeProbes(() => ({ status: 200, json: { success: false, "error-codes": ["missing-input-secret"] } })).probes);
    expect(await checkRecaptcha(ALL_KEYS)).toEqual({ state: "down", reason: REASON_REFUSED });
  });

  test("a non-200 from Google is an unexpected answer", async () => {
    setStatusProbes(fakeProbes(() => ({ status: 502, json: null })).probes);
    expect(await checkRecaptcha(ALL_KEYS)).toEqual({ state: "down", reason: "Unexpected answer (502)" });
  });
});

describe("the five checks together", () => {
  test("in the design's order, with names, run in parallel", async () => {
    setStatusProbes(fakeProbes().probes);
    const rows = await runStatusChecks(ALL_KEYS);
    expect(rows.map((r) => r.name)).toEqual(["Mailjet", "ClickSend", "Stripe", "reCAPTCHA", "Cloudinary"]);
    expect(rows.every((r) => r.state === "up")).toBe(true);
  });
});

describe("AC7 / AC8 -- who may ask, and nothing is written", () => {
  let db: PrismaClient;
  let app: Express;

  beforeAll(() => {
    db = testClient();
    const auth = buildAuth({ client: db });
    app = express();
    app.use("/api/auth", contractorLoginRoutes(auth, db));
    app.all("/api/auth/*splat", toNodeHandler(auth));
    app.use(attachSession(auth, db));
    app.use("/api", authRoutes(db));
    app.use("/api/status", statusRoutes());
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBase(db);
    await seedFixtures(db);
    await seedAuthFixtures(db);
    setStatusProbes(fakeProbes().probes);
    // The route reads the real environment: give it every key so each row is checked.
    for (const [key, value] of Object.entries(ALL_KEYS)) vi.stubEnv(key, value);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  test("AC7: Mike (ops) and the owner get the five rows; a contractor gets 403; no session gets 401", async () => {
    const mike = await signIn(app, "mike@idelta.com.au");
    const asMike = await request(app).get("/api/status").set("Cookie", mike);
    expect(asMike.status).toBe(200);
    const services = (asMike.body as { services: { name: string; state: string }[] }).services;
    expect(services.map((s) => s.name)).toEqual(["Mailjet", "ClickSend", "Stripe", "reCAPTCHA", "Cloudinary"]);
    expect(services.every((s) => s.state === "up")).toBe(true);

    const owner = await signIn(app, "owner@idelta.com.au");
    expect((await request(app).get("/api/status").set("Cookie", owner)).status).toBe(200);

    const bob = await signIn(app, "bob@idelta.com.au");
    expect((await request(app).get("/api/status").set("Cookie", bob)).status).toBe(403);

    expect((await request(app).get("/api/status")).status).toBe(401);
  });

  test("AC8: a call, and a second one, change no row in any table", async () => {
    const count = async (): Promise<string> => {
      const tables = await db.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
      const counts: string[] = [];
      for (const { table_name } of tables) {
        const [row] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table_name}"`);
        counts.push(`${table_name}=${String(row?.n)}`);
      }
      return counts.join(",");
    };
    const mike = await signIn(app, "mike@idelta.com.au");
    const before = await count();
    await request(app).get("/api/status").set("Cookie", mike);
    await request(app).get("/api/status").set("Cookie", mike);
    expect(await count()).toBe(before);
  });
});
