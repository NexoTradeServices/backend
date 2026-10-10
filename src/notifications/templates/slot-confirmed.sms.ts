// The slot-confirmed SMS -- Feature 4003, accept / decline.
// Same facts and the same two wordings as the email (see slot-confirmed.email.ts);
// SMS is for the time-sensitive confirmation itself (Cadence discipline). Reworded at 4006's UAT:
// starts with what it is, states no price.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CUSTOMER_TEXT = `Job booked, {{firstName}}: {{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} ({{jobReference}}, {{trade}}).`;
const CUSTOMER_TOLD_TEXT = ` The site contact has been informed.`;
const CUSTOMER_FOOT_TEXT = ` To change, ring {{officePhone}}. -- {{platformName}}`;

const SITE_TEXT = `Job booked, {{firstName}}: {{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} ({{trade}}, {{jobReference}}). If that time no longer suits, ring {{officePhone}}. -- {{platformName}}`;

export const slotConfirmedSms: NotificationTemplate = {
  type: "slot_confirmed",
  channel: "sms",
  category: "transactional",
  render(context) {
    if (context["audience"] === "site_contact") {
      return { text: fill(SITE_TEXT, context) };
    }
    const told = context["siteContactTold"] === true;
    return { text: fill(CUSTOMER_TEXT + (told ? CUSTOMER_TOLD_TEXT : "") + CUSTOMER_FOOT_TEXT, context) };
  },
};
