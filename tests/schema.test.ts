// Feature 1001, schema and seed
//
// AC2   every Data Model record is a table, plus the Better Auth base
// AC7   the unique constraints hold at the database
// AC8   money is whole-cent integers; billed hours is a decimal
// AC10  an invalid lifecycle value is impossible
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { testClient, truncateAll } from "./helpers/database.js";
import { seedBase } from "../src/db/seed/base.js";
import { seedFixtures } from "../src/db/seed/fixtures.js";
import type { PrismaClient } from "../src/db/client.js";

let db: PrismaClient;

beforeAll(async () => {
  db = testClient();
  await truncateAll(db);
});

afterAll(async () => {
  await db.$disconnect();
});

/** A contractor needs a login, so the two are made together. */
async function makeContractor(code: string): Promise<{ id: string }> {
  return db.contractor.create({
    data: {
      code,
      name: `Contractor ${code}`,
      abn: "51000000000",
      phone: "0400 000 000",
      email: `${code.toLowerCase()}@example.com`,
      address: "Perth WA 6000",
      coreLocation: { suburb: "Perth", state: "WA", postcode: "6000", lat: -31.95, lng: 115.86 },
      user: { create: { name: `Contractor ${code}`, email: `${code.toLowerCase()}@example.com`, role: "contractor" } },
    },
    select: { id: true },
  });
}

describe("AC2 -- every record in the Data Model exists", () => {
  // The design's Data Model, record for record, in the order it lists them.
  const DOMAIN_RECORDS = [
    "PlatformSettings",
    "CapabilityToken",
    "Customer",
    "Contractor",
    "ContractorSpecialty",
    "ContractorServedPostcode",
    "Review",
    "CalendarEvent",
    "Job",
    "Assignment",
    "AssignmentTimeLog",
    "AssignmentPart",
    "Attachment",
    "Suburb",
    "ServiceType",
    "Invoice",
    "InvoiceLine",
    "Payment",
    "Refund",
    "ContractorSettlement",
    "Notification",
    "Suppression",
    "ServiceAreaPage",
  ];
  const AUTH_RECORDS = ["User", "Session", "Account"];

  let tables: string[];

  beforeAll(async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    tables = rows.map((row) => row.table_name);
  });

  test("AC2: all 23 domain records are tables", () => {
    // the count is asserted too, so a record dropped from the list above cannot
    // quietly shrink what this test checks
    expect(DOMAIN_RECORDS).toHaveLength(23);
    expect(DOMAIN_RECORDS.filter((record) => !tables.includes(record))).toEqual([]);
  });

  test("AC2: the Better Auth User/Session/Account base is present", () => {
    expect(AUTH_RECORDS.filter((record) => !tables.includes(record))).toEqual([]);
  });

  test("AC2: User carries the four-value role enum", async () => {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'Role'
       ORDER BY e.enumsortorder
    `;
    expect(rows.map((row) => row.enumlabel)).toEqual(["customer", "contractor", "ops", "owner"]);

    const column = await db.$queryRaw<{ udt_name: string }[]>`
      SELECT udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'role'
    `;
    expect(column[0]?.udt_name).toBe("Role");
  });
});

describe("AC7 -- the unique constraints hold", () => {
  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
  });

  test("AC7: all five constraints exist as unique indexes in Postgres", async () => {
    const rows = await db.$queryRaw<{ table_name: string; columns: string }[]>`
      SELECT t.relname AS table_name,
             string_agg(a.attname, ',' ORDER BY k.ord) AS columns
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname = 'public' AND i.indisunique
       GROUP BY t.relname, c.relname
    `;
    const found = rows.map((row) => `${row.table_name}(${row.columns})`);
    for (const expected of [
      "ContractorSpecialty(contractorId,trade)",
      "ContractorServedPostcode(contractorId,postcode)",
      "Suburb(name,postcode,state)",
      "ServiceAreaPage(serviceTypeId,suburbId)",
      "Notification(idempotencyKey)",
    ]) {
      expect(found).toContain(expected);
    }
  });

  test("AC7: a second (contractorId, trade) specialty is rejected", async () => {
    const contractor = await makeContractor("CON-901");
    const specialty = {
      contractorId: contractor.id,
      trade: "Plumbing",
      contractorCalloutRate: 20_000,
      contractorStandardRate: 15_000,
      licenceNumber: "PL-0001",
      licenceExpiry: new Date("2027-06-30"),
    };
    await db.contractorSpecialty.create({ data: specialty });
    await expect(db.contractorSpecialty.create({ data: specialty })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  test("AC7: a second (contractorId, postcode) served postcode is rejected", async () => {
    const contractor = await makeContractor("CON-902");
    const served = { contractorId: contractor.id, postcode: "6160" };
    await db.contractorServedPostcode.create({ data: served });
    await expect(db.contractorServedPostcode.create({ data: served })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  test("AC7: a second (name, postcode, state) Suburb is rejected", async () => {
    await db.suburb.create({
      data: { name: "Hilton", slug: "hilton-6163", postcode: "6163", state: "WA", centroidLat: -32.0731, centroidLng: 115.7797 },
    });
    await expect(
      db.suburb.create({
        data: { name: "Hilton", slug: "hilton-6163-again", postcode: "6163", state: "WA", centroidLat: -32.0731, centroidLng: 115.7797 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("AC7: a second (serviceTypeId, suburbId) ServiceAreaPage is rejected", async () => {
    const serviceType = await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } });
    const suburb = await db.suburb.create({
      data: { name: "Fremantle", slug: "fremantle-6160", postcode: "6160", state: "WA", centroidLat: -32.0569, centroidLng: 115.7439 },
    });
    const page = { serviceTypeId: serviceType.id, suburbId: suburb.id };
    await db.serviceAreaPage.create({ data: page });
    await expect(db.serviceAreaPage.create({ data: page })).rejects.toMatchObject({ code: "P2002" });
  });

  test("AC7: a duplicate Notification.idempotencyKey is rejected", async () => {
    const notification = {
      recipientType: "customer" as const,
      recipientId: "CUS-1050",
      channel: "email" as const,
      type: "invoice",
      category: "transactional" as const,
      idempotencyKey: "invoice:INV-2042:email",
    };
    await db.notification.create({ data: notification });
    await expect(db.notification.create({ data: notification })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});

describe("AC8 -- money is whole cents, billed hours is a decimal", () => {
  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
    await seedFixtures(db);
  });

  test("AC8: every money column is an integer at the database", async () => {
    const MONEY_COLUMNS: [string, string][] = [
      ["PlatformSettings", "calloutFee"],
      ["PlatformSettings", "maxContractorPartAmount"],
      ["ServiceType", "customerCalloutRate"],
      ["ServiceType", "customerStandardRate"],
      ["ContractorSpecialty", "contractorCalloutRate"],
      ["ContractorSpecialty", "contractorStandardRate"],
      ["Job", "customerCalloutRate"],
      ["Job", "customerStandardRate"],
      ["Assignment", "customerCalloutRate"],
      ["Assignment", "customerStandardRate"],
      ["Assignment", "contractorCalloutRate"],
      ["Assignment", "contractorStandardRate"],
      ["Assignment", "customerTotal"],
      ["Assignment", "contractorPay"],
      ["Assignment", "materialsReimbursement"],
      ["AssignmentPart", "unitPrice"],
      ["AssignmentPart", "lineTotal"],
      ["Invoice", "amount"],
      ["Invoice", "labourAmount"],
      ["Invoice", "materialsAmount"],
      ["Invoice", "gstAmount"],
      ["InvoiceLine", "unitPrice"],
      ["InvoiceLine", "lineTotal"],
      ["Payment", "amount"],
      ["Refund", "amount"],
      ["ContractorSettlement", "materialsAmount"],
      ["ContractorSettlement", "totalAmount"],
      ["ContractorSettlement", "gstAmount"],
    ];

    const rows = await db.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
    `;
    const typeOf = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]));

    const wrong = MONEY_COLUMNS.map(([table, column]) => `${table}.${column}`)
      .map((key) => ({ key, type: typeOf.get(key) }))
      .filter((entry) => entry.type !== "integer");
    expect(wrong).toEqual([]);
  });

  test("AC8: Bob's call-out is stored as 20000, not 200.00", async () => {
    const rows = await db.$queryRaw<{ contractorCalloutRate: number }[]>`
      SELECT s."contractorCalloutRate"
        FROM "ContractorSpecialty" s
        JOIN "Contractor" c ON c.id = s."contractorId"
       WHERE c.code = 'CON-014'
    `;
    expect(rows[0]?.contractorCalloutRate).toBe(20_000);
  });

  test("AC8: Assignment.billedHours is a decimal, not an integer", async () => {
    const rows = await db.$queryRaw<{ data_type: string; numeric_scale: number }[]>`
      SELECT data_type, numeric_scale
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'Assignment'
         AND column_name = 'billedHours'
    `;
    expect(rows[0]?.data_type).toBe("numeric");
    expect(rows[0]?.numeric_scale).toBeGreaterThan(0);
  });
});

describe("AC10 -- money is not job state", () => {
  let customerId: string;
  let serviceTypeId: string;

  beforeAll(async () => {
    await truncateAll(db);
    await seedBase(db);
    const customer = await db.customer.create({
      data: { code: "CUS-9001", name: "Sarah Chen", email: "sarah.ac10@example.com" },
    });
    customerId = customer.id;
    serviceTypeId = (await db.serviceType.findUniqueOrThrow({ where: { trade: "Plumbing" } })).id;
  });

  /** The same insert every time; only `status` changes. */
  function insertJobWithStatus(reference: string, status: string): Promise<number> {
    return db.$executeRawUnsafe(`
      INSERT INTO "Job" (
        id, reference, "customerId", "serviceTypeId",
        "customerCalloutRate", "customerStandardRate",
        postcode, "serviceLocation", timezone, "preferredWindow", status, "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, '${reference}', '${customerId}', '${serviceTypeId}',
        25000, 18000,
        '6163', '{"suburb":"Hilton","postcode":"6163"}'::jsonb, 'Australia/Perth', 'morning', '${status}', now()
      )
    `);
  }

  test("AC10: a raw insert of a Job with status 'paid' is refused by the database", async () => {
    await expect(insertJobWithStatus("JOB-9001", "paid")).rejects.toThrow(
      /invalid input value for enum "?JobStatus"?: "paid"/,
    );
  });

  test("AC10: the identical insert with a real status succeeds -- only 'paid' was wrong", async () => {
    await expect(insertJobWithStatus("JOB-9002", "new")).resolves.toBe(1);
    expect(await db.job.count({ where: { reference: "JOB-9002" } })).toBe(1);
  });

  test("AC10: JobStatus holds the seven lifecycle values and no money state", async () => {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'JobStatus'
       ORDER BY e.enumsortorder
    `;
    expect(rows.map((row) => row.enumlabel)).toEqual([
      "new",
      "assigned",
      "scheduled",
      "in_progress",
      "on_hold",
      "completed",
      "cancelled",
    ]);
  });
});
