// The On my way SMS -- Feature 5004.
// Same facts and the same two wordings as the email (see on-my-way.email.ts). No money, no link.
import type { NotificationTemplate } from "../types.js";
import { fill } from "./render.js";

const CUSTOMER_TEXT = `{{platformName}}: {{contractorFirstName}} is on the way to {{street}}, {{suburb}} now for your job {{jobReference}}. Questions? Ring {{officePhone}}`;

const SITE_TEXT = `{{platformName}}: {{contractorFirstName}} is on the way to {{street}}, {{suburb}} now for a {{trade}} job ({{jobReference}}). Questions? Ring {{officePhone}}`;

export const onMyWaySms: NotificationTemplate = {
  type: "on_my_way",
  channel: "sms",
  category: "transactional",
  render(context) {
    return { text: fill(context["audience"] === "site_contact" ? SITE_TEXT : CUSTOMER_TEXT, context) };
  },
};
