// The job-moved email -- Feature 4006, reschedule / take off / cancel.
// Notifications / Contractor messages ("Job rescheduled", reworded at UAT from "Job moved"). ONE
// message to the contractor: the old time is off, the new time is asked, with a fresh Accept
// link. The customer is not told here.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

{{jobReference}} at {{street}}, {{suburb}} has been rescheduled to {{newSlotLabel}}. You are no longer booked for {{oldSlotLabel}}.

New time: {{newSlotLabel}}
Trade: {{trade}}
Site contact: {{siteContact}}

Please accept or decline the new time: {{linkUrl}}

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p><strong>{{jobReference}}</strong> at {{street}}, {{suburb}} has been rescheduled to {{newSlotLabel}}. You are no longer booked for {{oldSlotLabel}}.</p>
<p>New time: <strong>{{newSlotLabel}}</strong><br>
Trade: {{trade}}<br>
Site contact: {{siteContact}}</p>
<p><a href="{{linkUrl}}">Please accept or decline the new time</a></p>
<p>-- {{platformName}}</p>`;

export const jobMovedEmail: NotificationTemplate = {
  type: "job_moved",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Job rescheduled - ${String(context["jobReference"] ?? "")}, ${String(context["newSlotLabel"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
