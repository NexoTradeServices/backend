// The invoice SMS -- Feature 6001, invoice at completion; Feature 6015 takes the money out.
// Same facts as the email (see invoice.email.ts) bar the money: the reference, the job, the
// due date and the pay link. No dollar figure.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `{{platformName}}: invoice {{invoiceReference}} for {{jobReference}}, due {{dueText}}. Pay now: {{payUrl}}`;

export const invoiceSms: NotificationTemplate = {
  type: "invoice",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
