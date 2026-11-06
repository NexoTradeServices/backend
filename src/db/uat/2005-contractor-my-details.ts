// UAT data for feature 2005, Contractor My details.
//
// No new records are made: the UAT uses the cast as they are seeded.
//   a. Bob (bob@idelta.com.au) has bank details on file -> replacing them sends the Bank details changed email (AC5)
//   b. Priya (priya@idelta.com.au) has NO bank details -> a first entry sends nothing (AC6), and her dashboard item
//      "payout details" links to My details (AC7)
//   c. A new contractor the owner adds at UAT for AC8 (Greg's mailbox, greg@idelta.com.au) -- cleared with the rest
//
// Sends for real: nothing is sent by this script. At UAT, replacing Bob's bank details emails Bob (bob@idelta.com.au)
// and the business inbox; adding the new contractor emails greg@idelta.com.au (the welcome email).
//
// Cast records UAT can change: Bob's and Priya's address, emergency contact and bank details and their audit pair, and
// the contractor added at UAT. restoreCast puts the cast back as the seed has them and removes the added contractor.
import type { PrismaClient } from "../client.js";

const BOB_ADDRESS = {
  street: "14 High Street",
  suburb: "Fremantle",
  state: "WA",
  country: "AU",
  postcode: "6160",
  lat: -32.0569,
  lng: 115.7439,
  placeId: "fixture-place-fremantle-home",
};
const PRIYA_ADDRESS = {
  street: "5 Flora Terrace",
  suburb: "West Perth",
  state: "WA",
  country: "AU",
  postcode: "6005",
  lat: -31.9505,
  lng: 115.8425,
  placeId: "fixture-place-west-perth",
};
const ADDED_EMAIL = "greg@idelta.com.au";

export async function restoreCast(client: PrismaClient): Promise<void> {
  await client.contractor.update({
    where: { code: "CON-014" },
    data: {
      address: BOB_ADDRESS,
      emergencyContactName: "Jenny Reilly",
      emergencyContactPhone: "0400 100 014",
      payoutBsb: "066-000",
      payoutAccountNo: "12345678",
      payoutAccountName: "B Reilly",
      payoutChangedByUserId: null,
      payoutChangedAt: null,
    },
  });
  await client.contractor.update({
    where: { code: "CON-030" },
    data: {
      address: PRIYA_ADDRESS,
      emergencyContactName: "Raj Nair",
      emergencyContactPhone: "0400 100 030",
      payoutBsb: null,
      payoutAccountNo: null,
      payoutAccountName: null,
      payoutChangedByUserId: null,
      payoutChangedAt: null,
    },
  });
  // The contractor added at UAT (AC8): a fresh row with only a login, a welcome email and nothing else attached.
  const added = await client.contractor.findFirst({ where: { email: ADDED_EMAIL } });
  if (added !== null) {
    await client.notification.deleteMany({ where: { OR: [{ recipientId: added.id }, { recipientId: added.userId }] } });
    await client.contractorAvailability.deleteMany({ where: { contractorId: added.id } });
    await client.contractorServedPostcode.deleteMany({ where: { contractorId: added.id } });
    await client.contractorSpecialty.deleteMany({ where: { contractorId: added.id } });
    await client.contractor.delete({ where: { id: added.id } });
    await client.session.deleteMany({ where: { userId: added.userId } });
    await client.account.deleteMany({ where: { userId: added.userId } });
    await client.user.delete({ where: { id: added.userId } });
  }
}

export async function make(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return [
    "CON-014 - Bob Reilly, bank details on file (066-000 / 12345678), address and emergency contact set (AC5)",
    "CON-030 - Priya Nair, no bank details, address and emergency contact set (AC6, AC7)",
    `The new contractor for AC8 is added by you at UAT (${ADDED_EMAIL}); clearing removes it`,
  ];
}

/** Top up: put Bob's and Priya's details back to the seed when they were changed. */
export async function topUp(client: PrismaClient): Promise<string[]> {
  await restoreCast(client);
  return ["CON-014 and CON-030 put back as seeded"];
}
