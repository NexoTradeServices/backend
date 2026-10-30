// The insurance expiring email -- Feature 7002, licence and insurance expiry alerts.
// Notifications / Contractor messages (Licence / insurance expiring); Managing the contractor record / Expiry alerts.
//
// The licence email's sibling (licence-expiring.email.ts): the same two wordings by `audience`, but the
// policy stops EVERY trade, so the consequence reads "any new jobs" / "every trade". `insurer` and
// `policyNo` are optional in the context: a blank one is left out of the sentence, never printed empty.
// Email only, transactional, no money.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

function present(context: NotificationContext, key: string): boolean {
  const value = context[key];
  return typeof value === "string" && value.trim() !== "";
}

/** "with QBE, policy PL-1," -- whichever of the two is on file; nothing when neither is. */
function policyClause(context: NotificationContext): string {
  const parts = [present(context, "insurer") ? "with {{insurer}}" : null, present(context, "policyNo") ? "policy {{policyNo}}" : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? "" : ` ${parts.join(", ")},`;
}

export const insuranceExpiringEmail: NotificationTemplate = {
  type: "insurance_expiring",
  channel: "email",
  category: "transactional",
  render(context) {
    const clause = policyClause(context);
    const button = present(context, "buttonUrl");
    if (context["audience"] === "ops") {
      const lead = `{{contractorName}}'s ({{code}}) public liability insurance${clause} expires on {{expiryLabel}} - {{daysText}} from today.`;
      const next = "From that date {{firstName}} drops off the dispatch list for every trade. Chase the renewal; once you have it, enter the new expiry on {{firstName}}'s record.";
      return {
        subject: fill("Insurance expiring - {{contractorName}}, {{expiryLabel}}", context),
        text: fill([lead, next, ...(button ? ["Open {{firstName}}'s record: {{buttonUrl}}"] : []), "-- {{platformName}}"].join("\n\n"), context),
        html: fillHtml(
          [
            `<p>${lead}</p>`,
            `<p>${next}</p>`,
            ...(button ? [`<p><a href="{{buttonUrl}}">Open {{firstName}}'s record</a></p>`] : []),
            "<p>-- {{platformName}}</p>",
          ].join("\n"),
          context,
        ),
      };
    }
    const lead = `Your public liability insurance${clause} expires on {{expiryLabel}} - {{daysText}} from today.`;
    const next = "From that date we can't send you any new jobs until your renewed insurance is on file. Jobs already booked go ahead.";
    const reply = "Reply to this email with a photo of the renewal, or ring the office on {{officePhone}}.";
    const replyTo = context["replyToEmail"];
    return {
      subject: fill("Your insurance expires {{expiryLabel}}", context),
      text: fill(["Hi {{firstName}},", lead, next, reply, "-- {{platformName}}"].join("\n\n"), context),
      html: fillHtml(
        ["<p>Hi {{firstName}},</p>", `<p>${lead}</p>`, `<p>${next}</p>`, `<p>${reply}</p>`, "<p>-- {{platformName}}</p>"].join("\n"),
        context,
      ),
      ...(typeof replyTo === "string" && replyTo.trim() !== "" ? { replyTo: replyTo.trim() } : {}),
    };
  },
};
