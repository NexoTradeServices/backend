// The job-cancelled SMS -- Feature 4006. Same three wordings as the email (job-cancelled.email.ts).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const AS_ASKED_TEXT = `As you asked, {{jobReference}} ({{trade}}) is cancelled. Nothing is owed. To book again: {{officePhone}} -- {{platformName}}`;
const NO_COVER_TEXT = `Sorry {{firstName}} - nobody can cover your area for {{jobReference}}, so it's cancelled. Nothing is owed. {{officePhone}} -- {{platformName}}`;
const SITE_TEXT = `The {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} is cancelled - nobody will come. -- {{platformName}}`;

export const jobCancelledSms: NotificationTemplate = {
  type: "job_cancelled",
  channel: "sms",
  category: "transactional",
  render(context) {
    if (context["audience"] === "site_contact") return { text: fill(SITE_TEXT, context) };
    if (context["wording"] === "sorry_no_cover") return { text: fill(NO_COVER_TEXT, context) };
    return { text: fill(AS_ASKED_TEXT, context) };
  },
};
