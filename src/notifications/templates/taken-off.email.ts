// The taken-off email -- Feature 4006, reschedule / take off / cancel.
// Notifications / Contractor messages: Mike reassigned the job (the button was "Take off" until UAT);
// he is no longer booked and his calendar is clear.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

{{jobReference}} at {{street}}, {{suburb}} has been reassigned. You are no longer booked for {{slotLabel}}. Your calendar is clear for that time.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p><strong>{{jobReference}}</strong> at {{street}}, {{suburb}} has been reassigned. You are no longer booked for {{slotLabel}}. Your calendar is clear for that time.</p>
<p>-- {{platformName}}</p>`;

export const takenOffEmail: NotificationTemplate = {
  type: "taken_off",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Job reassigned - ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
