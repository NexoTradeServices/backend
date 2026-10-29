// The slot-confirmed SMS -- Feature 4003, accept / decline.
// Same facts and the same two wordings as the email (see slot-confirmed.email.ts);
// SMS is for the time-sensitive confirmation itself (Cadence discipline). Reworded at 4006's UAT:
// starts with what it is, states no price. Feature 7004: says a reminder is coming when one will.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CUSTOMER_TEXT = `Job booked, {{firstName}}: {{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} ({{jobReference}}, {{trade}}).`;
const CUSTOMER_TOLD_TEXT = ` The site contact has been informed.`;
const CUSTOMER_FOOT_TEXT = ` To change, ring {{officePhone}}. -- {{platformName}}`;

const SITE_TEXT = `Job booked, {{firstName}}: {{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} ({{trade}}, {{jobReference}}). If that time no longer suits, ring {{officePhone}}. -- {{platformName}}`;

const REMINDER_LINE = ` We'll send you a reminder the day before.`;

export const slotConfirmedSms: NotificationTemplate = {
  type: "slot_confirmed",
  channel: "sms",
  category: "transactional",
  render(context) {
    if (context["audience"] === "site_contact") {
      const site = context["reminderComing"] === true ? SITE_TEXT.replace("{{jobReference}}).", `{{jobReference}}).${REMINDER_LINE}`) : SITE_TEXT;
      return { text: fill(site, context) };
    }
    const told = context["siteContactTold"] === true;
    const customer = context["reminderComing"] === true ? CUSTOMER_TEXT + REMINDER_LINE : CUSTOMER_TEXT;
    return { text: fill(customer + (told ? CUSTOMER_TOLD_TEXT : "") + CUSTOMER_FOOT_TEXT, context) };
  },
};
