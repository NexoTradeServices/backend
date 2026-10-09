// The office's payment notice -- Feature 6002, Stripe payment and receivables.
// Notifications / Transactional messages (Payment received, Ops).
//
// To the shared ops inbox when an invoice turns paid, with a link to the job page
// built by the sender from the environment's web origin -- never a hostname here.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `{{customerName}} paid {{invoiceReference}} for {{jobReference}}: {{amountText}} by {{methodText}}, {{paidDate}} at {{paidTime}}.

Open the job: {{jobUrl}}

-- {{platformName}}`;

const HTML = `<p>{{customerName}} paid {{invoiceReference}} for {{jobReference}}: <strong>{{amountText}}</strong> by {{methodText}}, {{paidDate}} at {{paidTime}}.</p>
<p><a href="{{jobUrl}}">Open {{jobReference}}</a></p>
<p>-- {{platformName}}</p>`;

export const paymentReceivedEmail: NotificationTemplate = {
  type: "payment_received",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Payment received - ${String(context["invoiceReference"] ?? "")}, ${String(context["amountText"] ?? "")} (${String(context["jobReference"] ?? "")})`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
