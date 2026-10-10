// The job-cancelled SMS to the contractor -- Feature 4006. Same facts as the email.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `Job cancelled, {{firstName}}: {{jobReference}} at {{street}}, {{suburb}}. You are no longer booked for {{slotLabel}}, so please don't attend. Your calendar is clear for that time. -- {{platformName}}`;

export const jobCancelledContractorSms: NotificationTemplate = {
  type: "job_cancelled_contractor",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
