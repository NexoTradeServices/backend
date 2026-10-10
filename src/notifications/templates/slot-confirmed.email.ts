// The slot-confirmed email -- Feature 4003, accept / decline.
// Notifications / Transactional messages ("Slot confirmed", Customer (+ site
// contact)); Visit messages and the site contact; Customer messages (slot
// confirmed).
//
// ONE template per channel, two wordings (plan decision 7): the context's
// `audience` says whose copy this is. The customer is INFORMED ("Bob will be
// at the job address ...; the site contact has been informed") and never has
// the site contact named; the site contact is SPOKEN TO, with no money and no
// button. Reworded at 4006's UAT: the subject reads "Job booked - ...", the
// message states NO price (the owner's call: money is not carried in
// messages), and the site contact "has been informed".
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CUSTOMER_TEXT = `Hi {{firstName}},

Your {{trade}} job {{jobReference}} is booked. {{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}}.`;

const CUSTOMER_TOLD_TEXT = ` The site contact has been informed.`;

const CUSTOMER_FOOT_TEXT = `

To change anything, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const CUSTOMER_HTML = `<p>Hi {{firstName}},</p>
<p>Your {{trade}} job <strong>{{jobReference}}</strong> is booked. {{contractorFirstName}} will be at {{street}}, {{suburb}} on <strong>{{slotLabel}}</strong>.`;

const CUSTOMER_TOLD_HTML = ` The site contact has been informed.`;

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
      return { subject, text: fill(SITE_TEXT, context), html: fillHtml(SITE_HTML, context) };
    }
    const told = context["siteContactTold"] === true;
    return {
      subject,
      text: fill(CUSTOMER_TEXT + (told ? CUSTOMER_TOLD_TEXT : "") + CUSTOMER_FOOT_TEXT, context),
      html: fillHtml(CUSTOMER_HTML + (told ? CUSTOMER_TOLD_HTML : "") + CUSTOMER_FOOT_HTML, context),
    };
  },
};
