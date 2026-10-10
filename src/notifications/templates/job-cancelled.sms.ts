// The job-cancelled SMS -- Feature 4006. Same three wordings as the email (job-cancelled.email.ts).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const AS_ASKED_TEXT = `Job cancelled, {{firstName}}: as requested, {{jobReference}} ({{trade}}) has been cancelled. There is no charge. To book again, ring {{officePhone}}. -- {{platformName}}`;
const NO_COVER_TEXT = `Job cancelled, {{firstName}}: sorry, we were unable to find anyone available for {{jobReference}} in your area. There is no charge. To try again later, ring {{officePhone}}. -- {{platformName}}`;
const SITE_TEXT = `Job cancelled, {{firstName}}: the {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} has been cancelled. -- {{platformName}}`;

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
