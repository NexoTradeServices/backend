// The taken-off email -- Feature 4006, reschedule / take off / cancel.
// Notifications / Contractor messages: his time is off, nothing to do.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

You're no longer booked on {{jobReference}} at {{street}}, {{suburb}} on {{slotLabel}}. The time is free again. Nothing to do.

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>You're no longer booked on <strong>{{jobReference}}</strong> at {{street}}, {{suburb}} on {{slotLabel}}. The time is free again. Nothing to do.</p>
<p>-- {{platformName}}</p>`;

export const takenOffEmail: NotificationTemplate = {
  type: "taken_off",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `You're off ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
