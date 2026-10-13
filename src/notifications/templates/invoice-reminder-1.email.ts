// The first invoice reminder -- Feature 6008, invoice reminders and void.
// Notifications / Customer messages (the two invoice reminders).
//
// "Due today", sent by the daily sweep on the invoice's due date. Goes to the CUSTOMER only,
// email only. Money-free by rule: no amount, no due figure. The Pay now button is the
// invoice's own pay link; the signature is the brand's platformName.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Your invoice {{invoiceReference}} for your {{trade}} job {{jobReference}} is due today.

Pay now: {{payUrl}}

If you've just paid, please ignore this.

Trouble paying or a question about the bill? Call us on {{officePhone}}.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Your invoice {{invoiceReference}} for your {{trade}} job {{jobReference}} is due today.</p>
<p><a href="{{payUrl}}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Pay now</a></p>
<p>If you've just paid, please ignore this.</p>
<p>Trouble paying or a question about the bill? Call us on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const invoiceReminder1Email: NotificationTemplate = {
  type: "invoice_reminder_1",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Invoice due today - ${String(context["invoiceReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
