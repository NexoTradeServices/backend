// The Missed visit text -- Feature 6004, callbacks and no-shows. Same two outcomes as the email
// (missed-visit.email.ts); no dollar figure.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CHARGED_TEXT = `{{platformName}}: we called on {{dateText}} for {{jobReference}} but could not get in. Call-out invoice {{invoiceReference}}, due {{dueText}}. Pay now: {{payUrl}}`;
const WAIVED_TEXT = `{{platformName}}: we called on {{dateText}} for {{jobReference}} but could not get in. We've waived the call-out fee.`;

export const missedVisitSms: NotificationTemplate = {
  type: "missed_visit",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(context["waived"] === true ? WAIVED_TEXT : CHARGED_TEXT, context) };
  },
};
