// Feature 3001 -- enquiry form to job created
//
// review round 1, RVW1.1: verifyRecaptcha's own threshold comparison and
// its collapse-to-"unreachable" behaviour were never exercised directly --
// enquiries.test.ts only drives the route through the `verifyRecaptcha`
// option seam with canned "human"/"bot"/"unreachable" strings. This file
// calls the real function, mocking only the network boundary (fetch), so a
// flipped comparison or a network error that starts throwing instead of
// degrading would fail here even though the route-level suite stays green.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RECAPTCHA_BOT_THRESHOLD, verifyRecaptcha } from "../src/enquiries/recaptcha.js";

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
