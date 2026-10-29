// The licence expiring email -- Feature 7002, licence and insurance expiry alerts.
// Notifications / Contractor messages (Licence / insurance expiring); Managing the contractor record / Expiry alerts.
//
// ONE template, two wordings by the context's `audience`: the contractor is told which licence and
// from when it stops jobs coming (with the office inbox as the reply address, so a photo of the
// renewal lands there); the office inbox gets the same facts and a button to the contractor's record.
// Email only, transactional, no money. `daysText` is "30 days" or "1 day"; `expiryLabel` the plain date
// with its weekday. The sender (contractors/expiry-alerts.ts) hands over plain facts; this file words them.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CONTRACTOR_TEXT = `Hi {{firstName}},

Your {{trade}} licence {{licenceNumber}} expires on {{expiryLabel}} - {{daysText}} from today.

From that date we can't send you new {{trade}} jobs until your renewed licence is on file. Jobs already booked go ahead.

Reply to this email with a photo of the renewal, or ring the office on {{officePhone}}.

-- {{platformName}}`;

const CONTRACTOR_HTML = `<p>Hi {{firstName}},</p>
<p>Your {{trade}} licence <strong>{{licenceNumber}}</strong> expires on {{expiryLabel}} - {{daysText}} from today.</p>
<p>From that date we can't send you new {{trade}} jobs until your renewed licence is on file. Jobs already booked go ahead.</p>
<p>Reply to this email with a photo of the renewal, or ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const OFFICE_TEXT = `{{contractorName}}'s ({{code}}) {{trade}} licence {{licenceNumber}} expires on {{expiryLabel}} - {{daysText}} from today.

From that date {{firstName}} drops off the dispatch list for {{trade}}. Chase the renewal; once you have it, enter the new expiry on {{firstName}}'s record.`;

const OFFICE_HTML = `<p>{{contractorName}}'s ({{code}}) {{trade}} licence <strong>{{licenceNumber}}</strong> expires on {{expiryLabel}} - {{daysText}} from today.</p>
<p>From that date {{firstName}} drops off the dispatch list for {{trade}}. Chase the renewal; once you have it, enter the new expiry on {{firstName}}'s record.</p>`;

function hasButton(context: NotificationContext): boolean {
  const url = context["buttonUrl"];
  return typeof url === "string" && url.trim() !== "";
}

export const licenceExpiringEmail: NotificationTemplate = {
  type: "licence_expiring",
  channel: "email",
  category: "transactional",
  render(context) {
    if (context["audience"] === "ops") {
      const button = hasButton(context);
      return {
        subject: fill("Licence expiring - {{contractorName}}, {{Trade}}, {{expiryLabel}}", context),
        text: fill(`${OFFICE_TEXT}${button ? "\n\nOpen {{firstName}}'s record: {{buttonUrl}}" : ""}\n\n-- {{platformName}}`, context),
        html: fillHtml(
          `${OFFICE_HTML}${button ? `\n<p><a href="{{buttonUrl}}">Open {{firstName}}'s record</a></p>` : ""}\n<p>-- {{platformName}}</p>`,
          context,
        ),
      };
    }
    const replyTo = context["replyToEmail"];
    return {
      subject: fill("Your {{trade}} licence expires {{expiryLabel}}", context),
      text: fill(CONTRACTOR_TEXT, context),
      html: fillHtml(CONTRACTOR_HTML, context),
      ...(typeof replyTo === "string" && replyTo.trim() !== "" ? { replyTo: replyTo.trim() } : {}),
    };
  },
};
