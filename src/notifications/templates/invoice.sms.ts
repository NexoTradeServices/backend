// The invoice SMS -- Feature 6001, invoice at completion.
// Same facts as the email (see invoice.email.ts): total, due date, the pay link.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `{{platformName}}: invoice {{invoiceReference}} for {{jobReference}} - {{totalText}}, due {{dueText}}. Pay now: {{payUrl}}`;

export const invoiceSms: NotificationTemplate = {
  type: "invoice",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
