// Dev/test-only cheap password hashing -- BKLG-013, feature 2002.
//
// Better Auth's own default (`better-auth/crypto`) runs scrypt at N=16384,
// r=16 (~32MB, real CPU work) -- the right cost for a real login, but under
// this box's Playwright e2e load (three browser projects, Next dev
// compiling routes on demand, the backend's own tsx watch) it is enough to
// occasionally push a sign-in past the login helper's 15s wait, exactly the
// "heavy PARALLEL login load" BKLG-013's root-cause note already named.
// Capping Playwright's worker count (playwright.config.ts) cut most of it;
// this is the fallback AC13 names for what is left -- a MUCH cheaper scrypt
// (N=1024, 16x less work), used everywhere except a real production boot.
// NEVER used there: `buildAuth` only reaches for this when NODE_ENV is not
// "production", so a real login keeps the real cost.
import { randomBytes, scrypt } from "node:crypto";
import { hashPassword as realHashPassword, verifyPassword as realVerifyPassword } from "better-auth/crypto";

const DEV_COST = { N: 1024, r: 8, p: 1, dkLen: 64 } as const;

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, DEV_COST.dkLen, DEV_COST, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPasswordCheaply(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPasswordCheaply({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const targetKey = await deriveKey(password, salt);
  return targetKey.toString("hex") === key;
}

/**
 * The ONE place that decides which cost applies -- `buildAuth` (real logins)
 * and the fixture seed (`db/seed/auth.ts`, which mints the same seeded
 * passwords `buildAuth` later verifies) both call this, so a hash minted by
 * one is always verifiable by the other. Never the cheap path in production.
 */
export function passwordHasher(): { hash: (password: string) => Promise<string>; verify: (input: { hash: string; password: string }) => Promise<boolean> } {
  if (process.env.NODE_ENV === "production") {
    return { hash: realHashPassword, verify: realVerifyPassword };
  }
  return { hash: hashPasswordCheaply, verify: verifyPasswordCheaply };
}
