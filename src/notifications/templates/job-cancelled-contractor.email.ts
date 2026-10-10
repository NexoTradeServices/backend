// The job-cancelled email to the contractor -- Feature 4006, reschedule / take off / cancel.
// Notifications / Contractor messages ("Job cancelled"): sent when he held a booking, answered or not.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

{{jobReference}} at {{street}}, {{suburb}} has been cancelled. You are no longer booked for {{slotLabel}}, so please don't attend. Your calendar is clear for that time.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p><strong>{{jobReference}}</strong> at {{street}}, {{suburb}} has been cancelled. You are no longer booked for {{slotLabel}}, so please don't attend. Your calendar is clear for that time.</p>
<p>-- {{platformName}}</p>`;

export const jobCancelledContractorEmail: NotificationTemplate = {
  type: "job_cancelled_contractor",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Job cancelled - ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
