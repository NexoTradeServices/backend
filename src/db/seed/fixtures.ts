// Fixture seed -- Feature 1001, schema and seed.
//
// THE CAST, and nothing else. project/design/cast.md is the source: same names,
// same codes, same rates, same suburbs, so a failing test reads like the design
// doc. Never invent a person here -- extend cast.md instead.
//
// DEV AND TEST ONLY. Refuses to run in production, and it is a separate command
// from the base seed for exactly that reason.
//
// NOT seeded: the cast's reference documents INV-2041 and CINV-517. The
// features that compute them (Invoicing, Contractor Settlement) create them
// in their own tests -- see those plans' Scope. JOB-1042 (Sarah's mixer tap)
// IS seeded here as of Feature 2003, alongside JOB-1051 (Tom) and JOB-1039
// (Margaret) -- Bob's three live jobs, the dashboard's own fixture (plan
// AC12). Any other test that needs "JOB-1042" reads THIS row rather than
// creating its own (tests/helpers/capability-tokens.ts's seedJob1042()).
//
// Feature 2002, plan decision 13: Bob's service area (lastRadiusKm + a FIXED
// served-postcode list) is written here, hand-picked, because this seed runs
// without the Suburb rows (1002) a real in-range query would need -- the list
// below is the Perth south-of-river postcodes within 30km of Fremantle
// (computed once from the licensed file, ADR 0003), including 6163 (Sarah's
// Hilton), excluding 6027 (Karl's Joondalup -- genuinely out of reach) and
// excluding 6161 (Rottnest Island -- in range by straight-line distance but
// crossed off by hand, so the derived-crossed rule has something real to
// show on reopen). Dave and Priya keep no coreLocation and no served rows:
// neither has ever saved a service area, so the shelf stays empty until they
// do (decision 13) -- 2001's fixture had filled Dave's and Priya's
// coreLocation as an incidental placeholder; 2002 corrects it.
//
// Feature 2003: every contractor's own address + emergency contact are now
// filled too, so the non-blocking readiness nudges (ready.ts) never fire on
// the base cast -- AC6 needs Bob to see no readiness panel at all.
import "dotenv/config";
import { Prisma } from "../../generated/prisma/client.js";
import { reserveUpTo } from "../reference.js";
import { zoneForState, nextWeekdayAt, todayAt } from "../../time/index.js";
import { disconnectPrisma, getPrisma, type PrismaClient } from "../client.js";
import { seedAuthFixtures } from "./auth.js";

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
      email: "bob@idelta.com.au",
      phone: "0400 000 014",
      abn: "51000000680", // ATO-checksum-valid (decision 10)
      businessName: "Reilly Plumbing",
      // Feature 2001, AC12: Bob and Dave gain insurance and payout details.
      insurer: "QBE",
      insurancePolicyNo: "PL-2291-884",
      insuranceExpiry: "2028-02-28",
      payoutBsb: "066-000",
      payoutAccountNo: "12345678",
      payoutAccountName: "B Reilly",
      // Feature 2003, AC6: his own address + emergency contact, so his
      // dashboard shows no readiness panel at all -- neither is in cast.md,
      // so these are invented, same spirit as the ABN/insurer above.
      address: {
        street: "14 High Street",
        suburb: "Fremantle",
        state: "WA",
        country: "AU",
        postcode: "6160",
        lat: -32.0569,
        lng: 115.7439,
        placeId: "fixture-place-fremantle-home",
      },
      emergencyContactName: "Jenny Reilly",
      emergencyContactPhone: "0400 100 014",
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
      lastRadiusKm: 30,
      // The Perth south-of-river postcodes within 30km of Fremantle
      // (nearest-suburb-centroid distance, licensed file, computed 07/09/26),
      // nearest first. Includes 6163 (Hilton); 6027 (Joondalup) never appears
      // -- it is genuinely past 30km; 6161 (Rottnest Island) is deliberately
      // left off though it is in range by sea, so reopening the page shows it
      // crossed off (decision 6).
      servedPostcodes: [
        "6160", "6162", "6157", "6163", "6156", "6154", "6166", "6150",
        "6153", "6164", "6149", "6148", "6152", "6155", "6151", "6147",
        "6107", "6101", "6100", "6102", "6167", "6112", "6168", "6108",
        "6106", "6110", "6105", "6109", "6111", "6170", "6121", "6058",
        "6169", "6057", "6122", "6076",
      ],
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
      email: "dave@idelta.com.au",
      phone: "0400 000 021",
      abn: "51000000761", // ATO-checksum-valid (decision 10)
      businessName: "Hurst Electrical & Air",
      insurer: "QBE",
      insurancePolicyNo: "PL-7710-020",
      insuranceExpiry: "2028-03-31",
      payoutBsb: "066-102",
      payoutAccountNo: "22110021",
      payoutAccountName: "D Hurst",
      // Feature 2003: his own address + emergency contact, same spirit as Bob's.
      address: {
        street: "9 Berwick Street",
        suburb: "Victoria Park",
        state: "WA",
        country: "AU",
        postcode: "6100",
        lat: -31.9803,
        lng: 115.9003,
        placeId: "fixture-place-victoria-park",
      },
      emergencyContactName: "Karen Hurst",
      emergencyContactPhone: "0400 100 021",
      // No service area saved (decision 13) -- the shelf stays empty until
      // Dave (or Mike) opens the Service area page once.
      coreLocation: null,
      lastRadiusKm: null,
      servedPostcodes: [] as string[],
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
      email: "priya@idelta.com.au",
      phone: "0400 000 030",
      abn: "51000000793", // ATO-checksum-valid (decision 10)
      businessName: "Nair Electrical",
      // AC12: Priya gets an insurance expiry in the past -- insurer and
      // policy number are set so the missing-items list names exactly
      // "insurance renewal (expired)", not a wholesale "insurance details".
      // No payout details: she stays Not ready for more than one reason,
      // same as cast.md's "never a customer, third candidate" framing.
      insurer: "Allianz",
      insurancePolicyNo: "PL-3090-011",
      insuranceExpiry: "2024-08-31",
      payoutBsb: null,
      payoutAccountNo: null,
      payoutAccountName: null,
      // Feature 2003, AC7: her own address + emergency contact are filled so
      // her panel shows exactly the three items the AC names (service area,
      // bank details, expired insurance) and no non-blocking nudge besides.
      address: {
        street: "5 Flora Terrace",
        suburb: "West Perth",
        state: "WA",
        country: "AU",
        postcode: "6005",
        lat: -31.9505,
        lng: 115.8425,
        placeId: "fixture-place-west-perth",
      },
      emergencyContactName: "Raj Nair",
      emergencyContactPhone: "0400 100 030",
      // No service area saved (decision 13) -- same as Dave.
      coreLocation: null,
      lastRadiusKm: null,
      servedPostcodes: [] as string[],
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
      email: "sarah@idelta.com.au",
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
    {
      // Feature 2003, AC2/AC12: JOB-1051, "sits at the far edge of Bob's
      // reach" (cast.md) -- Kalamunda is the last postcode in his served
      // list above. cast.md gives Tom no code yet; CUS-1051 is skipped here
      // (already a real, hand-inserted row outside the seed -- project/setup/
      // 01-dev-environment.md, section 7b), so he takes CUS-1052.
      code: "CUS-1052",
      codeNumber: 1052,
      name: "Tom",
      email: "tom@idelta.com.au",
      phone: "0400 001 052",
      billingAddress: {
        street: "22 Williams Road",
        suburb: "Kalamunda",
        state: "WA",
        country: "AU",
        postcode: "6076",
        lat: -31.974211,
        lng: 116.051444,
        placeId: "fixture-place-kalamunda",
      },
    },
    {
      // Feature 2003, AC3/AC12: JOB-1039, on hold with no return date.
      // "her postcode also covers Ardross and Mount Pleasant" (cast.md) --
      // the one-postcode-many-suburbs case; her own suburb is Applecross.
      code: "CUS-1053",
      codeNumber: 1053,
      name: "Margaret",
      email: "margaret@idelta.com.au",
      phone: "0400 001 053",
      billingAddress: {
        street: "8 Riverside Road",
        suburb: "Applecross",
        state: "WA",
        country: "AU",
        postcode: "6153",
        lat: -32.015475,
        lng: 115.836868,
        placeId: "fixture-place-applecross",
      },
    },
  ],
} as const;

export interface SeedFixturesResult {
  contractorsCreated: string[];
  customersCreated: string[];
  jobsCreated: string[];
}

export async function seedFixtures(
  client: PrismaClient = getPrisma(),
): Promise<SeedFixturesResult> {
  const result: SeedFixturesResult = { contractorsCreated: [], customersCreated: [], jobsCreated: [] };

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
          // The own-address / emergency-contact fields (Feature 2003) are
          // separate from `coreLocation` below -- that is the SERVICE AREA
          // pin (Managing the contractor record), never his own home.
          address: contractor.address,
          emergencyContactName: contractor.emergencyContactName,
          emergencyContactPhone: contractor.emergencyContactPhone,
          coreLocation: contractor.coreLocation ?? Prisma.JsonNull,
          lastRadiusKm: contractor.lastRadiusKm,
          insurer: contractor.insurer,
          insurancePolicyNo: contractor.insurancePolicyNo,
          insuranceExpiry: new Date(contractor.insuranceExpiry),
          payoutBsb: contractor.payoutBsb,
          payoutAccountNo: contractor.payoutAccountNo,
          payoutAccountName: contractor.payoutAccountName,
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
          servedPostcodes: {
            create: contractor.servedPostcodes.map((postcode) => ({ postcode })),
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

  // ---------------------------------------------------------------------
  // Feature 2003, AC12: Bob's three live jobs and their assignments -- the
  // dashboard's own fixture. Create-if-missing (base.ts's own rule), keyed
  // on the reference, so a second run of this seed is a no-op here too.
  // ---------------------------------------------------------------------
  const jobFixtures = [
    {
      reference: "JOB-1042",
      customerCode: "CUS-1050", // Sarah, Hilton
      postcode: "6163",
      suburb: "Hilton",
      lat: -32.0731,
      lng: 115.7797,
      placeId: "fixture-place-hilton",
      // AC2: "awaiting Bob's answer for Thursday 8:00am" -- always the next
      // Thursday, so the seed reads true on whichever day it runs.
      assignment: (now: Date, zone: string) => ({
        status: "assigned" as const,
        proposedSlot: nextWeekdayAt(zone, "thu", 8, 0, now),
        confirmedSlot: null,
      }),
      jobStatus: "assigned" as const,
    },
    {
      reference: "JOB-1051",
      customerCode: "CUS-1052", // Tom, Kalamunda
      postcode: "6076",
      suburb: "Kalamunda",
      lat: -31.974211,
      lng: 116.051444,
      placeId: "fixture-place-kalamunda",
      // AC2: "already accepted for today 1:00pm".
      assignment: (now: Date, zone: string) => ({
        status: "accepted" as const,
        proposedSlot: todayAt(zone, 13, 0, now),
        confirmedSlot: todayAt(zone, 13, 0, now),
      }),
      jobStatus: "scheduled" as const,
    },
    {
      reference: "JOB-1039",
      customerCode: "CUS-1053", // Margaret, Applecross
      postcode: "6153",
      suburb: "Applecross",
      lat: -32.015475,
      lng: 115.836868,
      placeId: "fixture-place-applecross",
      // AC3: on hold, no return date -- the original visit already happened
      // (a slot a few days back); Job.status = on_hold is what makes the
      // dashboard treat this assignment as having no (sortable) slot at
      // all, whatever `confirmedSlot` still holds (Job Lifecycle & Statuses).
      assignment: (now: Date, zone: string) => ({
        status: "in_progress" as const,
        proposedSlot: todayAt(zone, 9, 0, new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)),
        confirmedSlot: todayAt(zone, 9, 0, new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)),
      }),
      jobStatus: "on_hold" as const,
    },
  ];

  const jobsCreated: string[] = [];
  const bob = await client.contractor.findUnique({ where: { code: "CON-014" }, include: { specialties: true } });
  const plumbingSpecialty = bob?.specialties.find((s) => s.trade === "Plumbing");
  const plumbingType = await client.serviceType.findUnique({ where: { trade: "Plumbing" } });
  const zone = zoneForState("WA");
  const now = new Date();

  if (bob && plumbingSpecialty && plumbingType) {
    for (const fixture of jobFixtures) {
      const existingJob = await client.job.findUnique({ where: { reference: fixture.reference } });
      if (existingJob !== null) continue;

      const customer = await client.customer.findUniqueOrThrow({ where: { code: fixture.customerCode } });
      // Feature 3001, AC9: preferredDate is NOT NULL now -- each fixture's
      // real date is the same date its own assignment is scheduled against
      // (proposedSlot), so the job and its visit never disagree.
      const assignmentInput = fixture.assignment(now, zone);
      const created = await client.job.create({
        data: {
          reference: fixture.reference,
          customerId: customer.id,
          serviceTypeId: plumbingType.id,
          customerCalloutRate: plumbingType.customerCalloutRate,
          customerStandardRate: plumbingType.customerStandardRate,
          postcode: fixture.postcode,
          serviceLocation: {
            suburb: fixture.suburb,
            state: "WA",
            country: "AU",
            lat: fixture.lat,
            lng: fixture.lng,
            placeId: fixture.placeId,
          },
          timezone: zone,
          source: "web",
          preferredWindow: "morning",
          preferredDate: assignmentInput.proposedSlot,
          status: fixture.jobStatus,
        },
      });
      await client.assignment.create({
        data: {
          jobId: created.id,
          contractorId: bob.id,
          specialtyId: plumbingSpecialty.id,
          status: assignmentInput.status,
          proposedSlot: assignmentInput.proposedSlot,
          confirmedSlot: assignmentInput.confirmedSlot,
        },
      });
      jobsCreated.push(fixture.reference);
    }
    // Guard: JOB-1051 sits above the sequence's configured start (1043) --
    // never let a generated JOB- reference land on it.
    await reserveUpTo("JOB", 1051, client);
  }
  result.jobsCreated.push(...jobsCreated);

  return result;
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("fixture seed is dev/test only -- refusing to run with NODE_ENV=production");
  }
  const result = await seedFixtures();
  console.log(
    `fixture seed: contractors created: ${result.contractorsCreated.length ? result.contractorsCreated.join(", ") : "none (already present)"}; ` +
      `customers created: ${result.customersCreated.length ? result.customersCreated.join(", ") : "none (already present)"}; ` +
      `jobs created: ${result.jobsCreated.length ? result.jobsCreated.join(", ") : "none (already present)"}`,
  );
  // Feature 1003 -- every seeded login gets the same dev password.
  const authResult = await seedAuthFixtures();
  console.log(
    `fixture seed: platform users created: ${authResult.usersCreated.length ? authResult.usersCreated.join(", ") : "none (already present)"}; ` +
      `passwords set: ${authResult.passwordsSet.length ? authResult.passwordsSet.join(", ") : "none (already present)"}`,
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
