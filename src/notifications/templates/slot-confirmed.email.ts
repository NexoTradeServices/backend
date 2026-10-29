// The slot-confirmed email -- Feature 4003, accept / decline.
// Notifications / Transactional messages ("Slot confirmed", Customer (+ site
// contact)); Visit messages and the site contact; Customer messages (slot
// confirmed).
//
// ONE template per channel, two wordings (plan decision 7): the context's
// `audience` says whose copy this is. The customer is INFORMED ("Bob will be
// at the job address ...; the site contact has been informed") and never has
// the site contact named; the site contact is SPOKEN TO, with no money and no
// button. Reworded at 4006's UAT: the subject reads "Job booked - ...", and
// the site contact "has been informed". Feature 4005: the CUSTOMER's email (and
// only it) carries the booked visit's rates in its own paragraph; her text and
// the site contact's copies state no price. Feature 7004: all four wordings say
// "We'll send you a reminder the day before." when `reminderComing` is in the context.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CUSTOMER_TEXT = `Hi {{firstName}},

Your {{trade}} job {{jobReference}} is booked. {{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}}.`;

const CUSTOMER_TOLD_TEXT = ` The site contact has been informed.`;

const CUSTOMER_PRICE_TEXT = `

{{priceLine}}, billed in 15-minute blocks after the first hour.`;

const CUSTOMER_FOOT_TEXT = `

To change anything, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const CUSTOMER_HTML = `<p>Hi {{firstName}},</p>
<p>Your {{trade}} job <strong>{{jobReference}}</strong> is booked. {{contractorFirstName}} will be at {{street}}, {{suburb}} on <strong>{{slotLabel}}</strong>.`;

const CUSTOMER_TOLD_HTML = ` The site contact has been informed.`;

const CUSTOMER_PRICE_HTML = `</p>
<p>{{priceLine}}, billed in 15-minute blocks after the first hour.`;

const CUSTOMER_FOOT_HTML = `</p>
<p>To change anything, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

{{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} for a {{trade}} job ({{jobReference}}).

If that time no longer suits, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>{{contractorFirstName}} will be at {{street}}, {{suburb}} on <strong>{{slotLabel}}</strong> for a {{trade}} job ({{jobReference}}).</p>
<p>If that time no longer suits, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const REMINDER_LINE = ` We'll send you a reminder the day before.`;

/** Feature 7004: the reminder line goes right after the booking sentence, only when one will come. */
function withReminder(body: string, sentenceEnd: string, context: NotificationContext): string {
  return context["reminderComing"] === true ? body.replace(sentenceEnd, `${sentenceEnd}${REMINDER_LINE}`) : body;
}

function isSiteContactCopy(context: NotificationContext): boolean {
  return context["audience"] === "site_contact";
}

export const slotConfirmedEmail: NotificationTemplate = {
  type: "slot_confirmed",
  channel: "email",
  category: "transactional",
  render(context) {
    const subject = `Job booked - ${String(context["jobReference"] ?? "")}, ${String(context["slotLabel"] ?? "")}`;
    if (isSiteContactCopy(context)) {
      return {
        subject,
        text: fill(withReminder(SITE_TEXT, "job ({{jobReference}}).", context), context),
        html: fillHtml(withReminder(SITE_HTML, "job ({{jobReference}}).", context), context),
      };
    }
    const told = context["siteContactTold"] === true;
    const priced = typeof context["priceLine"] === "string" && context["priceLine"] !== "";
    return {
      subject,
      text: fill(withReminder(CUSTOMER_TEXT, "{{slotLabel}}.", context) + (told ? CUSTOMER_TOLD_TEXT : "") + (priced ? CUSTOMER_PRICE_TEXT : "") + CUSTOMER_FOOT_TEXT, context),
      html: fillHtml(withReminder(CUSTOMER_HTML, "</strong>.", context) + (told ? CUSTOMER_TOLD_HTML : "") + (priced ? CUSTOMER_PRICE_HTML : "") + CUSTOMER_FOOT_HTML, context),
    };
  },
};
