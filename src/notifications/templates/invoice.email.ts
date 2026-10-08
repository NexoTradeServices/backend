// The invoice email -- Feature 6001, invoice at completion.
// Notifications / Customer messages (the invoice); Payments (Stripe) / Core.
//
// Goes to the CUSTOMER only, once the invoice has its Stripe pay link, with the
// tax invoice attached as a PDF built at send time (the module's first
// attachment -- see `attachment` below). The greeting is always the person's
// own first name, also for a business customer. Money is the caller's text
// (`formatDollars`), dates are in the job's zone, and the signature is the
// brand's platformName, never a literal.
import { buildInvoicePdf } from "../../invoices/pdf.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

{{contractorFirstName}} has finished your {{trade}} job, {{jobReference}}. What was done:

{{workNotes}}

Total: {{totalText}}`;

const GST_TEXT = ` (includes GST of {{gstText}})`;

const FOOT_TEXT = `
Due: {{dueText}}

Pay now: {{payUrl}}

Your invoice {{invoiceReference}} is attached as a PDF.

Questions about this bill? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>{{contractorFirstName}} has finished your {{trade}} job, {{jobReference}}. What was done:</p>
<p style="white-space:pre-wrap">{{workNotes}}</p>
<p>Total: <strong>{{totalText}}</strong>`;

const GST_HTML = ` (includes GST of {{gstText}})`;

const FOOT_HTML = `</p>
<p>Due: {{dueText}}</p>
<p><a href="{{payUrl}}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Pay now</a></p>
<p>Your invoice {{invoiceReference}} is attached as a PDF.</p>
<p>Questions about this bill? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const invoiceEmail: NotificationTemplate = {
  type: "invoice",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    const gst = context["gstApplied"] === true;
    return {
      subject: `Invoice ${String(context["invoiceReference"] ?? "")} for your ${String(context["trade"] ?? "")} job - ${String(context["totalText"] ?? "")} due ${String(context["dueText"] ?? "")}`,
      text: fill(TEXT + (gst ? GST_TEXT : "") + FOOT_TEXT, context),
      html: fillHtml(HTML + (gst ? GST_HTML : "") + FOOT_HTML, context),
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
