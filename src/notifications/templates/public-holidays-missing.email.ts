// The Public holidays missing email -- Feature 1020, Calendar & Scheduling / Public holidays.
// Notifications. To the business inbox (recipientType "ops"). Two wordings by the context's `short`:
// none entered ("missing") or 1 to 6 entered ("look incomplete"). `state` and `year` are plain facts
// handed over by holidays/missing-step.ts; `buttonUrl` opens Settings.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

export const publicHolidaysMissingEmail: NotificationTemplate = {
  type: "public_holidays_missing",
  channel: "email",
  category: "transactional",
  render(context) {
    const incomplete = context["short"] === true;
    const subject = incomplete ? "Public holidays incomplete - {{state}} {{year}}" : "Public holidays missing - {{state}} {{year}}";
    const first = incomplete
      ? "{{year}} public holidays look incomplete for {{state}}."
      : "{{year}} public holidays are missing for {{state}}.";
    const second = incomplete
      ? "Please ask the platform administrator to add the missing ones, so jobs can't be booked on those days."
      : "Please ask the platform administrator to add them, so jobs can't be booked on those days.";
    const url = context["buttonUrl"];
    const button = typeof url === "string" && url.trim() !== "";
    return {
      subject: fill(subject, context),
      text: fill(`${first} ${second}${button ? "\n\nOpen Settings: {{buttonUrl}}" : ""}\n\n-- {{platformName}}`, context),
      html: fillHtml(
        `<p>${first} ${second}</p>${button ? '\n<p><a href="{{buttonUrl}}">Open Settings</a></p>' : ""}\n<p>-- {{platformName}}</p>`,
        context,
      ),
    };
  },
};
