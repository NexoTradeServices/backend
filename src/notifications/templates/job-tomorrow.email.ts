// The Job tomorrow email -- Feature 7004.
// Notifications / Customer messages (job tomorrow); Transactional messages.
//
// ONE template, two wordings by the context's `audience` (the slot-confirmed pattern): the
// customer is reminded, with "The site contact has been reminded too." when the job has one and
// never who; the site contact is spoken to. No money, no link here (the customer's account offer
// is the module's own footer, added to customer copies only).
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CUSTOMER_TEXT = `Hi {{firstName}},

A reminder: {{contractorFirstName}} will be at {{street}}, {{suburb}} tomorrow, {{dateLabel}}, at {{timeLabel}} for your {{trade}} job {{jobReference}}.

Please make sure someone is there to let {{contractorFirstName}} in.`;

const CUSTOMER_TOLD_TEXT = ` The site contact has been reminded too.`;

const CUSTOMER_FOOT_TEXT = `

To change anything, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const CUSTOMER_HTML = `<p>Hi {{firstName}},</p>
<p>A reminder: {{contractorFirstName}} will be at {{street}}, {{suburb}} tomorrow, <strong>{{dateLabel}}, at {{timeLabel}}</strong> for your {{trade}} job <strong>{{jobReference}}</strong>.</p>
<p>Please make sure someone is there to let {{contractorFirstName}} in.`;

const CUSTOMER_TOLD_HTML = ` The site contact has been reminded too.`;

const CUSTOMER_FOOT_HTML = `</p>
<p>To change anything, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

A reminder: {{contractorFirstName}} will be at {{street}}, {{suburb}} tomorrow, {{dateLabel}}, at {{timeLabel}} for a {{trade}} job ({{jobReference}}).

Please make sure you are there to let {{contractorFirstName}} in.

If that time no longer suits, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>A reminder: {{contractorFirstName}} will be at {{street}}, {{suburb}} tomorrow, <strong>{{dateLabel}}, at {{timeLabel}}</strong> for a {{trade}} job ({{jobReference}}).</p>
<p>Please make sure you are there to let {{contractorFirstName}} in.</p>
<p>If that time no longer suits, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

function isSiteContactCopy(context: NotificationContext): boolean {
  return context["audience"] === "site_contact";
}

export const jobTomorrowEmail: NotificationTemplate = {
  type: "job_tomorrow",
  channel: "email",
  category: "transactional",
  render(context) {
    const subject = `Job tomorrow - ${String(context["jobReference"] ?? "")}, ${String(context["timeLabel"] ?? "")}`;
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
