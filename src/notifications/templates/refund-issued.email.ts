// The Refund issued email -- Feature 6006, refunds.
// Notifications / Customer messages (Refund issued).
//
// To the CUSTOMER, once per refund, with the credit note attached as a PDF built at send time
// from the stored refund (the module's second attachment, after the invoice). No button. A card
// refund carries the "5 to 10 business days" line; any other method says it goes back to the
// account she paid from. Money is the caller's text, the signature is the brand's platformName.
import { buildCreditNotePdf } from "../../refunds/credit-note.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT_HEAD = `Hi {{firstName}},

We've refunded {{amountText}} against invoice {{invoiceReference}} ({{jobReference}}), which you paid {{paidText}} by {{methodText}}.

Why: {{reason}}

`;
const CARD_TEXT = `It goes back to your card. A card refund can take 5 to 10 business days to show on your statement.`;
const OTHER_TEXT = `It goes back to the account you paid from.`;
const TEXT_FOOT = `

The credit note is attached.

Questions? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML_HEAD = `<p>Hi {{firstName}},</p>
<p>We've refunded <strong>{{amountText}}</strong> against invoice {{invoiceReference}} ({{jobReference}}), which you paid {{paidText}} by {{methodText}}.</p>
<p style="white-space:pre-wrap">Why: {{reason}}</p>
<p>`;
const HTML_FOOT = `</p>
<p>The credit note is attached.</p>
<p>Questions? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const refundIssuedEmail: NotificationTemplate = {
  type: "refund_issued",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    const card = context["byCard"] === true;
    return {
      subject: `Refund issued - ${String(context["refundReference"] ?? "")}, against invoice ${String(context["invoiceReference"] ?? "")}`,
      text: fill(TEXT_HEAD + (card ? CARD_TEXT : OTHER_TEXT) + TEXT_FOOT, context),
      html: fillHtml(HTML_HEAD + (card ? CARD_TEXT : OTHER_TEXT) + HTML_FOOT, context),
    };
  },
  async attachment(context, db) {
    const refundId = context["refundId"];
    if (typeof refundId !== "string" || refundId === "") {
      throw new Error('template variable "refundId" is missing from the context');
    }
    const { fileName, content } = await buildCreditNotePdf(db, refundId);
    return { fileName, contentType: "application/pdf", content };
  },
};
