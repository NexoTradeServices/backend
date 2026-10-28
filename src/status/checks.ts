// Service status -- Feature 6012. One cheap, read-only check per outside service the backend
// talks to: is it answering, and does it accept our key, right now.
//
// Nothing is sent, charged or stored by any check, and nothing is written anywhere. A missing key
// reads "not_set_up" and no call is made. Every outside call goes through the `StatusProbes` seam
// below (the same pattern as the Stripe and notification-provider seams), so tests swap in a fake
// and never reach the network.
//
// Google Places is not checked here: its key is the browser's, so the page checks it itself.
import Stripe from "stripe";
import { readCloudinaryConfig } from "../photos/cloudinary.js";

export type ServiceState = "up" | "down" | "not_set_up";

export interface CheckResult {
  state: ServiceState;
  /** For a down row only. */
  reason?: string;
}

export interface ServiceStatus extends CheckResult {
  key: "mailjet" | "clicksend" | "stripe" | "recaptcha" | "cloudinary";
  name: string;
}

export const REASON_TIMEOUT = "No answer within 5 seconds";
export const REASON_REFUSED = "The key was refused";
export const REASON_UNREACHED = "Could not be reached";
const reasonUnexpected = (status: number): string => `Unexpected answer (${String(status)})`;

/** Every check gives up after this long. */
export const CHECK_TIMEOUT_MS = 5_000;

export interface ProbeRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface ProbeResponse {
  status: number;
  /** The parsed JSON body, or null when there was none. */
  json: unknown;
}

/** The only two doors to the outside world. Both reject on a network error. */
export interface StatusProbes {
  http(request: ProbeRequest, timeoutMs: number): Promise<ProbeResponse>;
  /** Stripe's `balance.retrieve()`: resolves when the key is accepted, rejects (with Stripe's error) when not. */
  stripeBalance(secretKey: string, timeoutMs: number): Promise<void>;
}

const realProbes: StatusProbes = {
  async http(request, timeoutMs) {
    const response = await fetch(request.url, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json: unknown = await response.json().catch(() => null);
    return { status: response.status, json };
  },
  async stripeBalance(secretKey, timeoutMs) {
    const stripe = new Stripe(secretKey, { timeout: timeoutMs, maxNetworkRetries: 0 });
    await stripe.balance.retrieve();
  },
};

let probesOverride: StatusProbes | undefined;
let timeoutOverride: number | undefined;

/** Tests only: swap the outside calls (and, for the "never answers" case, a short timeout). */
export function setStatusProbes(probes: StatusProbes | undefined, timeoutMs?: number): void {
  probesOverride = probes;
  timeoutOverride = timeoutMs;
}

const probes = (): StatusProbes => probesOverride ?? realProbes;
const timeout = (): number => timeoutOverride ?? CHECK_TIMEOUT_MS;

class TimedOut extends Error {}

/** Rejects with TimedOut when the call has not answered in time, whatever the call itself does. */
function withTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("check failed"));
      },
    );
  });
}

function isTimeout(error: unknown): boolean {
  return error instanceof TimedOut || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

const down = (reason: string): CheckResult => ({ state: "down", reason });

/** The answer-to-state rule shared by the three plain "200 means up" services. */
function fromStatus(status: number): CheckResult {
  if (status === 200) return { state: "up" };
  if (status === 401 || status === 403) return down(REASON_REFUSED);
  return down(reasonUnexpected(status));
}

function fromError(error: unknown): CheckResult {
  return down(isTimeout(error) ? REASON_TIMEOUT : REASON_UNREACHED);
}

function basic(user: string, secret: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}` };
}

async function viaHttp(request: ProbeRequest, interpret: (response: ProbeResponse) => CheckResult): Promise<CheckResult> {
  try {
    return interpret(await withTimeout(probes().http(request, timeout()), timeout()));
  } catch (error) {
    return fromError(error);
  }
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function checkMailjet(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const key = present(env["MAILJET_API_KEY"]);
  const secret = present(env["MAILJET_API_SECRET"]);
  if (key === null || secret === null) return Promise.resolve({ state: "not_set_up" });
  return viaHttp(
    { url: "https://api.mailjet.com/v3/REST/apikey", method: "GET", headers: basic(key, secret) },
    (response) => fromStatus(response.status),
  );
}

export function checkClickSend(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const username = present(env["CLICKSEND_USERNAME"]);
  const key = present(env["CLICKSEND_API_KEY"]);
  if (username === null || key === null) return Promise.resolve({ state: "not_set_up" });
  return viaHttp(
    { url: "https://rest.clicksend.com/v3/account", method: "GET", headers: basic(username, key) },
    (response) => fromStatus(response.status),
  );
}

export async function checkStripe(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const secretKey = present(env["STRIPE_SECRET_KEY"]);
  if (secretKey === null) return { state: "not_set_up" };
  try {
    await withTimeout(probes().stripeBalance(secretKey, timeout()), timeout());
    return { state: "up" };
  } catch (error) {
    if (isTimeout(error)) return down(REASON_TIMEOUT);
    // Stripe's errors carry the HTTP status of the answer; none at all means it never answered.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status !== "number") return down(REASON_UNREACHED);
    return status === 401 || status === 403 ? down(REASON_REFUSED) : down(reasonUnexpected(status));
  }
}

export function checkCloudinary(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const config = readCloudinaryConfig(env);
  if (config === null) return Promise.resolve({ state: "not_set_up" });
  return viaHttp(
    {
      url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/ping`,
      method: "GET",
      headers: basic(config.apiKey, config.apiSecret),
    },
    (response) => fromStatus(response.status),
  );
}

/**
 * Google's siteverify with our secret and a dummy token. Google always refuses the token; what
 * matters is whether it refused OUR SECRET too -- that is a key problem. Any other answer proves
 * Google answered and accepted the secret.
 */
export function checkRecaptcha(env: NodeJS.ProcessEnv = process.env): Promise<CheckResult> {
  const secret = present(env["RECAPTCHA_SECRET_KEY"]);
  if (secret === null) return Promise.resolve({ state: "not_set_up" });
  return viaHttp(
    {
      url: "https://www.google.com/recaptcha/api/siteverify",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: "service-status-check" }).toString(),
    },
    (response) => {
      if (response.status !== 200) return down(reasonUnexpected(response.status));
      const codes = (response.json as { "error-codes"?: unknown } | null)?.["error-codes"];
      const secretRefused =
        Array.isArray(codes) && codes.some((code) => code === "invalid-input-secret" || code === "missing-input-secret");
      return secretRefused ? down(REASON_REFUSED) : { state: "up" };
    },
  );
}

/** All five backend checks in parallel, in the design's order. Writes nothing. */
export async function runStatusChecks(env: NodeJS.ProcessEnv = process.env): Promise<ServiceStatus[]> {
  const [mailjet, clicksend, stripe, recaptcha, cloudinary] = await Promise.all([
    checkMailjet(env),
    checkClickSend(env),
    checkStripe(env),
    checkRecaptcha(env),
    checkCloudinary(env),
  ]);
  return [
    { key: "mailjet", name: "Mailjet", ...mailjet },
    { key: "clicksend", name: "ClickSend", ...clicksend },
    { key: "stripe", name: "Stripe", ...stripe },
    { key: "recaptcha", name: "reCAPTCHA", ...recaptcha },
    { key: "cloudinary", name: "Cloudinary", ...cloudinary },
  ];
}
