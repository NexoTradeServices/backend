// Feature 2002 -- service area builder, BKLG-013
//
// AC13  the cheap dev/test hasher round-trips, and never applies in production
import { describe, expect, test, vi } from "vitest";
import { hashPasswordCheaply, verifyPasswordCheaply, passwordHasher } from "../src/auth/dev-password.js";

describe("AC13 -- dev-only cheap password hashing", () => {
  test("AC13: a password hashed cheaply verifies against the right password and refuses the wrong one", async () => {
    const hash = await hashPasswordCheaply("dev-password-123");
    expect(await verifyPasswordCheaply({ hash, password: "dev-password-123" })).toBe(true);
    expect(await verifyPasswordCheaply({ hash, password: "wrong-password" })).toBe(false);
  });

  test("AC13: a malformed hash refuses rather than throwing", async () => {
    expect(await verifyPasswordCheaply({ hash: "not-a-real-hash", password: "anything" })).toBe(false);
  });

  test("AC13: passwordHasher() picks the cheap path outside production, the real one in it", () => {
    const original = process.env["NODE_ENV"];
    try {
      vi.stubEnv("NODE_ENV", "test");
      expect(passwordHasher().hash).toBe(hashPasswordCheaply);

      vi.stubEnv("NODE_ENV", "production");
      expect(passwordHasher().hash).not.toBe(hashPasswordCheaply);
    } finally {
      vi.stubEnv("NODE_ENV", original ?? "");
      vi.unstubAllEnvs();
    }
  });
});
