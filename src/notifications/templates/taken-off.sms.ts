// The taken-off SMS -- Feature 4006. Same facts as the email (taken-off.email.ts).
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const TEXT = `{{firstName}}, you're no longer booked on {{jobReference}} ({{slotLabel}}, {{suburb}}). Time's free again, nothing to do. -- {{platformName}}`;

export const takenOffSms: NotificationTemplate = {
  type: "taken_off",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(TEXT, context) };
  },
};
