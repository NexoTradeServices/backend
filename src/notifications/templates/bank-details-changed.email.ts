// The Bank details changed email -- Feature 2005, Notifications / Contractor messages.
// To the contractor and to the business inbox when bank details already on file are replaced. Carries NO
// numbers and no button for the contractor; the office copy links to the contractor's record.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const LINE = "{{firstName}}'s bank details were changed. If this wasn't {{firstName}}, contact the office now.";

export const bankDetailsChangedEmail: NotificationTemplate = {
  type: "bank_details_changed",
  channel: "email",
  category: "transactional",
  render(context) {
    const url = context["buttonUrl"];
    const button = typeof url === "string" && url.trim() !== "";
    return {
      subject: fill("Bank details changed - {{contractorName}}", context),
      text: fill(`${LINE}${button ? "\n\nOpen the record: {{buttonUrl}}" : ""}\n\n-- {{platformName}}`, context),
      html: fillHtml(
        `<p>${LINE}</p>${button ? '\n<p><a href="{{buttonUrl}}">Open the record</a></p>' : ""}\n<p>-- {{platformName}}</p>`,
        context,
      ),
    };
  },
};
