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

export const enquiryConfirmationEmail: NotificationTemplate = {
  type: "enquiry_confirmation",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: "We've got your request",
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
