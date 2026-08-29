// The Prisma client -- Feature 1001, schema and seed.
//
// Prisma 7 talks to Postgres through a driver adapter, so the connection string
// is supplied here rather than in schema.prisma.
//
// The shared client is built ON FIRST USE, never at import time: importing this
// module (for a type, or for createPrismaClient) must not demand a DATABASE_URL
// or open a pool. Tests point DATABASE_URL at tradeservice_test, or pass their
// own client in.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set -- see .env.example");
  }
  return url;
}

/** A fresh client against a given database. The caller owns $disconnect(). */
export function createPrismaClient(connectionString: string = databaseUrl()): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

let shared: PrismaClient | undefined;

/** The process-wide client for the running app and the seed commands. */
export function getPrisma(): PrismaClient {
  shared ??= createPrismaClient();
  return shared;
}

export async function disconnectPrisma(): Promise<void> {
  await shared?.$disconnect();
  shared = undefined;
}

export type { PrismaClient };
