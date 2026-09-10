// reCAPTCHA v3 verification -- Feature 3001, enquiry form to job created.
//
// Identity & Access / Authentication & Security; plan decision 1
// (walkthrough-log.md row 49): checked on submit, before any Customer or Job
// row exists. A confirmed bot refuses the submission outright and shows the
// operator phone number instead -- the ONE deliberate exception to "outside
// services degrade, never block" (Ground rules). Every other outcome --
// verified human, or the check itself unreachable or blocked (no secret
// configured, Google unreachable, a malformed response, no token at all
// because the client's own script never loaded) -- lets the submission
// through exactly as if it had passed: no flag, no field, no log anywhere.
const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

/**
 * Plan decision 2: Google's documented default, held in ONE named constant,
 * never inline at the call site. reCAPTCHA v3 scores 0.0 (bot) to 1.0
 * (human); below this is a confirmed bot. The right number for this
 * business cannot be known before real traffic -- it is reset from live
 * data after launch, and this constant is the single place that changes.
 */
export const RECAPTCHA_BOT_THRESHOLD = 0.5;

const REQUEST_TIMEOUT_MS = 10_000;

export type RecaptchaVerdict = "human" | "bot" | "unreachable";

interface SiteverifyResponse {
  success?: boolean;
  score?: number;
  ["error-codes"]?: string[];
}

/**
 * Score a submitted token against the threshold. Never throws -- every
 * failure mode (no secret configured, no token handed in, a network error,
 * a malformed response, google saying success:false) collapses to
 * "unreachable", which the caller treats identically to a verified human.
 */
export async function verifyRecaptcha(token: string | undefined): Promise<RecaptchaVerdict> {
  const secret = process.env["RECAPTCHA_SECRET_KEY"];
  if (!secret || !token) return "unreachable";

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: new URLSearchParams({ secret, response: token }).toString(),
    });
    if (!response.ok) return "unreachable";

    const body = (await response.json().catch(() => null)) as SiteverifyResponse | null;
    if (body === null || body.success !== true || typeof body.score !== "number") {
      return "unreachable";
    }
    return body.score < RECAPTCHA_BOT_THRESHOLD ? "bot" : "human";
  } catch {
    return "unreachable";
  }
}
