// The slot-confirmed email -- Feature 4003, accept / decline.
// Notifications / Transactional messages ("Slot confirmed", Customer (+ site
// contact)); Visit messages and the site contact; Customer messages (slot
// confirmed); A message that states a price.
//
// ONE template per channel, two wordings (plan decision 7): the context's
// `audience` says whose copy this is. The customer is INFORMED ("Bob is
// booked at the job address ...; the site contact has been told") and never
// has the site contact named; the site contact is SPOKEN TO, with no money
// and no button. The customer's copy carries no Track button and no
// reminder line yet (4005, 7004 switch those on). The price is the caller's
// `priceLine` -- the job's frozen card times its stamped level -- and names
// the RATES, never a total.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CUSTOMER_TEXT = `Hi {{firstName}},

{{contractorFirstName}} is booked at {{street}}, {{suburb}} on {{slotLabel}}.
`;

const CUSTOMER_TOLD_TEXT = `The site contact has been told.
`;

const CUSTOMER_FOOT_TEXT = `
Reference: {{jobReference}} - {{trade}}

Price for that day: {{priceLine}}, billed on actual time in 15-minute blocks.

To change anything, ring the office on {{officePhone}}.

-- {{platformName}}`;

const CUSTOMER_HTML = `<p>Hi {{firstName}},</p>
<p>{{contractorFirstName}} is booked at {{street}}, {{suburb}} on <strong>{{slotLabel}}</strong>.</p>
`;

const CUSTOMER_TOLD_HTML = `<p>The site contact has been told.</p>
`;

const CUSTOMER_FOOT_HTML = `<p>Reference: {{jobReference}} - {{trade}}</p>
<p>Price for that day: {{priceLine}}, billed on actual time in 15-minute blocks.</p>
<p>To change anything, ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

{{contractorFirstName}} will be at {{street}}, {{suburb}} on {{slotLabel}} for a {{trade}} job ({{jobReference}}).

If that time no longer suits, ring the office on {{officePhone}}.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>{{contractorFirstName}} will be at {{street}}, {{suburb}} on <strong>{{slotLabel}}</strong> for a {{trade}} job ({{jobReference}}).</p>
<p>If that time no longer suits, ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

function isSiteContactCopy(context: NotificationContext): boolean {
  return context["audience"] === "site_contact";
}

export const slotConfirmedEmail: NotificationTemplate = {
  type: "slot_confirmed",
  channel: "email",
  category: "transactional",
  render(context) {
    const slot = String(context["slotLabel"] ?? "");
    if (isSiteContactCopy(context)) {
      return {
        subject: `${String(context["contractorFirstName"] ?? "")} will be at ${String(context["street"] ?? "")}, ${slot}`,
        text: fill(SITE_TEXT, context),
        html: fillHtml(SITE_HTML, context),
      };
    }
    const told = context["siteContactTold"] === true;
    return {
      subject: `Booked - ${String(context["jobReference"] ?? "")}, ${slot}`,
      text: fill(CUSTOMER_TEXT + (told ? CUSTOMER_TOLD_TEXT : "") + CUSTOMER_FOOT_TEXT, context),
      html: fillHtml(CUSTOMER_HTML + (told ? CUSTOMER_TOLD_HTML : "") + CUSTOMER_FOOT_HTML, context),
    };
  },
};
