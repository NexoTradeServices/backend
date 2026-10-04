// The contractor-declined email -- Feature 4003, accept / decline.
// Notifications / Transactional messages ("Contractor declined - needs a new
// contractor", Ops); Contractor Workflow step 6.
//
// Lands in the one shared ops inbox (PlatformSettings.operatorEmail). Names
// who declined, the slot, his note when there is one, and a link straight to
// the job page -- built by the sender from the environment's web origin, the
// same as the new-job-request email.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const HEAD_TEXT = `{{contractorName}} ({{contractorCode}}) declined {{jobReference}} for {{slotLabel}}.

`;
const NOTE_TEXT = `His note: "{{note}}"
`;
const NO_NOTE_TEXT = `He gave no note.
`;
const FOOT_TEXT = `
The job is back in the queue and needs a new contractor.

Open the job: {{jobUrl}}

-- {{platformName}}`;

const HEAD_HTML = `<p><strong>{{contractorName}}</strong> ({{contractorCode}}) declined <strong>{{jobReference}}</strong> for {{slotLabel}}.</p>
`;
const NOTE_HTML = `<p>His note: &quot;{{note}}&quot;</p>
`;
const NO_NOTE_HTML = `<p>He gave no note.</p>
`;
const FOOT_HTML = `<p>The job is back in the queue and needs a new contractor.</p>
<p><a href="{{jobUrl}}">Open {{jobReference}}</a></p>
<p>-- {{platformName}}</p>`;

export const contractorDeclinedEmail: NotificationTemplate = {
  type: "contractor_declined",
  channel: "email",
  category: "transactional",
  render(context) {
    const hasNote = typeof context["note"] === "string" && context["note"] !== "";
    return {
      subject: `Declined - ${String(context["jobReference"] ?? "")} needs a new contractor`,
      text: fill(HEAD_TEXT + (hasNote ? NOTE_TEXT : NO_NOTE_TEXT) + FOOT_TEXT, context),
      html: fillHtml(HEAD_HTML + (hasNote ? NOTE_HTML : NO_NOTE_HTML) + FOOT_HTML, context),
    };
  },
};
