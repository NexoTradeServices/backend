// Prisma 7 configuration -- feature 1001
// (project/delivery/1001-schema-and-seed/plan.md).
//
// Prisma 7 moved the datasource URL out of schema.prisma and into this file.
// It is read by the CLI only -- migrate, generate, studio, db execute. The
// RUNNING APP does not read it: src/db/client.ts builds the client from
// DATABASE_URL through the pg driver adapter.
//
// That split is why this file prefers DIRECT_URL. setup/03-prod-environment.md
// gives Neon two connection strings on purpose: the pooled one for traffic, and
// the direct one for "changing the shape of the database itself, because
// reception gets in the way". Migrations are exactly that -- the migrate engine
// takes a Postgres advisory lock and holds it across statements, and a
// transaction pooler is free to hand the next statement to a different backend,
// which loses the lock. So the CLI takes DIRECT_URL when it is set and falls
// back to DATABASE_URL when it is not. Locally there is one unpooled Postgres
// and no DIRECT_URL, so the fallback is the normal path on .40. See review
// finding R1.3.
import "dotenv/config";
import { defineConfig } from "prisma/config";

const cliUrl = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: cliUrl },
});
