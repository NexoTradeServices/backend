// Payment on a closed invoice -- Feature 6002, Stripe payment and receivables.
// Notifications / Transactional messages (Payment on a closed invoice, Ops).
//
// To the shared ops inbox when money arrives on an invoice that is no longer open
// (void). Nothing is booked against the invoice; the office decides with the
// customer whether it stands or is refunded.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `A payment of {{amountText}} by {{methodText}} arrived on {{invoiceReference}} ({{jobReference}}), which is {{invoiceState}}. Nothing has been booked against the invoice. Decide with the customer whether it stands or is refunded.

Open the job: {{jobUrl}}

-- {{platformName}}`;

const HTML = `<p>A payment of <strong>{{amountText}}</strong> by {{methodText}} arrived on {{invoiceReference}} ({{jobReference}}), which is {{invoiceState}}. Nothing has been booked against the invoice. Decide with the customer whether it stands or is refunded.</p>
<p><a href="{{jobUrl}}">Open {{jobReference}}</a></p>
<p>-- {{platformName}}</p>`;

export const paymentClosedInvoiceEmail: NotificationTemplate = {
  type: "payment_closed_invoice",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Payment on a closed invoice - ${String(context["invoiceReference"] ?? "")}, ${String(context["amountText"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
