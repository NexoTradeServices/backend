// The payout-sent email -- Feature 6003, settlement run.
// Notifications / Transactional messages (Payout sent); Contractor messages (payout sent).
//
// Goes to the CONTRACTOR when Mike marks his invoice paid. It says the money has been sent to
// the account ending in the last four digits and how long it may take -- never an amount, a job
// count, the bank reference or a date: the breakdown lives behind its one button, "See the
// breakdown", a plain link to his settlement page (he logs in there).
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

We've paid your invoice {{reference}} ({{period}}) into your account ending {{accountLast4}}. It can take up to a business day to show. If it hasn't arrived by then, ring the office on {{officePhone}}.

See the breakdown: {{settlementUrl}}

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>We've paid your invoice <strong>{{reference}}</strong> ({{period}}) into your account ending {{accountLast4}}. It can take up to a business day to show. If it hasn't arrived by then, ring the office on {{officePhone}}.</p>
<p><a href="{{settlementUrl}}" style="display:inline-block;padding:10px 18px;background:#e8762d;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700">See the breakdown</a></p>
<p>-- {{platformName}}</p>`;

export const payoutSentEmail: NotificationTemplate = {
  type: "payout_sent",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `You've been paid - ${String(context["reference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
