// The Job tomorrow SMS -- Feature 7004.
// Same facts and the same two wordings as the email (see job-tomorrow.email.ts). No money, no link.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CUSTOMER_TEXT = `{{platformName}}: reminder - {{contractorFirstName}} will be at {{street}}, {{suburb}} tomorrow, {{dateLabel}}, {{timeLabel}} for your job {{jobReference}}. Please make sure someone can let {{contractorFirstName}} in. To change, ring {{officePhone}}`;

const SITE_TEXT = `{{platformName}}: reminder - {{contractorFirstName}} will be at {{street}}, {{suburb}} tomorrow, {{dateLabel}}, {{timeLabel}} for a {{trade}} job ({{jobReference}}). Please make sure you are there to let {{contractorFirstName}} in. If that time no longer suits, ring {{officePhone}}`;

export const jobTomorrowSms: NotificationTemplate = {
  type: "job_tomorrow",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(context["audience"] === "site_contact" ? SITE_TEXT : CUSTOMER_TEXT, context) };
  },
};
