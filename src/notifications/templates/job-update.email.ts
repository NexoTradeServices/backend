// The job-update email -- Feature 4006, CL-04 (folded in at UAT).
// Notifications / Customer messages ("Job update"): when Mike reassigns a job that was booked, the
// customer and the site contact each had a confirmed time, so each is told that booking is being
// re-arranged and the new time will follow. Sent only when a confirmed time had gone to them.
// ONE template per channel, two wordings: the context's `audience` says whose copy this is.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const CUSTOMER_TEXT = `Hi {{firstName}},

Your booking for {{slotLabel}} at {{street}}, {{suburb}} is being re-arranged. We'll send you the new time shortly.

Questions? Ring the office on {{officePhone}}.

-- {{platformName}}`;

const CUSTOMER_HTML = `<p>Hi {{firstName}},</p>
<p>Your booking for <strong>{{slotLabel}}</strong> at {{street}}, {{suburb}} is being re-arranged. We'll send you the new time shortly.</p>
<p>Questions? Ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

The {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} is being re-arranged. You'll hear the new time shortly.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>The {{trade}} visit at {{street}}, {{suburb}} on <strong>{{slotLabel}}</strong> is being re-arranged. You'll hear the new time shortly.</p>
<p>-- {{platformName}}</p>`;

function isSiteContactCopy(context: NotificationContext): boolean {
  return context["audience"] === "site_contact";
}

export const jobUpdateEmail: NotificationTemplate = {
  type: "job_update",
  channel: "email",
  category: "transactional",
  render(context) {
    if (isSiteContactCopy(context)) {
      return {
        subject: `Job update - ${String(context["street"] ?? "")}, ${String(context["slotLabel"] ?? "")}`,
        text: fill(SITE_TEXT, context),
        html: fillHtml(SITE_HTML, context),
      };
    }
    return {
      subject: `Job update - ${String(context["jobReference"] ?? "")}`,
      text: fill(CUSTOMER_TEXT, context),
      html: fillHtml(CUSTOMER_HTML, context),
    };
  },
};
