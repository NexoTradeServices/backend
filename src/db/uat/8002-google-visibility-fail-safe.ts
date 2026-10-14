// UAT data for feature 8002, the Google-visibility fail-safe.
//
// The only record is the owner's settings row, put to its start state: approvedPublicDomain blank
// (AC1, AC2, AC4). Nothing is created, so nothing carries the uat-8002 label; the cast record the
// check changes is the settings row itself, and restoreCast puts it back to blank on clear.
//
// Sends nothing: no email, no text, no upload.
import type { PrismaClient } from "../client.js";
import { invalidateIdentityCache } from "../../settings/identity-cache.js";

async function blankTheDomain(client: PrismaClient): Promise<void> {
  await client.platformSettings.updateMany({ data: { approvedPublicDomain: null } });
  invalidateIdentityCache();
}

export async function make(client: PrismaClient): Promise<string[]> {
  await blankTheDomain(client);
  return ["Settings -- the owner's Public web address is blank (start state for AC1, AC2, AC4)"];
}

/** Top up: the start state is the only record, and the owner may be partway through -- leave it. */
export function topUp(): Promise<string[]> {
  return Promise.resolve([]);
}

export async function restoreCast(client: PrismaClient): Promise<void> {
  await blankTheDomain(client);
}
