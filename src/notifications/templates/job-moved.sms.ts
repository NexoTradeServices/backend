// The job-moved SMS -- Feature 4006. Same facts and link as the email (job-moved.email.ts).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `Job moved, {{firstName}}: {{jobReference}} at {{street}}, {{suburb}}. {{oldSlotLabel}} is off. New time {{newSlotLabel}}. Accept or decline: {{linkUrl}} -- {{platformName}}`;

export const jobMovedSms: NotificationTemplate = {
  type: "job_moved",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
