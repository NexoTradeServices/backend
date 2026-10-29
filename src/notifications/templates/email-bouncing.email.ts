// Email bouncing -- Feature 7001, bounced emails.
// Notifications / Suppression scope - split by reason (A hard bounce becomes a listing and one alert).
//
// To the shared ops inbox, once per address, the first time a hard bounce lists it. It says whose
// address it is, what did not arrive, and where to fix it. No amounts. The asker (bounce.ts) does the
// looking up and hands over plain facts; this file only words them.
//
// `kind` is who the address belongs to: customer, site_contact, contractor, user (a login's own
// account mail), or unknown (the person could not be found; the address stands alone). `jobReference` is absent when the bounced message had no job; `buttonUrl` and
// `buttonLabel` are absent when there is nowhere to send Mike.
import type { NotificationContext, NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

function text(context: NotificationContext, key: string): string | null {
  const value = context[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function leadFor(context: NotificationContext): string {
  const kind = text(context, "kind");
  const jobReference = text(context, "jobReference");
  if (kind === "unknown") return "The email address {{address}} is bouncing - it is misspelt or no longer exists.";
  if (kind === "site_contact" && jobReference !== null) {
    return "{{personName}}, the site contact on {{jobReference}}, has an email address {{address}} that is bouncing - it is misspelt or no longer exists.";
  }
  return "{{personName}}'s email address {{address}} is bouncing - it is misspelt or no longer exists.";
}

function whatFor(context: NotificationContext): string | null {
  return text(context, "jobReference") === null
    ? "What did not arrive: {{messageName}}."
    : "What did not arrive: {{messageName}} - {{jobReference}}.";
}

function fixFor(context: NotificationContext): string {
  const kind = text(context, "kind");
  if (kind === "unknown") return "Nothing more will be emailed to this address.";
  if (kind === "user") {
    return "Nothing more will be emailed to this address. Texts still go to {{firstName}}'s phone.";
  }
  const where = kind === "contractor" ? "on {{firstName}}'s record" : "on the job page";
  return `Nothing more will be emailed to this address. Texts still go to {{firstName}}'s phone. Ring {{firstName}}, check the address and correct it ${where}.`;
}

export const emailBouncingEmail: NotificationTemplate = {
  type: "email_bouncing",
  channel: "email",
  category: "transactional",
  render(context) {
    const lead = leadFor(context);
    const what = whatFor(context);
    const fix = fixFor(context);
    const hasButton = text(context, "buttonUrl") !== null && text(context, "buttonLabel") !== null;

    const textBody = [lead, what, fix, ...(hasButton ? ["{{buttonLabel}}: {{buttonUrl}}"] : []), "-- {{platformName}}"].join("\n\n");
    const htmlBody = [
      `<p>${lead}</p>`,
      `<p>${what}</p>`,
      `<p>${fix}</p>`,
      ...(hasButton ? ['<p><a href="{{buttonUrl}}">{{buttonLabel}}</a></p>'] : []),
      "<p>-- {{platformName}}</p>",
    ].join("\n");

    return {
      subject: `Email bouncing - ${text(context, "personName") ?? ""}`,
      text: fill(textBody, context),
      html: fillHtml(htmlBody, context),
    };
  },
};
