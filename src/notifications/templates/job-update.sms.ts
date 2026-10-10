// The job-update SMS -- Feature 4006, CL-04. Same facts and two wordings as the email (job-update.email.ts).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CUSTOMER_TEXT = `Job update - {{jobReference}}: your booking for {{slotLabel}} at {{street}}, {{suburb}} is being re-arranged. We'll send the new time shortly. Questions: {{officePhone}} -- {{platformName}}`;
const SITE_TEXT = `Job update: the {{trade}} visit at {{street}}, {{suburb}} on {{slotLabel}} is being re-arranged. You'll hear the new time shortly. -- {{platformName}}`;

export const jobUpdateSms: NotificationTemplate = {
  type: "job_update",
  channel: "sms",
  category: "transactional",
  render(context) {
    if (context["audience"] === "site_contact") return { text: fill(SITE_TEXT, context) };
    return { text: fill(CUSTOMER_TEXT, context) };
  },
};
