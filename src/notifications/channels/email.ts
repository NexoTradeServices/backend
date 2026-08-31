// The email channel -- Feature 1004, notification module.
//
// A channel component owns two channel-shaped facts: where a message on this
// channel goes for a given recipient, and what this channel will not carry. A
// new channel (push, WhatsApp, in-app) is a new file beside this one -- never
// logic somewhere else in the app.
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

    // Ops SMS has a home in the design -- PlatformSettings.operatorPhone, THE
    // single contact number. Ops EMAIL has none: no field on PlatformSettings
    // names the inbox that ops messages go to, and inventing one is a design
    // decision this feature may not take. Parked as Q1 in the feature's
    // change.md; the features that send to ops (3001, 4001, 7001) need it
    // answered before they can.
    return { reason: "no ops email address is configured -- see open question Q1 on feature 1004" };
  },

  check(message) {
    if (!message.subject) return "the email template rendered no subject";
    if (!message.text) return "the email template rendered no body";
    return null;
  },
};
