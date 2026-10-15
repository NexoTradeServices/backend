// The invoice email -- Feature 6001, invoice at completion.
// Notifications / Customer messages (the invoice); Payments (Stripe) / Core.
//
// Goes to the CUSTOMER only, once the invoice has its Stripe pay link, with the
// tax invoice attached as a PDF built at send time (the module's first
// attachment -- see `attachment` below). The greeting is always the person's
// own first name, also for a business customer. No dollar figure and no work
// notes (Feature 6015): the PDF carries them. Dates are in the job's zone, and the
// signature is the brand's platformName, never a literal.
import { buildInvoicePdf } from "../../invoices/pdf.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Your {{trade}} job {{jobReference}} is finished.

Your {{documentWords}} {{invoiceReference}} is attached.

Due: {{dueText}}

Pay now: {{payUrl}}

Questions about this bill? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Your {{trade}} job {{jobReference}} is finished.</p>
<p>Your {{documentWords}} {{invoiceReference}} is attached.</p>
<p>Due: {{dueText}}</p>
<p><a href="{{payUrl}}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Pay now</a></p>
<p>Questions about this bill? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const invoiceEmail: NotificationTemplate = {
  type: "invoice",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    // "Tax invoice" when the invoice carried GST, else "Invoice" (Invoicing / Invoice layouts).
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
