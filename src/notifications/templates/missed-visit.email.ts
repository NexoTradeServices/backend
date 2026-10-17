// The Missed visit email -- Feature 6004, callbacks and no-shows.
// Notifications / Customer messages; Ops job actions / Mark no-show.
//
// Goes to the CUSTOMER only, once, when Mike marks a job a no-show. Two outcomes, one template:
// charged (the call-out invoice is attached and the pay link is in the body) or waived ("As a
// courtesy, we've waived the call-out fee."). No dollar figure; the PDF carries the amount.
import { buildInvoicePdf } from "../../invoices/pdf.js";
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const INTRO = `We called on {{dateText}} for your {{trade}} job {{jobReference}}, but could not get in to do the work.`;

const CHARGED_TEXT = `Hi {{firstName}},

${INTRO}

A call-out invoice {{invoiceReference}} is attached.

Due: {{dueText}}

Pay now: {{payUrl}}

Questions about this bill? Call us on {{officePhone}}.

-- {{platformName}}`;

const CHARGED_HTML = `<p>Hi {{firstName}},</p>
<p>${INTRO}</p>
<p>A call-out invoice {{invoiceReference}} is attached.</p>
<p>Due: {{dueText}}</p>
<p><a href="{{payUrl}}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Pay now</a></p>
<p>Questions about this bill? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const WAIVED_TEXT = `Hi {{firstName}},

${INTRO}

As a courtesy, we've waived the call-out fee.

To book again, call us on {{officePhone}}.

-- {{platformName}}`;

const WAIVED_HTML = `<p>Hi {{firstName}},</p>
<p>${INTRO}</p>
<p>As a courtesy, we've waived the call-out fee.</p>
<p>To book again, call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const missedVisitEmail: NotificationTemplate = {
  type: "missed_visit",
  channel: "email",
  category: "transactional",
  render(context: NotificationContext) {
    const waived = context["waived"] === true;
    return {
      subject: `Missed visit - ${String(context["jobReference"] ?? "")}`,
      text: fill(waived ? WAIVED_TEXT : CHARGED_TEXT, context),
      html: fillHtml(waived ? WAIVED_HTML : CHARGED_HTML, context),
    };
  },
  async attachment(context, db) {
    // A waived no-show has no invoice, so nothing to attach.
    if (context["waived"] === true) return null;
    const invoiceId = context["invoiceId"];
    if (typeof invoiceId !== "string" || invoiceId === "") {
      throw new Error('template variable "invoiceId" is missing from the context');
    }
    const { fileName, content } = await buildInvoicePdf(db, invoiceId);
    return { fileName, contentType: "application/pdf", content };
  },
};
