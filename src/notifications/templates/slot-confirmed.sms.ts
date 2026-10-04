// The slot-confirmed SMS -- Feature 4003, accept / decline.
// Same facts and the same two wordings as the email (see slot-confirmed.email.ts);
// SMS is for the time-sensitive confirmation itself (Cadence discipline).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CUSTOMER_TEXT = `Booked: {{contractorFirstName}}, {{slotLabel}} at {{street}}, {{suburb}} ({{jobReference}}, {{trade}}).`;
const CUSTOMER_TOLD_TEXT = ` The site contact has been told.`;
const CUSTOMER_FOOT_TEXT = ` Price: {{priceLine}}, billed on actual time. Changes: {{officePhone}} -- {{platformName}}`;

const SITE_TEXT = `{{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} ({{trade}}, {{jobReference}}). Can't make it? {{officePhone}} -- {{platformName}}`;

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
