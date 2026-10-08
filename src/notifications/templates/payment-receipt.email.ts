// The payment receipt -- Feature 6002, Stripe payment and receivables.
// Notifications / Customer messages (Payment receipt).
//
// To the CUSTOMER, once, when her invoice turns paid. No attachment, no button.
// Money is the caller's text (`formatDollars`), the date and time are in the job's
// zone, and the signature is the brand's platformName, never a literal.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Thank you - we've received your payment of {{amountText}} for invoice {{invoiceReference}} ({{jobReference}}), paid by {{methodText}} on {{paidDate}} at {{paidTime}}.

Nothing further is owed.

Questions? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Thank you - we've received your payment of <strong>{{amountText}}</strong> for invoice {{invoiceReference}} ({{jobReference}}), paid by {{methodText}} on {{paidDate}} at {{paidTime}}.</p>
<p>Nothing further is owed.</p>
<p>Questions? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const paymentReceiptEmail: NotificationTemplate = {
  type: "payment_receipt",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Payment received - ${String(context["invoiceReference"] ?? "")}, ${String(context["amountText"] ?? "")} - thank you`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
