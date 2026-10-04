// The messages an answer sets off -- Feature 4003, accept / decline.
//
// Asked AFTER the answer's transaction commits (plan decision 2, the 4002
// pattern), so a rolled-back answer sends nothing. Every key is derivable
// without reading the table first (decision 7): a double tap or a retry is
// the same ask and lands on the same row.
import type { PrismaClient } from "../db/client.js";
import { sendNotification } from "../notifications/index.js";
import type { NotificationChannel, NotificationContext } from "../notifications/index.js";
import { formatDollars } from "../enquiries/money.js";
import { isServiceLevelMultipliers, priceFor } from "../jobs/dispatch-level.js";
import { asSiteContact } from "../jobs/site-contact.js";
import { effectiveAddress } from "../jobs/shared.js";
import { formatSlotLabel } from "../time/index.js";
import type { AnswerFacts } from "./service.js";

function firstNameOf(name: string): string {
  return name.split(" ")[0] ?? name;
}

/**
 * Plan decision 5: the job's frozen rate card times the job's stamped service
 * level, through 4002's own price helper -- never the live catalog. Names the
 * RATES, never a total.
 */
function rateLine(base: { calloutRate: number; standardRate: number }, multipliers: unknown, level: "normal" | "weekend" | "emergency"): string {
  if (!isServiceLevelMultipliers(multipliers)) {
    throw new Error("the trade's service level multipliers are misconfigured");
  }
  const price = priceFor(base, multipliers, level);
  return `${formatDollars(price.calloutRate)} call-out including the first hour, then ${formatDollars(price.standardRate)} an hour`;
}

export async function sendSlotConfirmed(client: PrismaClient, facts: AnswerFacts): Promise<void> {
  const job = await client.job.findUniqueOrThrow({
    where: { id: facts.jobId },
    include: {
      serviceType: { select: { serviceLevelMultipliers: true } },
      customer: { select: { id: true, name: true, billingAddress: true } },
    },
  });
  const settings = await client.platformSettings.findFirst({ select: { operatorPhone: true } });
  const address = effectiveAddress(job);
  if (address === null) throw new Error(`job ${job.reference} has no address to confirm`);

  const siteContact = asSiteContact(job.siteContact);
  const common = {
    contractorFirstName: firstNameOf(facts.contractorName),
    jobReference: facts.jobReference,
    trade: facts.trade,
    street: address.street,
    suburb: address.suburb,
    slotLabel: formatSlotLabel(facts.jobTimezone, facts.proposedSlot, new Date()),
    officePhone: settings?.operatorPhone ?? "",
  } satisfies NotificationContext;

  const customerContext: NotificationContext = {
    ...common,
    audience: "customer",
    firstName: firstNameOf(job.customer.name),
    priceLine: rateLine(
      { calloutRate: job.customerCalloutRate, standardRate: job.customerStandardRate },
      job.serviceType.serviceLevelMultipliers,
      job.serviceLevel ?? "normal",
    ),
    // The customer's wording says the site contact has been told, and never who.
    ...(siteContact === null ? {} : { siteContactTold: true }),
  };

  const ask = async (
    channel: NotificationChannel,
    audience: "customer" | "site_contact",
    context: NotificationContext,
  ): Promise<void> => {
    await sendNotification(
      {
        type: "slot_confirmed",
        channel,
        recipientType: audience,
        recipientId: audience === "customer" ? job.customer.id : job.id,
        idempotencyKey: `slot_confirmed:assignment:${facts.assignmentId}:${audience}:${channel}`,
        relatedType: "assignment",
        relatedId: facts.assignmentId,
        jobId: job.id,
        context,
      },
      client,
    );
  };

  for (const channel of ["email", "sms"] as const) {
    await ask(channel, "customer", customerContext);
  }

  if (siteContact !== null) {
    // Plan decision 6: in her own wording, no money, no link; the text always,
    // the email only when she gave one. Her name is the name AT THE TIME OF ASKING.
    const siteContext: NotificationContext = {
      ...common,
      audience: "site_contact",
      firstName: firstNameOf(siteContact.name),
      recipientName: siteContact.name,
    };
    await ask("sms", "site_contact", siteContext);
    if (siteContact.email !== null && siteContact.email.trim() !== "") {
      await ask("email", "site_contact", siteContext);
    }
  }
}

export async function sendDeclinedNotice(client: PrismaClient, facts: AnswerFacts): Promise<void> {
  // Fails that one row, never the answer, were the origin ever missing (the
  // process refuses to boot without it -- index.ts).
  const webOrigin = process.env["WEB_ORIGIN"];
  await sendNotification(
    {
      type: "contractor_declined",
      channel: "email",
      recipientType: "ops",
      recipientId: facts.jobId,
      idempotencyKey: `contractor_declined:assignment:${facts.assignmentId}`,
      relatedType: "assignment",
      relatedId: facts.assignmentId,
      jobId: facts.jobId,
      context: {
        contractorName: facts.contractorName,
        contractorCode: facts.contractorCode,
        jobReference: facts.jobReference,
        slotLabel: facts.slotLabel,
        ...(facts.note === null ? {} : { note: facts.note }),
        ...(webOrigin ? { jobUrl: `${webOrigin}/ops/jobs/${facts.jobReference}` } : {}),
      },
    },
    client,
  );
}
