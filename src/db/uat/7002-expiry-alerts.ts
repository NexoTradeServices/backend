// UAT data for feature 7002, licence and insurance expiry alerts.
//
// No record is created: the alerts watch the cast contractors' expiry dates, so UAT sets three cast
// records to a starting state (the seed has every date months or years away):
//   Bob   (CON-014)  plumbing licence PL-8841 expires 30 days from today -> the morning run emails Bob and
//                    the office inbox (AC1; AC8 is Reply on Bob's copy).
//   Dave  (CON-021)  insurance expires 23 days from today, insurer and policy number filled -> the second
//                    step of the insurance wording (AC5).
//   Priya (CON-030)  electrical specialty suspended, licence expires 9 days from today -> nothing arrives
//                    for Priya (AC6).
// The morning run (POST /api/test-data/daily/run, asked of the implementer during UAT) is what really sends.
//
// Cast records UAT changes: those three, and the alert rows the run writes. restoreCast puts the dates, the
// insurer and policy number, and Priya's specialty back to the seed, and removes the alert rows (their
// idempotency keys would otherwise stop a second run from sending the same pair again); the rows carry no
// label, because the run is not a browser test's.
//
// Sends for real: the morning run emails Bob's cast inbox (bob@idelta.com.au) the licence alert and the
// office inbox (ops@idelta.com.au) its notice, and Dave's cast inbox the insurance alert plus a notice to the
// office inbox -- real Mailjet email. Nothing is sent when this script runs; only the morning run sends.
import type { PrismaClient } from "../client.js";
import { todayIn } from "../../time/index.js";

const ZONE = "Australia/Perth";
const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_LICENCE_EXPIRY = "2027-06-30";
const SEED_DAVE_INSURANCE = { insurer: "QBE", insurancePolicyNo: "PL-7710-020", insuranceExpiry: "2028-03-31" };

/** The business day `days` from today, as a plain date. */
function inDays(days: number): Date {
  return new Date(Date.parse(`${todayIn(ZONE)}T00:00:00Z`) + days * DAY_MS);
}

async function clearAlertRows(client: PrismaClient): Promise<void> {
  await client.notification.deleteMany({ where: { type: { in: ["licence_expiring", "insurance_expiring"] } } });
}

export async function make(client: PrismaClient): Promise<string[]> {
  await clearAlertRows(client);
  await client.contractorSpecialty.updateMany({
    where: { trade: "Plumbing", contractor: { code: "CON-014" } },
    data: { licenceExpiry: inDays(30), status: "active" },
  });
  await client.contractor.update({
    where: { code: "CON-021" },
    data: { insurer: "QBE", insurancePolicyNo: "PL-7710-020", insuranceExpiry: inDays(23) },
  });
  await client.contractorSpecialty.updateMany({
    where: { trade: "Electrical", contractor: { code: "CON-030" } },
    data: { licenceExpiry: inDays(9), status: "suspended" },
  });
  return [
    "Bob's plumbing licence PL-8841 expires 30 days from today (AC1, AC8)",
    "Dave's insurance (QBE, policy PL-7710-020) expires 23 days from today (AC5)",
    "Priya's electrical specialty is suspended, its licence expiring 9 days from today (AC6)",
  ];
}

/** The morning run's rows are what a UAT run uses up: clear them and put the three records back to the starting state. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  return make(client);
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  await clearAlertRows(client);
  await client.contractorSpecialty.updateMany({
    where: { contractor: { code: { in: ["CON-014", "CON-021", "CON-030"] } } },
    data: { licenceExpiry: new Date(SEED_LICENCE_EXPIRY), status: "active" },
  });
  await client.contractor.update({
    where: { code: "CON-021" },
    data: {
      insurer: SEED_DAVE_INSURANCE.insurer,
      insurancePolicyNo: SEED_DAVE_INSURANCE.insurancePolicyNo,
      insuranceExpiry: new Date(SEED_DAVE_INSURANCE.insuranceExpiry),
    },
  });
}
