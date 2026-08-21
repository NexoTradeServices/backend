// The reference / code generator -- feature 1001
// (project/delivery/1001-schema-and-seed/plan.md).
//
// One Postgres sequence per prefix (created in the first migration, configured in
// src/config/references.ts). Postgres does the hard part: nextval() never hands
// the same number to two callers, whatever the concurrency, and it does not block
// -- which is exactly the guarantee a document number needs. Numbers are not
// reused after a rollback, and for a tax document that is the right trade: a gap
// is harmless, a duplicate is not.
import {
  REFERENCE_SEQUENCES,
  formatReference,
  type ReferencePrefix,
} from "../config/references.js";
import { getPrisma, type PrismaClient } from "./client.js";

/**
 * Anything that can run a raw query: the client, or a transaction handle from
 * `prisma.$transaction(...)`. Taking this rather than PrismaClient lets a caller
 * mint a reference inside the same transaction that writes the row.
 */
export type RawQueryRunner = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** Issue the next value for a prefix, e.g. "JOB-1043". */
export async function nextReference(
  prefix: ReferencePrefix,
  client: RawQueryRunner = getPrisma(),
): Promise<string> {
  return formatReference(prefix, await nextReferenceNumber(prefix, client));
}

/** The raw sequence value behind nextReference(), e.g. 1043. */
export async function nextReferenceNumber(
  prefix: ReferencePrefix,
  client: RawQueryRunner = getPrisma(),
): Promise<number> {
  const { sequenceName } = REFERENCE_SEQUENCES[prefix];
  const rows = await client.$queryRaw<{ value: bigint }[]>`
    SELECT nextval(${sequenceName}::regclass) AS value
  `;
  const value = rows[0]?.value;
  if (value === undefined) {
    throw new Error(`sequence ${sequenceName} returned no value`);
  }
  return Number(value);
}

/**
 * Raise a sequence so the next value it issues is past `reservedNumber`.
 * Only ever raises -- a lower number is ignored, so this can never hand out a
 * code that is already on a row. The fixture seed calls it after writing the
 * cast's explicit codes (CON-014 and friends) as a guard: the configured start
 * numbers already sit past the cast, so in practice it is a no-op.
 */
export async function reserveUpTo(
  prefix: ReferencePrefix,
  reservedNumber: number,
  client: RawQueryRunner = getPrisma(),
): Promise<void> {
  const { sequenceName, start } = REFERENCE_SEQUENCES[prefix];
  const floor = start - 1;
  await client.$executeRaw`
    SELECT setval(
      ${sequenceName}::regclass,
      GREATEST(
        ${reservedNumber}::bigint,
        ${floor}::bigint,
        COALESCE(
          (SELECT last_value FROM pg_sequences
            WHERE schemaname = 'public' AND sequencename = ${sequenceName}),
          ${floor}::bigint
        )
      ),
      true
    )
  `;
}
