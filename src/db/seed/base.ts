// Base seed -- Feature 1001, schema and seed.
//
// The rows the platform cannot run without: the single PlatformSettings row and
// the ServiceType catalog. Safe on every environment, including production.
//
// IDEMPOTENT BY CREATE-IF-MISSING, not by upsert. Both of these tables are the
// OWNER'S to edit later (PlatformSettings in feature 1006, ServiceType rates in
// 1007), so a second run must leave an edited row exactly as the owner left it.
// An upsert would quietly write the seed's placeholder rates back over real ones.
import "dotenv/config";
import { disconnectPrisma, getPrisma, type PrismaClient } from "../client.js";

/** The one PlatformSettings row. A fixed id keeps the singleton a singleton. */
export const PLATFORM_SETTINGS_ID = "00000000-0000-7000-8000-000000000001";

export interface SeedBaseResult {
  platformSettingsCreated: boolean;
  serviceTypesCreated: string[];
}

export async function seedBase(client: PrismaClient = getPrisma()): Promise<SeedBaseResult> {
  const result: SeedBaseResult = { platformSettingsCreated: false, serviceTypesCreated: [] };

  // ---- PlatformSettings -------------------------------------------------
  // Values the design settles outright: GST off until the owner registers, 10%
  // AU rate, 7-day terms, a 30-minute floor on return visits, a $150 cap on a
  // contractor-supplied part, and Mike's Friday payout run.
  // Marked PLACEHOLDER: the owner sets the real value on the 1006 settings screen.
  if ((await client.platformSettings.findFirst()) === null) {
    await client.platformSettings.create({
      data: {
        id: PLATFORM_SETTINGS_ID,
        gstRegistered: false,
        gstRatePercent: "10",
        timezone: "Australia/Perth", // Feature 1008 -- Data Model / Time
        paymentTermsDays: 7,
        returnVisitMinimumMinutes: 30,
        maxContractorPartAmount: 15_000,
        payoutCycle: "weekly",
        payoutDay: "fri",
        serviceReachKm: 25, // PLACEHOLDER
        calloutFee: 15_000, // PLACEHOLDER -- customer no-show fee, passed to the contractor
        operatorPhone: "08 0000 0000", // PLACEHOLDER
        operatorEmail: "ops@idelta.com.au", // Feature 1006 -- the real inbox, B-004
        displayName: "Perth Trades & Services", // Feature 1014 -- interim wording, ADR 0005
        emailProvider: "mailjet", // ADR 0000 (moved from MailerSend 30/08/26)
        smsProvider: "clicksend", // ADR 0000
      },
    });
    result.platformSettingsCreated = true;
  }

  // ---- ServiceType catalog ----------------------------------------------
  // Plumbing carries the real numbers: $250 call-out + first hour and $180/h
  // after are the rates behind the cast's INV-2041. Electrical and Air
  // conditioning are placeholders until the owner prices them in 1007.
  // The multipliers are placeholders too (normal 1.0, emergency 1.5, weekend 1.5).
  const serviceLevelMultipliers = { normal: 1.0, emergency: 1.5, weekend: 1.5 };

  const serviceTypes = [
    {
      trade: "Plumbing",
      slug: "plumbing",
      customerCalloutRate: 25_000,
      customerStandardRate: 18_000,
    },
    {
      trade: "Electrical",
      slug: "electrical",
      customerCalloutRate: 26_000, // PLACEHOLDER
      customerStandardRate: 19_000, // PLACEHOLDER
    },
    {
      trade: "Air conditioning",
      slug: "air-conditioning",
      customerCalloutRate: 27_000, // PLACEHOLDER
      customerStandardRate: 20_000, // PLACEHOLDER
    },
  ];

  for (const serviceType of serviceTypes) {
    const existing = await client.serviceType.findUnique({ where: { trade: serviceType.trade } });
    if (existing === null) {
      await client.serviceType.create({
        data: { ...serviceType, serviceLevelMultipliers, prefilledFields: [] },
      });
      result.serviceTypesCreated.push(serviceType.trade);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const result = await seedBase();
  console.log(
    `base seed: PlatformSettings ${result.platformSettingsCreated ? "created" : "already present"}; ` +
      `ServiceTypes created: ${result.serviceTypesCreated.length ? result.serviceTypesCreated.join(", ") : "none (already present)"}`,
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
