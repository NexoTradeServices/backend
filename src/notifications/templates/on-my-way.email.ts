// The On my way email -- Feature 5004.
// Notifications / Customer messages (on my way); Transactional messages.
//
// ONE template, two wordings by the context's `audience` (the slot-confirmed pattern): the
// customer is told, with "The site contact has been informed." when the job has one and never
// who; the site contact is spoken to. No money, no link here (the customer's account offer is
// the module's own footer, added to customer copies only).
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CUSTOMER_TEXT = `Hi {{firstName}},

{{contractorFirstName}} is on the way to {{street}}, {{suburb}} now for your {{trade}} job {{jobReference}}.`;

const CUSTOMER_TOLD_TEXT = ` The site contact has been informed.`;

const CUSTOMER_FOOT_TEXT = `

To change anything, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const CUSTOMER_HTML = `<p>Hi {{firstName}},</p>
<p>{{contractorFirstName}} is on the way to {{street}}, {{suburb}} now for your {{trade}} job <strong>{{jobReference}}</strong>.`;

const CUSTOMER_TOLD_HTML = ` The site contact has been informed.`;

const CUSTOMER_FOOT_HTML = `</p>
<p>To change anything, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

{{contractorFirstName}} is on the way to {{street}}, {{suburb}} now for a {{trade}} job ({{jobReference}}).

If you need anything, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>{{contractorFirstName}} is on the way to {{street}}, {{suburb}} now for a {{trade}} job ({{jobReference}}).</p>
<p>If you need anything, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

function isSiteContactCopy(context: NotificationContext): boolean {
  return context["audience"] === "site_contact";
}

export const onMyWayEmail: NotificationTemplate = {
  type: "on_my_way",
  channel: "email",
  category: "transactional",
  render(context) {
    const subject = `On my way - ${String(context["jobReference"] ?? "")}`;
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
