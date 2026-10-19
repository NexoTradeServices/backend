// The Updated invoice email -- Feature 6007, correct & reissue.
// Notifications / Customer messages (Updated invoice).
//
// To the CUSTOMER only, once the invoice a Correct & reissue made in place of an unpaid one has its
// pay link; the new invoice's PDF attached. The Invoice message with two lines changed, and never the
// word "corrected": no dollar figure, no reason. The replaced invoice is read from
// `Invoice.replacesInvoiceId`. The signature is the brand's platformName, never a literal.
import { buildInvoicePdf } from "../../invoices/pdf.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Attached is the updated {{documentWords}} for your {{trade}} job {{jobReference}}.

Invoice {{invoiceReference}} replaces {{replacesReference}}.

Due: {{dueText}}

Pay now: {{payUrl}}

Questions about this bill? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Attached is the updated {{documentWords}} for your {{trade}} job {{jobReference}}.</p>
<p>Invoice {{invoiceReference}} replaces {{replacesReference}}.</p>
<p>Due: {{dueText}}</p>
<p><a href="{{payUrl}}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Pay now</a></p>
<p>Questions about this bill? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const invoiceUpdatedEmail: NotificationTemplate = {
  type: "invoice_updated",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    const documentWords = context["gstApplied"] === true ? "tax invoice" : "invoice";
    const withWords = { ...context, documentWords };
    return {
      subject: `${context["gstApplied"] === true ? "Tax invoice" : "Invoice"} ${String(context["invoiceReference"] ?? "")} - ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, withWords),
      html: fillHtml(HTML, withWords),
    };
  },
  async attachment(context, db) {
    const invoiceId = context["invoiceId"];
    if (typeof invoiceId !== "string" || invoiceId === "") {
      throw new Error('template variable "invoiceId" is missing from the context');
    }
    const { fileName, content } = await buildInvoicePdf(db, invoiceId);
    return { fileName, contentType: "application/pdf", content };
  },
};
