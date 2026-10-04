// The email channel -- Feature 1004, notification module.
//
// A channel component owns two channel-shaped facts: where a message on this
// channel goes for a given recipient, and what this channel will not carry. A
// new channel (push, WhatsApp, in-app) is a new file beside this one -- never
// logic somewhere else in the app.
import { asSiteContact } from "../../jobs/site-contact.js";
import type { AddressLookup, ChannelComponent } from "../types.js";

export const emailChannel: ChannelComponent = {
  channel: "email",

  async addressFor(context, recipientType, recipientId): Promise<AddressLookup> {
    if (recipientType === "customer") {
      const customer = await context.client.customer.findUnique({
        where: { id: recipientId },
        select: { email: true },
      });
      if (customer === null) return { reason: `no customer ${recipientId}` };
      return { address: customer.email };
    }

    if (recipientType === "contractor") {
      const contractor = await context.client.contractor.findUnique({
        where: { id: recipientId },
        select: { email: true },
      });
      if (contractor === null) return { reason: `no contractor ${recipientId}` };
      return { address: contractor.email };
    }

    // Account mail vs business mail (Feature 1011): the account holder's own
    // login email, whatever their role -- password reset today, anything
    // account-shaped later. Never the shared operatorEmail inbox.
    if (recipientType === "user") {
      const user = await context.client.user.findUnique({
        where: { id: recipientId },
        select: { email: true },
      });
      if (user === null) return { reason: `no user ${recipientId}` };
      return { address: user.email };
    }

    // Feature 4003, plan decision 6: a site contact is reached through the
    // JOB (recipientId = the job's id), at send time -- Mike can fix her
    // details until the job closes, so the address is never copied onto the
    // row. No email on file is a reason, never a guess; the asker does not
    // ask the email channel at all in that case.
    if (recipientType === "site_contact") {
      const job = await context.client.job.findUnique({
        where: { id: recipientId },
        select: { siteContact: true },
      });
      if (job === null) return { reason: `no job ${recipientId}` };
      const contact = asSiteContact(job.siteContact);
      if (contact === null) return { reason: `job ${recipientId} has no site contact` };
      if (contact.email === null || contact.email.trim() === "") {
        return { reason: `the site contact on job ${recipientId} gave no email address` };
      }
      return { address: contact.email };
    }

    // Feature 3001, AC6, BKLG-004: the four Ops rows all land in ONE shared
    // inbox, PlatformSettings.operatorEmail -- never a person's, never
    // derived from who holds the ops role (Notifications). recipientId is
    // ignored here on purpose: there is no per-row ops entity to look up,
    // only the one business address.
    const operatorEmail = context.settings.operatorEmail.trim();
    if (operatorEmail === "") {
      return { reason: "PlatformSettings.operatorEmail is not set -- the owner sets it on /ops/settings" };
    }
    return { address: operatorEmail };
  },

  check(message) {
    if (!message.subject) return "the email template rendered no subject";
    if (!message.text) return "the email template rendered no body";
    return null;
  },
};
