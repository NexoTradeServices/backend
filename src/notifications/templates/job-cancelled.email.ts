// The job-cancelled email -- Feature 4006, reschedule / take off / cancel.
// Notifications / Customer messages (job cancelled - the two wordings) and the site contact's copy.
//
// ONE template per channel, three wordings: the context's `audience` says whose copy it is, and
// for the customer `wording` says "as_you_asked" (she changed her mind, price, other) or
// "sorry_no_cover" (nobody covers the area). Nothing is owed on either; no price is stated.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const AS_ASKED_TEXT = `Hi {{firstName}},

As you asked, we've cancelled your {{trade}} job {{jobReference}}{{slotPart}}. Nothing is owed.

To book again, ring the office on {{officePhone}}.

-- {{platformName}}`;

const AS_ASKED_HTML = `<p>Hi {{firstName}},</p>
<p>As you asked, we've cancelled your {{trade}} job <strong>{{jobReference}}</strong>{{slotPart}}. Nothing is owed.</p>
<p>To book again, ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const NO_COVER_TEXT = `Hi {{firstName}},

We're sorry - nobody can cover your area for your {{trade}} job {{jobReference}}, so we've cancelled it. Nothing is owed.

If you'd like to try again later, ring the office on {{officePhone}}.

-- {{platformName}}`;

const NO_COVER_HTML = `<p>Hi {{firstName}},</p>
<p>We're sorry - nobody can cover your area for your {{trade}} job <strong>{{jobReference}}</strong>, so we've cancelled it. Nothing is owed.</p>
<p>If you'd like to try again later, ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

The {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} ({{jobReference}}) is cancelled. Nobody will come.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>The {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} ({{jobReference}}) is cancelled. Nobody will come.</p>
<p>-- {{platformName}}</p>`;

function reference(context: NotificationContext): string {
  return String(context["jobReference"] ?? "");
}

export const jobCancelledEmail: NotificationTemplate = {
  type: "job_cancelled",
  channel: "email",
  category: "transactional",
  render(context) {
    if (context["audience"] === "site_contact") {
      return {
        subject: `Visit cancelled - ${String(context["street"] ?? "")}, ${String(context["slotLabel"] ?? "")}`,
        text: fill(SITE_TEXT, context),
        html: fillHtml(SITE_HTML, context),
      };
    }
    if (context["wording"] === "sorry_no_cover") {
      return {
        subject: `Sorry - we've cancelled ${reference(context)}`,
        text: fill(NO_COVER_TEXT, context),
        html: fillHtml(NO_COVER_HTML, context),
      };
    }
    return {
      subject: `Cancelled - ${reference(context)}`,
      text: fill(AS_ASKED_TEXT, context),
      html: fillHtml(AS_ASKED_HTML, context),
    };
  },
};
