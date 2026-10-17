// The Callback - no charge email -- Feature 6004, callbacks and no-shows.
// Notifications / Customer messages; Callbacks (goodwill).
//
// Goes to the CUSTOMER only, once, when the contractor completes a callback as "fixing earlier
// work": the $0 invoice is attached as a PDF (the invoice email's attachment) and there is no pay
// link and no text. No dollar figure and no word "contractor" -- the PDF carries the record.
import { buildInvoicePdf } from "../../invoices/pdf.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Your {{trade}} callback {{jobReference}} is finished, at no charge.

The invoice {{invoiceReference}} is attached for your files.

Questions? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Your {{trade}} callback {{jobReference}} is finished, at no charge.</p>
<p>The invoice {{invoiceReference}} is attached for your files.</p>
<p>Questions? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const callbackNoChargeEmail: NotificationTemplate = {
  type: "callback_no_charge",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    return {
      subject: `Callback ${String(context["jobReference"] ?? "")} - no charge`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
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
