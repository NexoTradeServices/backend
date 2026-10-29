// The enquiry confirmation email -- Feature 3001, enquiry form to job
// created. Customer Workflow step 10; AC5. Reworded by Feature 4005.
//
// Transactional, per the design's Notifications table: always sends, no
// unsubscribe, ignores marketing consent. It carries NO price (4005): the
// price for the day the customer picked can change once Mike books another
// day or level, so the only message that states one is the Job booked email.
// It echoes what the customer asked for -- Trade, Suburb, Preferred time (web
// form only) and Job description -- so a mistake is caught before Mike rings.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT_OPEN = `Hi {{name}},

We've got your request, reference {{jobReference}} -- thanks for choosing us.

Trade: {{trade}}
Suburb: {{suburb}}
Preferred time: {{preferredTime}}`;

const TEXT_DESCRIPTION = `
Job description: {{description}}`;

const TEXT_CLOSE = `

We'll call you shortly to confirm a time.

If it's urgent, ring us now on {{officePhone}}.

-- {{platformName}}`;

const HTML_OPEN = `<p>Hi {{name}},</p>
<p>We've got your request, reference <strong>{{jobReference}}</strong> -- thanks for choosing us.</p>
<p><strong>Trade:</strong> {{trade}}<br>
<strong>Suburb:</strong> {{suburb}}<br>
<strong>Preferred time:</strong> {{preferredTime}}`;

const HTML_DESCRIPTION = `<br>
<strong>Job description:</strong> {{description}}`;

const HTML_CLOSE = `</p>
<p>We'll call you shortly to confirm a time.</p>
<p>If it's urgent, ring us now on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

// A job Mike keyed on the phone (Feature 3005, owner's wording at UAT): the customer has just been
// spoken to, so no "we'll call you" and no Preferred time (the day was just agreed on the call); the
// booking details follow, and the office number is at the end.
const PHONE_TEXT_OPEN = `Hi {{name}},

Thanks for your call. Your request is booked in as {{jobReference}}.

Trade: {{trade}}
Suburb: {{suburb}}`;

const PHONE_TEXT_CLOSE = `

We'll send you the booking details shortly. If you need anything in the meantime, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const PHONE_HTML_OPEN = `<p>Hi {{name}},</p>
<p>Thanks for your call. Your request is booked in as <strong>{{jobReference}}</strong>.</p>
<p><strong>Trade:</strong> {{trade}}<br>
<strong>Suburb:</strong> {{suburb}}`;

const PHONE_HTML_CLOSE = `</p>
<p>We'll send you the booking details shortly. If you need anything in the meantime, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

// A missing description leaves its line out rather than printing it empty (fill throws on a blank).
function hasDescription(context: NotificationContext): boolean {
  const description = context["description"];
  return typeof description === "string" && description.trim() !== "";
}

export const enquiryConfirmationEmail: NotificationTemplate = {
  type: "enquiry_confirmation",
  channel: "email",
  category: "transactional",
  render(context) {
    const phone = context["source"] === "phone";
    const described = hasDescription(context);
    const text = phone
      ? PHONE_TEXT_OPEN + (described ? TEXT_DESCRIPTION : "") + PHONE_TEXT_CLOSE
      : TEXT_OPEN + (described ? TEXT_DESCRIPTION : "") + TEXT_CLOSE;
    const html = phone
      ? PHONE_HTML_OPEN + (described ? HTML_DESCRIPTION : "") + PHONE_HTML_CLOSE
      : HTML_OPEN + (described ? HTML_DESCRIPTION : "") + HTML_CLOSE;
    return {
      subject: "We've got your request",
      text: fill(text, context),
      html: fillHtml(html, context),
    };
  },
};
