// A hard bounce becomes a listing and one alert -- Feature 7001, bounced emails.
// Notifications / Suppression scope - split by reason (A hard bounce becomes a listing and one alert).
//
// Called by the delivery webhook when the email provider reports a hard bounce for a message we hold.
// The address in the provider's report is listed `bounced` on email (which blocks everything sent to
// it from then on, see suppression.ts), and the business inbox is told ONCE per address -- only when
// the listing is new. A soft bounce, a block, a spam report and every text failure never come here.
import type { PrismaClient } from "../db/client.js";
import { asSiteContact } from "../jobs/site-contact.js";
import { messageName } from "../jobs/messages.js";
import { sendNotification } from "./send.js";

/** The row a bounce is about: just what is needed to say who and what. */
export interface BouncedRow {
  recipientType: "customer" | "contractor" | "ops" | "user" | "site_contact";
  recipientId: string;
  type: string;
  jobId: string | null;
}

/** The notice names Sarah's booking email "Job booked", the way she knows it (the job page's Messages card keeps its own name). */
const NOTICE_NAMES: Record<string, string> = { slot_confirmed: "Job booked" };

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

interface Who {
  kind: "customer" | "site_contact" | "contractor" | "user";
  personName: string;
  buttonTo: { label: string; path: string } | null;
}

async function whoIs(client: PrismaClient, row: BouncedRow, jobReference: string | null): Promise<Who | null> {
  const jobButton = jobReference === null ? null : { label: `Open ${jobReference}`, path: `/ops/jobs/${jobReference}` };

  if (row.recipientType === "customer") {
    const customer = await client.customer.findUnique({ where: { id: row.recipientId }, select: { name: true } });
    return customer === null ? null : { kind: "customer", personName: customer.name, buttonTo: jobButton };
  }
  if (row.recipientType === "site_contact") {
    const job = await client.job.findUnique({ where: { id: row.recipientId }, select: { siteContact: true } });
    const contact = job === null ? null : asSiteContact(job.siteContact);
    return contact === null ? null : { kind: "site_contact", personName: contact.name, buttonTo: jobButton };
  }
  if (row.recipientType === "contractor") {
    const contractor = await client.contractor.findUnique({ where: { id: row.recipientId }, select: { name: true, code: true } });
    if (contractor === null) return null;
    return {
      kind: "contractor",
      personName: contractor.name,
      buttonTo: { label: `Open ${firstNameOf(contractor.name)}'s record`, path: `/ops/contractors/${contractor.code}` },
    };
  }
  if (row.recipientType === "user") {
    const user = await client.user.findUnique({ where: { id: row.recipientId }, select: { name: true } });
    return user === null ? null : { kind: "user", personName: user.name, buttonTo: null };
  }
  return null;
}

/**
 * List the address as bounced; the first time only, ask for the office's notice.
 * Returns whether the listing was new.
 */
export async function listHardBounce(client: PrismaClient, row: BouncedRow, rawAddress: string): Promise<boolean> {
  const address = rawAddress.trim().toLowerCase();
  if (address === "") return false;

  const existing = await client.suppression.findUnique({
    where: { channel_address: { channel: "email", address } },
    select: { id: true },
  });
  if (existing !== null) return false;
  try {
    await client.suppression.create({ data: { channel: "email", address, reason: "bounced" } });
  } catch (error) {
    // Two reports for one address landing together: the other one listed it first.
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }

  const job = row.jobId === null ? null : await client.job.findUnique({ where: { id: row.jobId }, select: { reference: true } });
  const jobReference = job?.reference ?? null;
  const who = await whoIs(client, row, jobReference);
  const personName = who?.personName ?? address;
  const webOrigin = process.env["WEB_ORIGIN"];

  await sendNotification(
    {
      type: "email_bouncing",
      channel: "email",
      recipientType: "ops",
      recipientId: address,
      idempotencyKey: `email_bouncing:address:${address}:email`,
      ...(row.jobId === null ? {} : { jobId: row.jobId }),
      context: {
        kind: who?.kind ?? "unknown",
        personName,
        firstName: firstNameOf(personName),
        address,
        messageName: NOTICE_NAMES[row.type] ?? messageName(row.type),
        ...(jobReference === null ? {} : { jobReference }),
        ...(who?.buttonTo && webOrigin ? { buttonLabel: who.buttonTo.label, buttonUrl: `${webOrigin}${who.buttonTo.path}` } : {}),
      },
    },
    client,
  );
  return true;
}
