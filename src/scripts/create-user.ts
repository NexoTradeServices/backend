// create-user -- Feature 1003, auth + roles.
//
// Bootstraps ONE real login: email, name, role, prompted password. Runs
// against whichever DATABASE_URL is in the environment -- dev, or Neon in
// prod, per `project/setup/03-prod-environment.md` section 5 ("from `backend/`
// on the dev machine, DATABASE_URL='<neon pooled url>' npm run auth:create-user").
//
// No self-signup exists anywhere on this platform (Authentication &
// Security) -- ops and owner accounts are invite-only, and this script is the
// invite. It writes the same User + Account shape the seed fixtures do, hashed
// the same way Better Auth hashes a password at signup, so the account can log
// in through the real endpoint with no extra step.
//
// The password prompt echoes to the terminal -- this is a one-off, operator-run
// bootstrap script, not a shared login prompt, and it is run by whoever already
// holds the DATABASE_URL for that environment.
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { hashPassword } from "better-auth/crypto";
import { disconnectPrisma, getPrisma } from "../db/client.js";
import { Role } from "../generated/prisma/enums.js";

const ROLES = Object.values(Role);

function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

async function main(): Promise<void> {
  const client = getPrisma();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const email = (await rl.question("Email: ")).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`"${email}" does not look like an email address`);
    }

    const existing = await client.user.findUnique({ where: { email } });
    if (existing) {
      throw new Error(
        `a user already exists for ${email} (role ${existing.role}) -- refusing to overwrite it`,
      );
    }

    const name = (await rl.question("Name: ")).trim();
    if (!name) throw new Error("name is required");

    const roleInput = (await rl.question(`Role (${ROLES.join(" / ")}): `)).trim();
    if (!isRole(roleInput)) {
      throw new Error(`"${roleInput}" is not one of: ${ROLES.join(", ")}`);
    }

    const password = await rl.question("Password (min 8 characters): ");
    if (password.length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const confirm = await rl.question("Confirm password: ");
    if (confirm !== password) {
      throw new Error("passwords did not match");
    }

    const hash = await hashPassword(password);
    const user = await client.user.create({ data: { email, name, role: roleInput } });
    await client.account.create({
      data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash },
    });

    console.log(`Created ${roleInput} login for ${email} (user ${user.id}).`);
  } finally {
    rl.close();
  }

  await disconnectPrisma();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectPrisma();
  process.exit(1);
});
