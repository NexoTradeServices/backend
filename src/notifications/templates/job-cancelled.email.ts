// The job-cancelled email -- Feature 4006, reschedule / take off / cancel.
// Notifications / Customer messages (job cancelled - the two wordings) and the site contact's copy.
//
// ONE template per channel, three wordings: the context's `audience` says whose copy it is, and
// for the customer `wording` says "as_you_asked" (she asked: changed mind, price, other) or
// "sorry_no_cover" (we could not find anyone). Every subject reads "Job cancelled - <reference>".
// No money beyond "There is no charge", and no word "contractor" (our arrangement with the people
// who do the work is not the customer's business). Worded at UAT.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const AS_ASKED_TEXT = `Hi {{firstName}},

As requested, your {{trade}} job {{jobReference}}{{slotPart}} has been cancelled. There is no charge.

To book again, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const AS_ASKED_HTML = `<p>Hi {{firstName}},</p>
<p>As requested, your {{trade}} job <strong>{{jobReference}}</strong>{{slotPart}} has been cancelled. There is no charge.</p>
<p>To book again, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const NO_COVER_TEXT = `Hi {{firstName}},

We're sorry - we were unable to find anyone available to do your {{trade}} job {{jobReference}} in your area, so it has been cancelled. There is no charge.

If you'd like to try again later, please ring the office on {{officePhone}}.

-- {{platformName}}`;

const NO_COVER_HTML = `<p>Hi {{firstName}},</p>
<p>We're sorry - we were unable to find anyone available to do your {{trade}} job <strong>{{jobReference}}</strong> in your area, so it has been cancelled. There is no charge.</p>
<p>If you'd like to try again later, please ring the office on {{officePhone}}.</p>
<p>-- {{platformName}}</p>`;

const SITE_TEXT = `Hi {{firstName}},

The {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} ({{jobReference}}) has been cancelled.

-- {{platformName}}`;

const SITE_HTML = `<p>Hi {{firstName}},</p>
<p>The {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} ({{jobReference}}) has been cancelled.</p>
<p>-- {{platformName}}</p>`;

function reference(context: NotificationContext): string {
  return String(context["jobReference"] ?? "");
}

export const jobCancelledEmail: NotificationTemplate = {
  type: "job_cancelled",
  channel: "email",
  category: "transactional",
  render(context) {
    const subject = `Job cancelled - ${reference(context)}`;
    if (context["audience"] === "site_contact") {
      return { subject, text: fill(SITE_TEXT, context), html: fillHtml(SITE_HTML, context) };
    }
    if (context["wording"] === "sorry_no_cover") {
      return { subject, text: fill(NO_COVER_TEXT, context), html: fillHtml(NO_COVER_HTML, context) };
    }
    return { subject, text: fill(AS_ASKED_TEXT, context), html: fillHtml(AS_ASKED_HTML, context) };
  },
};
