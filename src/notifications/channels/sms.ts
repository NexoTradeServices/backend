// The SMS channel -- Feature 1004, notification module.
//
// The design's cadence discipline keeps SMS for time-sensitive events only
// (dispatch, slot confirmation); that is a decision each sending feature makes
// by choosing this channel, not something this component polices.
import type { AddressLookup, ChannelComponent } from "../types.js";

/** One GSM-7 segment is 160 characters; a longer body is split and billed twice. */
const SINGLE_SEGMENT = 160;

export const smsChannel: ChannelComponent = {
  channel: "sms",

  async addressFor(context, recipientType, recipientId): Promise<AddressLookup> {
    if (recipientType === "customer") {
      const customer = await context.client.customer.findUnique({
        where: { id: recipientId },
        select: { phone: true },
      });
      if (customer === null) return { reason: `no customer ${recipientId}` };
      if (!customer.phone) return { reason: `customer ${recipientId} has no phone number` };
      return { address: customer.phone };
    }

    if (recipientType === "contractor") {
      const contractor = await context.client.contractor.findUnique({
        where: { id: recipientId },
        select: { phone: true },
      });
      if (contractor === null) return { reason: `no contractor ${recipientId}` };
      return { address: contractor.phone };
    }

    // A User carries no phone (Feature 1011, decision 2): a visible failure
    // per guiding principle 8, never a crash, never silence.
    if (recipientType === "user") {
      return { reason: `user ${recipientId} has no phone -- a User carries no phone number` };
    }

    // Ops has one number, and the design names it: PlatformSettings.operatorPhone
    // is THE single contact number.
    return { address: context.settings.operatorPhone };
  },

  check(message) {
    if (!message.text) return "the sms template rendered no body";
    // Not a refusal -- a long message still sends, it just costs two segments.
    // Worth saying out loud so a template that quietly grew is visible.
    if (message.text.length > SINGLE_SEGMENT) {
      console.warn(`sms body is ${String(message.text.length)} characters -- over one ${String(SINGLE_SEGMENT)}-character segment`);
    }
    return null;
  },
};
