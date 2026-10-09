// The job-cancelled SMS to the contractor -- Feature 4006. Same facts as the email.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `Cancelled: {{jobReference}}, {{slotLabel}} at {{street}}, {{suburb}}. Don't go - time's free again. -- {{platformName}}`;

export const jobCancelledContractorSms: NotificationTemplate = {
  type: "job_cancelled_contractor",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
