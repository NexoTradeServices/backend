// Feature 3001 -- enquiry form to job created
//
// review round 1, RVW1.1: verifyRecaptcha's own threshold comparison and
// its collapse-to-"unreachable" behaviour were never exercised directly --
// enquiries.test.ts only drives the route through the `verifyRecaptcha`
// option seam with canned "human"/"bot"/"unreachable" strings. This file
// calls the real function, mocking only the network boundary (fetch), so a
// flipped comparison or a network error that starts throwing instead of
// degrading would fail here even though the route-level suite stays green.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import { RECAPTCHA_BOT_THRESHOLD, verifyRecaptcha } from "../src/enquiries/recaptcha.js";
import { enquiryRoutes } from "../src/enquiries/routes.js";
import { testRunSignal } from "../src/test-data/label.js";
import { seedBase } from "../src/db/seed/base.js";
import { testClient, truncateAll } from "./helpers/database.js";
import type { PrismaClient } from "../src/db/client.js";

const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env["RECAPTCHA_SECRET_KEY"];
  process.env["RECAPTCHA_SECRET_KEY"] = "test-secret";
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env["RECAPTCHA_SECRET_KEY"];
  else process.env["RECAPTCHA_SECRET_KEY"] = savedSecret;
  vi.unstubAllGlobals();
});

function mockFetchOnce(response: { ok: boolean; json?: () => Promise<unknown> } | (() => Promise<never>)) {
  const impl = typeof response === "function" ? response : () => Promise.resolve(response as Response);
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("verifyRecaptcha -- the real threshold comparison", () => {
  test("no token at all (script never loaded) is unreachable, and never calls fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const verdict = await verifyRecaptcha(undefined);
    expect(verdict).toBe("unreachable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no secret configured is unreachable, and never calls fetch", async () => {
    delete process.env["RECAPTCHA_SECRET_KEY"];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const verdict = await verifyRecaptcha("some-token");
    expect(verdict).toBe("unreachable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test(`a score at or above the threshold (${String(RECAPTCHA_BOT_THRESHOLD)}) is human`, async () => {
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ success: true, score: RECAPTCHA_BOT_THRESHOLD }) });
    expect(await verifyRecaptcha("token")).toBe("human");
  });

  test("a score just below the threshold is a confirmed bot", async () => {
    mockFetchOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, score: RECAPTCHA_BOT_THRESHOLD - 0.01 }),
    });
    expect(await verifyRecaptcha("token")).toBe("bot");
  });

  test("a clearly human score (0.9) is human; a clearly bot score (0.1) is bot", async () => {
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ success: true, score: 0.9 }) });
    expect(await verifyRecaptcha("token")).toBe("human");
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ success: true, score: 0.1 }) });
    expect(await verifyRecaptcha("token")).toBe("bot");
  });

  test("google saying success:false is unreachable, never a bot verdict", async () => {
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ success: false, score: 0.1 }) });
    expect(await verifyRecaptcha("token")).toBe("unreachable");
  });

  test("a malformed body (no numeric score) is unreachable", async () => {
    mockFetchOnce({ ok: true, json: () => Promise.resolve({ success: true }) });
    expect(await verifyRecaptcha("token")).toBe("unreachable");
  });

  test("a non-2xx HTTP status is unreachable, and the body is never read", async () => {
    const json = vi.fn();
    mockFetchOnce({ ok: false, json });
    expect(await verifyRecaptcha("token")).toBe("unreachable");
    expect(json).not.toHaveBeenCalled();
  });

  test("a network failure (fetch throws) is unreachable, never an unhandled rejection", async () => {
    mockFetchOnce(() => Promise.reject(new Error("network down")));
    await expect(verifyRecaptcha("token")).resolves.toBe("unreachable");
  });

  test("the real call sends the secret and the token to Google's own siteverify endpoint", async () => {
    const fetchSpy = vi.fn<typeof fetch>(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, score: 1 }) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await verifyRecaptcha("the-token");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SITEVERIFY_URL);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("the-token");
  });
});

// Feature 9002, AC3b -- the test-run signal and the reCAPTCHA gate, through the
// real enquiry route. Outside production a request carrying the signal goes on
// as a human would (the live keys on dev refuse a headless browser as a bot);
// without it a bot score is still refused; in production the signal does not
// skip the check.
describe("AC3b (9002) -- the test-run signal and the enquiry's reCAPTCHA check", () => {
  let db: PrismaClient;
  const botCheck = vi.fn<(token: string | undefined) => Promise<"bot">>(() => Promise.resolve("bot"));

  function enquiry(email: string): Record<string, unknown> {
    return {
      name: "Karl",
      email,
      phone: "0400 000 999",
      location: {
        suburb: "Joondalup",
        state: "WA",
        country: "AU",
        postcode: "6027",
        lat: -31.7448,
        lng: 115.7661,
        placeId: "fixture-place-joondalup",
      },
      trade: "Plumbing",
      selectedOptions: [],
      preferredDate: "2026-09-09",
      preferredWindow: "morning",
      description: "Kitchen tap won't stop dripping.",
      marketingEmail: false,
      marketingSms: false,
      recaptchaToken: "fixture-token",
    };
  }

  function app(): express.Express {
    const built = express();
    built.use(testRunSignal);
    built.use(express.json());
    built.use("/api/enquiries", enquiryRoutes(db, { verifyRecaptcha: botCheck }));
    return built;
  }

  beforeAll(async () => {
    db = testClient();
    await truncateAll(db);
    await seedBase(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(() => {
    botCheck.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("outside production, an enquiry carrying the signal is taken without a reCAPTCHA check", async () => {
    const res = await request(app()).post("/api/enquiries").set("Cookie", "ts-test-run=e2e").send(enquiry("signal@idelta.com.au"));
    expect(res.status).toBe(201);
    expect(botCheck).not.toHaveBeenCalled();
  });

  test("outside production, without the signal a bot score is still refused", async () => {
    const res = await request(app()).post("/api/enquiries").send(enquiry("nosignal@idelta.com.au"));
    expect(res.status).toBe(403);
    expect(botCheck).toHaveBeenCalledTimes(1);
  });

  test("with NODE_ENV=production the signal does not skip the check", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await request(app()).post("/api/enquiries").set("Cookie", "ts-test-run=e2e").send(enquiry("prod@idelta.com.au"));
    expect(res.status).toBe(403);
    expect(botCheck).toHaveBeenCalledTimes(1);
  });
});
