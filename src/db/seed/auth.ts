// Dev-login fixtures -- Feature 1003, auth + roles.
//
// Gives every cast member a way to log in. Mike and the owner get bare User
// rows (they carry no Contractor/Customer profile); Bob, Dave and Priya
// already have one from `seedFixtures` (feature 1001) and just need a
// password. Every seeded login shares the SAME dev-only password (decision
// 5) -- named here once so the README can quote it, hashed the exact way
// Better Auth hashes one at signup, so `POST /api/auth/sign-in/email` works
// against it with no extra step.
//
// DEV AND TEST ONLY. Called from `db:seed:fixtures`'s `main()`, which already
// refuses NODE_ENV=production (feature 1001); this file adds no refusal of
// its own on purpose -- it is never runnable standalone in prod.
//
// Sarah stays untouched: no User row, no Account row, no password. AC9 pins
// that -- she is a guest until 3004 offers her one.
import { hashPassword } from "better-auth/crypto";
import { getPrisma, type PrismaClient } from "../client.js";
import { Role } from "../../generated/prisma/enums.js";

export const DEV_PASSWORD = "dev-password-123";

const PLATFORM_USERS = [
  { name: "Mike", email: "mike@example.com", role: Role.ops },
  { name: "The owner", email: "owner@example.com", role: Role.owner },
] as const;

export interface SeedAuthResult {
  usersCreated: string[];
  passwordsSet: string[];
}

async function ensurePassword(
  client: PrismaClient,
  userId: string,
  email: string,
  result: SeedAuthResult,
): Promise<void> {
  const existing = await client.account.findFirst({
    where: { userId, providerId: "credential" },
  });
  if (existing) return;
  const hash = await hashPassword(DEV_PASSWORD);
  await client.account.create({
    data: { userId, providerId: "credential", accountId: userId, password: hash },
  });
  result.passwordsSet.push(email);
}

export async function seedAuthFixtures(
  client: PrismaClient = getPrisma(),
): Promise<SeedAuthResult> {
  const result: SeedAuthResult = { usersCreated: [], passwordsSet: [] };

  for (const platformUser of PLATFORM_USERS) {
    let user = await client.user.findUnique({ where: { email: platformUser.email } });
    if (!user) {
      user = await client.user.create({
        data: { name: platformUser.name, email: platformUser.email, role: platformUser.role },
      });
      result.usersCreated.push(platformUser.email);
    }
    await ensurePassword(client, user.id, platformUser.email, result);
  }

  // Bob, Dave, Priya -- their User row already exists (seedFixtures); only
  // the password is this feature's to add.
  const contractors = await client.contractor.findMany({ select: { userId: true, email: true } });
  for (const contractor of contractors) {
    await ensurePassword(client, contractor.userId, contractor.email, result);
  }

  return result;
}
