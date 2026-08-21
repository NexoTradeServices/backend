// Feature 1001 -- project/delivery/1001-schema-and-seed/plan.md
//
// AC6  the reference generator issues sequential unique values per prefix
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetReferenceSequences, testClient, truncateAll } from "./helpers/database.js";
import { nextReference, nextReferenceNumber } from "../src/db/reference.js";
import {
  REFERENCE_PREFIXES,
  REFERENCE_SEQUENCES,
  parseReference,
} from "../src/config/references.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

beforeAll(() => {
  db = testClient();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  await resetReferenceSequences(db);
});

describe("AC6 -- sequential, unique, independent", () => {
  test("AC6: two jobs created concurrently get distinct consecutive JOB- numbers", async () => {
    const [first, second] = await Promise.all([
      nextReference("JOB", db),
      nextReference("JOB", db),
    ]);
    expect(first).not.toEqual(second);

    const numbers = [parseReference("JOB", first)!, parseReference("JOB", second)!].sort(
      (a, b) => a - b,
    );
    expect(numbers[1] - numbers[0]).toBe(1);
    expect(numbers[0]).toBe(REFERENCE_SEQUENCES.JOB.start);
  });

  test("AC6: twenty concurrent callers get twenty different numbers", async () => {
    const references = await Promise.all(
      Array.from({ length: 20 }, () => nextReference("JOB", db)),
    );
    expect(new Set(references).size).toBe(20);

    const numbers = references.map((reference) => parseReference("JOB", reference)!).sort((a, b) => a - b);
    const start = REFERENCE_SEQUENCES.JOB.start;
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => start + index));
  });

  test("AC6: all six sequences run independently", async () => {
    // Draw one of each: every prefix must hand back its OWN configured start.
    for (const prefix of REFERENCE_PREFIXES) {
      expect(await nextReferenceNumber(prefix, db)).toBe(REFERENCE_SEQUENCES[prefix].start);
    }
    // Now burn ten JOB numbers; nobody else may move.
    for (let index = 0; index < 10; index += 1) {
      await nextReferenceNumber("JOB", db);
    }
    for (const prefix of REFERENCE_PREFIXES) {
      const expected = REFERENCE_SEQUENCES[prefix].start + (prefix === "JOB" ? 11 : 1);
      expect(await nextReferenceNumber(prefix, db)).toBe(expected);
    }
  });

  test("AC6: each prefix formats the way the cast writes it", async () => {
    expect(await nextReference("JOB", db)).toBe("JOB-1043");
    expect(await nextReference("INV", db)).toBe("INV-2042");
    expect(await nextReference("CINV", db)).toBe("CINV-518");
    expect(await nextReference("CN", db)).toBe("CN-1001");
    expect(await nextReference("CUS", db)).toBe("CUS-1051");
    expect(await nextReference("CON", db)).toBe("CON-031");
  });

  test("AC6: the sequences start past the cast, so a generated code cannot collide with a fixture", async () => {
    await seedFixtures(db);

    // The seeded codes, and the next generated one for each party prefix.
    const seededContractorCodes = (await db.contractor.findMany({ select: { code: true } })).map(
      (row) => row.code,
    );
    const seededCustomerCodes = (await db.customer.findMany({ select: { code: true } })).map(
      (row) => row.code,
    );
    expect(seededContractorCodes.sort()).toEqual(["CON-014", "CON-021", "CON-030"]);
    expect(seededCustomerCodes).toEqual(["CUS-1050"]);

    // Draw a handful and prove none of them lands on a seeded code.
    for (let index = 0; index < 5; index += 1) {
      const contractorCode = await nextReference("CON", db);
      const customerCode = await nextReference("CUS", db);
      expect(seededContractorCodes).not.toContain(contractorCode);
      expect(seededCustomerCodes).not.toContain(customerCode);
      expect(parseReference("CON", contractorCode)!).toBeGreaterThan(30);
      expect(parseReference("CUS", customerCode)!).toBeGreaterThan(1050);
    }
  });

  test("AC6: the document sequences start past the cast's reference jobs too", async () => {
    // JOB-1042, INV-2041 and CINV-517 are not seeded (the features that compute
    // them create them), but a generated number must never reuse one.
    expect(parseReference("JOB", await nextReference("JOB", db))!).toBeGreaterThan(1042);
    expect(parseReference("INV", await nextReference("INV", db))!).toBeGreaterThan(2041);
    expect(parseReference("CINV", await nextReference("CINV", db))!).toBeGreaterThan(517);
  });

  test("AC6: a generated reference survives being stored in its unique column", async () => {
    // The generator is only as good as the column it lands in: write two rows.
    const first = await nextReference("CUS", db);
    const second = await nextReference("CUS", db);
    await db.customer.create({ data: { code: first, name: "One", email: "one@example.com" } });
    await db.customer.create({ data: { code: second, name: "Two", email: "two@example.com" } });
    expect(await db.customer.count()).toBe(2);
  });
});
