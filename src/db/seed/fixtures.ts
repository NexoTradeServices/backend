// Fixture seed -- Feature 1001, schema and seed.
//
// THE CAST, and nothing else. project/design/cast.md is the source: same names,
// same codes, same rates, same suburbs, so a failing test reads like the design
// doc. Never invent a person here -- extend cast.md instead.
//
// DEV AND TEST ONLY. Refuses to run in production, and it is a separate command
// from the base seed for exactly that reason.
//
// NOT seeded: the cast's reference jobs (JOB-1042, INV-2041, CINV-517). The
// features that compute them create them in their own tests -- see the plan's
// Scope. Served postcodes are absent too: service areas are feature 2002, and
// the Suburb rows they read arrive in 1002.
import "dotenv/config";
import { reserveUpTo } from "../reference.js";
import { disconnectPrisma, getPrisma, type PrismaClient } from "../client.js";

/**
 * Money is whole cents. cast.md writes dollars: Bob's call-out $200 is 20000
 * here, his standard $150/h is 15000.
 */
const CAST = {
  contractors: [
    {
      code: "CON-014",
      codeNumber: 14,
      name: "Bob Reilly",
      email: "bob.reilly@example.com",
      phone: "0400 000 014",
      abn: "51000000014",
      businessName: "Reilly Plumbing",
      // "core location Fremantle" (cast.md). Places-shaped, as every stored
      // location is; these coordinates are Fremantle WA 6160.
      coreLocation: {
        suburb: "Fremantle",
        state: "WA",
        country: "AU",
        postcode: "6160",
        lat: -32.0569,
        lng: 115.7439,
        placeId: "fixture-place-fremantle",
      },
      specialties: [
        {
          trade: "Plumbing",
          contractorCalloutRate: 20_000, // $200 call-out
          contractorStandardRate: 15_000, // $150/h
          licenceNumber: "PL-8841", // the one licence cast.md states
          licenceExpiry: "2027-06-30",
        },
      ],
    },
    {
      code: "CON-021",
      codeNumber: 21,
      name: "Dave Hurst",
      email: "dave.hurst@example.com",
      phone: "0400 000 021",
      abn: "51000000021",
      businessName: "Hurst Electrical & Air",
      coreLocation: {
        suburb: "Perth",
        state: "WA",
        country: "AU",
        postcode: "6000",
        lat: -31.9523,
        lng: 115.8613,
        placeId: "fixture-place-perth",
      },
      specialties: [
        {
          trade: "Electrical",
          contractorCalloutRate: 21_000, // $210
          contractorStandardRate: 15_500, // $155/h
          licenceNumber: "EC-0221", // PLACEHOLDER -- cast.md states no licence for Dave
          licenceExpiry: "2027-06-30",
        },
        {
          trade: "Air conditioning",
          contractorCalloutRate: 21_500, // $215
          contractorStandardRate: 16_000, // $160/h
          licenceNumber: "ARC-0221", // PLACEHOLDER
          licenceExpiry: "2027-06-30",
        },
      ],
    },
    {
      code: "CON-030",
      codeNumber: 30,
      name: "Priya Nair",
      email: "priya.nair@example.com",
      phone: "0400 000 030",
      abn: "51000000030",
      businessName: "Nair Electrical",
      coreLocation: {
        suburb: "Cannington",
        state: "WA",
        country: "AU",
        postcode: "6107",
        lat: -32.0165,
        lng: 115.9345,
        placeId: "fixture-place-cannington",
      },
      specialties: [
        {
          trade: "Electrical",
          contractorCalloutRate: 21_500, // $215
          contractorStandardRate: 16_000, // $160/h
          licenceNumber: "EC-0330", // PLACEHOLDER
          licenceExpiry: "2027-06-30",
        },
      ],
    },
  ],
  customers: [
    {
      code: "CUS-1050",
      codeNumber: 1050,
      name: "Sarah Chen",
      email: "sarah.chen@example.com",
      phone: "0400 001 050",
      // GUEST: userId stays empty. The whole guest doctrine hangs off this.
      // "Hilton 6163" (cast.md) -- her own address, Places-shaped. Feature 1001
      // needs her on the map: AC9 measures Fremantle to Hilton through PostGIS.
      billingAddress: {
        street: "12 Paget Street",
        suburb: "Hilton",
        state: "WA",
        country: "AU",
        postcode: "6163",
        lat: -32.0731,
        lng: 115.7797,
        placeId: "fixture-place-hilton",
      },
    },
  ],
} as const;

export interface SeedFixturesResult {
  contractorsCreated: string[];
  customersCreated: string[];
}

export async function seedFixtures(
  client: PrismaClient = getPrisma(),
): Promise<SeedFixturesResult> {
  const result: SeedFixturesResult = { contractorsCreated: [], customersCreated: [] };

  for (const contractor of CAST.contractors) {
    const existing = await client.contractor.findUnique({ where: { code: contractor.code } });
    if (existing === null) {
      // A contractor always has a login (Contractor.userId is required); the
      // account itself is configured by feature 1003.
      await client.contractor.create({
        data: {
          code: contractor.code,
          name: contractor.name,
          businessName: contractor.businessName,
          abn: contractor.abn,
          gstRegistered: false,
          phone: contractor.phone,
          email: contractor.email,
          address: `${contractor.coreLocation.suburb} ${contractor.coreLocation.state} ${contractor.coreLocation.postcode}`,
          coreLocation: contractor.coreLocation,
          status: "active",
          user: {
            create: {
              name: contractor.name,
              email: contractor.email,
              role: "contractor",
            },
          },
          specialties: {
            create: contractor.specialties.map((specialty) => ({
              trade: specialty.trade,
              contractorCalloutRate: specialty.contractorCalloutRate,
              contractorStandardRate: specialty.contractorStandardRate,
              licenceNumber: specialty.licenceNumber,
              licenceExpiry: new Date(specialty.licenceExpiry),
              status: "active",
            })),
          },
        },
      });
      result.contractorsCreated.push(contractor.code);
    }
    // Guard: never let a generated CON- code land on a seeded one.
    await reserveUpTo("CON", contractor.codeNumber, client);
  }

  for (const customer of CAST.customers) {
    const existing = await client.customer.findUnique({ where: { code: customer.code } });
    if (existing === null) {
      await client.customer.create({
        data: {
          code: customer.code,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          billingAddress: customer.billingAddress,
          // userId deliberately absent -- Sarah is a guest until she sets a password
        },
      });
      result.customersCreated.push(customer.code);
    }
    await reserveUpTo("CUS", customer.codeNumber, client);
  }

  return result;
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("fixture seed is dev/test only -- refusing to run with NODE_ENV=production");
  }
  const result = await seedFixtures();
  console.log(
    `fixture seed: contractors created: ${result.contractorsCreated.length ? result.contractorsCreated.join(", ") : "none (already present)"}; ` +
      `customers created: ${result.customersCreated.length ? result.customersCreated.join(", ") : "none (already present)"}`,
  );
  await disconnectPrisma();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error: unknown) => {
    console.error(error);
    await disconnectPrisma();
    process.exit(1);
  });
}
