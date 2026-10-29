// The enquiry confirmation email -- Feature 3001, enquiry form to job
// created. Customer Workflow step 10; AC5.
//
// Transactional, per the design's Notifications table: always sends, no
// unsubscribe, ignores marketing consent. Quotes the RATES FROZEN ON THE
// JOB -- read from the snapshot the caller hands in, never re-read live from
// ServiceType (Invoicing / Two-tier pricing, "Rate snapshots" -- "the
// enquiry-confirmation and invoice emails quote the job's snapshot rates").
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{name}},

We've got your request, reference {{jobReference}} -- thanks for choosing us.

First hour (includes call-out) {{calloutRate}}, then {{standardRate}}/h.

We'll call you shortly to confirm a time.

-- {{platformName}}`;

const HTML = `<p>Hi {{name}},</p>
<p>We've got your request, reference <strong>{{jobReference}}</strong> -- thanks for choosing us.</p>
<p>First hour (includes call-out) {{calloutRate}}, then {{standardRate}}/h.</p>
<p>We'll call you shortly to confirm a time.</p>
<p>-- {{platformName}}</p>`;

// A job Mike keyed on the phone (Feature 3005, owner's wording at UAT): the customer has just been
// spoken to, so no "we'll call you"; the booking details follow, and the office number is at the end.
const PHONE_TEXT = `Hi {{name}},

Thanks for your call. Your request is booked in as {{jobReference}}.

First hour (includes call-out) {{calloutRate}}, then {{standardRate}}/h.

We'll send you the booking details shortly. If you need anything in the meantime, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const PHONE_HTML = `<p>Hi {{name}},</p>
<p>Thanks for your call. Your request is booked in as <strong>{{jobReference}}</strong>.</p>
<p>First hour (includes call-out) {{calloutRate}}, then {{standardRate}}/h.</p>
<p>We'll send you the booking details shortly. If you need anything in the meantime, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

export const enquiryConfirmationEmail: NotificationTemplate = {
  type: "enquiry_confirmation",
  channel: "email",
  category: "transactional",
  render(context) {
    const phone = context["source"] === "phone";
    return {
      subject: "We've got your request",
      text: fill(phone ? PHONE_TEXT : TEXT, context),
      html: fillHtml(phone ? PHONE_HTML : HTML, context),
    };
  },
};
