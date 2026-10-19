// The Updated invoice text -- Feature 6007, correct & reissue. Same facts as the email (see
// invoice-updated.email.ts) bar the money: the new reference, the job, the one it replaces, the
// due date and the pay link. No dollar figure and never the word "corrected".
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `{{platformName}}: updated invoice {{invoiceReference}} for {{jobReference}}, replaces {{replacesReference}}, due {{dueText}}. Pay now: {{payUrl}}`;

export const invoiceUpdatedSms: NotificationTemplate = {
  type: "invoice_updated",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
