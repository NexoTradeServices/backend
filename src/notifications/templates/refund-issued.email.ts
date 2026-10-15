// The Refund issued email -- Feature 6006, refunds; Feature 6015 takes the money and the reason out.
// Notifications / Customer messages (Refund issued).
//
// To the CUSTOMER, once per refund, with the refund receipt attached as a PDF built at send time
// from the stored refund (the module's second attachment, after the invoice). No button. No
// dollar figure, no reason and no card-days line: the receipt carries them. "Adjustment note"
// only on B2 (a business, on a tax invoice). The signature is the brand's platformName.
import { buildCreditNotePdf } from "../../refunds/credit-note.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

{{refundWords}} your invoice {{invoiceReference}} for your {{trade}} job {{jobReference}}.

Your {{receiptWords}} {{refundReference}} is attached.

Questions about this refund? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>{{refundWords}} your invoice {{invoiceReference}} for your {{trade}} job {{jobReference}}.</p>
<p>Your {{receiptWords}} {{refundReference}} is attached.</p>
<p>Questions about this refund? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const refundIssuedEmail: NotificationTemplate = {
  type: "refund_issued",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    const words = {
      ...context,
      refundWords: context["refundIsFull"] === true ? "We have refunded" : "We have refunded part of",
      receiptWords: context["adjustmentNote"] === true ? "adjustment note" : "refund receipt",
    };
    return {
      subject: `Refund ${String(context["refundReference"] ?? "")} - ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, words),
      html: fillHtml(HTML, words),
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
