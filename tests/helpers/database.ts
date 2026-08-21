// Test-database helpers -- feature 1001
// (project/delivery/1001-schema-and-seed/plan.md).
//
// Tests run against tradeservice_test, the database setup/01-dev-environment.md
// created for exactly this and nothing else. It is wiped at the start of every
// run, so it is throwaway in the sense that matters (no state survives a run)
// without Docker, which setup/01 rules out of dev entirely.
//
// The wipe drops only objects owned by the connecting role. PostGIS and its
// spatial_ref_sys table belong to postgres, so they are left standing -- which is
// the point: the role is deliberately not a superuser and could not put them back.
import { execFileSync } from "node:child_process";
import { createPrismaClient, type PrismaClient } from "../../src/db/client.js";
import { REFERENCE_SEQUENCES } from "../../src/config/references.js";

const PRISMA_BIN = new URL("../../node_modules/.bin/prisma", import.meta.url).pathname;
const BACKEND_ROOT = new URL("../../", import.meta.url).pathname;

export function testDatabaseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set -- see .env.example");
  }
  if (!/_test(\?|$)/.test(url)) {
    // A guard, not a formality: this module drops every table it can see.
    throw new Error(`refusing to run tests against ${url} -- the database name must end in _test`);
  }
  return url;
}

/** Drop every table, enum and sequence this role owns. PostGIS survives. */
export async function dropAllOwnedObjects(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles o ON o.oid = c.relowner
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND o.rolname = current_user
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.relname);
      END LOOP;

      FOR r IN
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles o ON o.oid = c.relowner
        WHERE n.nspname = 'public' AND c.relkind = 'S' AND o.rolname = current_user
      LOOP
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.relname);
      END LOOP;

      FOR r IN
        SELECT t.typname FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_roles o ON o.oid = t.typowner
        WHERE n.nspname = 'public' AND t.typtype = 'e' AND o.rolname = current_user
      LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
      END LOOP;
    END $$;
  `);
}

/** `prisma migrate deploy` against the test database -- the AC1 command itself. */
export function migrateDeploy(): string {
  return execFileSync(PRISMA_BIN, ["migrate", "deploy"], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Empty database -> full schema. Used by the run's global setup and by AC1. */
export async function resetDatabase(client: PrismaClient): Promise<void> {
  await dropAllOwnedObjects(client);
  migrateDeploy();
}

/** Every table Prisma manages, in the current database. */
export async function managedTableNames(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRaw<{ tablename: string }[]>`
    SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles o ON o.oid = c.relowner
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND o.rolname = current_user
       AND c.relname <> '_prisma_migrations'
     ORDER BY c.relname
  `;
  return rows.map((row) => row.tablename);
}

/** Fast per-file wipe: empty every table, leave the schema in place. */
export async function truncateAll(client: PrismaClient): Promise<void> {
  const tables = await managedTableNames(client);
  if (tables.length === 0) return;
  const list = tables.map((table) => `public."${table}"`).join(", ");
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Put the six reference sequences back to their configured start values. */
export async function resetReferenceSequences(client: PrismaClient): Promise<void> {
  for (const { sequenceName, start } of Object.values(REFERENCE_SEQUENCES)) {
    await client.$executeRawUnsafe(`ALTER SEQUENCE "${sequenceName}" RESTART WITH ${start}`);
  }
}

/** A client bound to the test database. Remember to $disconnect(). */
export function testClient(): PrismaClient {
  return createPrismaClient(testDatabaseUrl());
}
