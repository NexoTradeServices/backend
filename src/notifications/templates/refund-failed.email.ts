// Refund failed -- Feature 6006, refunds.
// Notifications / Transactional messages (Refund failed, Ops).
//
// To the shared ops inbox when Stripe reports a refund the platform made did not go through.
// The amount is back in what is left to refund; the office rings the customer and makes a new one.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `The refund {{refundReference}} on invoice {{invoiceReference}} ({{jobReference}}), {{amountText}}, did not go through at Stripe. Ring {{customerName}} and make a new refund once it is sorted.

Open the job: {{jobUrl}}

-- {{platformName}}`;

const HTML = `<p>The refund {{refundReference}} on invoice {{invoiceReference}} ({{jobReference}}), <strong>{{amountText}}</strong>, did not go through at Stripe. Ring {{customerName}} and make a new refund once it is sorted.</p>
<p><a href="{{jobUrl}}">Open {{jobReference}}</a></p>
<p>-- {{platformName}}</p>`;

export const refundFailedEmail: NotificationTemplate = {
  type: "refund_failed",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Refund failed - ${String(context["refundReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
