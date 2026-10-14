// Refund made in Stripe -- Feature 6006, refunds.
// Notifications / Transactional messages (Refund made in Stripe, Ops).
//
// To the shared ops inbox when Stripe reports a refund on a payment we hold that the platform did
// not make (someone used the Stripe dashboard). Nothing is booked: no credit note, no customer email.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `A refund of {{amountText}} on invoice {{invoiceReference}} ({{jobReference}}) was made in the Stripe dashboard, not the platform. It has no credit note and the customer was not emailed. Square it by hand.

Open the job: {{jobUrl}}

-- {{platformName}}`;

const HTML = `<p>A refund of <strong>{{amountText}}</strong> on invoice {{invoiceReference}} ({{jobReference}}) was made in the Stripe dashboard, not the platform. It has no credit note and the customer was not emailed. Square it by hand.</p>
<p><a href="{{jobUrl}}">Open {{jobReference}}</a></p>
<p>-- {{platformName}}</p>`;

export const refundMadeInStripeEmail: NotificationTemplate = {
  type: "refund_made_in_stripe",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Refund made in Stripe - ${String(context["invoiceReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
