// The taken-off SMS -- Feature 4006. Same facts as the email (taken-off.email.ts).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `Job reassigned, {{firstName}}: {{jobReference}} at {{street}}, {{suburb}}. You are no longer booked for {{slotLabel}}. Your calendar is clear for that time. -- {{platformName}}`;

export const takenOffSms: NotificationTemplate = {
  type: "taken_off",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
