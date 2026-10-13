// The second invoice reminder -- Feature 6008, invoice reminders and void.
// Notifications / Customer messages (the two invoice reminders).
//
// "Overdue", sent by the daily sweep seven days after the first. After this one collection
// is the operator's. Customer only, email only, money-free (the days overdue are counted on
// the business calendar by the asker and arrive as `daysOverdueText`).
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Your invoice {{invoiceReference}} for {{jobReference}} is now {{daysOverdueText}} overdue. Please pay now, or call us on {{officePhone}}.

Pay now: {{payUrl}}

We'll be in touch.

If you've just paid, please ignore this.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Your invoice {{invoiceReference}} for {{jobReference}} is now {{daysOverdueText}} overdue. Please pay now, or call us on {{officePhone}}.</p>
<p><a href="{{payUrl}}" style="display:inline-block;padding:10px 18px;background:#0b5fff;color:#ffffff;text-decoration:none;border-radius:6px">Pay now</a></p>
<p>We'll be in touch.</p>
<p>If you've just paid, please ignore this.</p>
<p>-- {{platformName}}</p>`;

export const invoiceReminder2Email: NotificationTemplate = {
  type: "invoice_reminder_2",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Invoice overdue - ${String(context["invoiceReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
