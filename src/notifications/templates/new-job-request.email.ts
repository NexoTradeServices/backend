// The new-job-request email -- Feature 3001, enquiry form to job created.
// Notifications / Transactional messages ("New job request", Ops); AC6.
//
// Transactional, addressed from PlatformSettings.operatorEmail (BKLG-004) --
// the first message this module actually sends to the shared ops inbox.
// Plan decision 4: no deep link into the ops portal, because /ops/jobs does
// not exist yet (4001) -- plain text only; the link is added when 4001 ships.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `New job request: {{jobReference}}

Trade: {{trade}}
Suburb: {{suburb}}
Preferred: {{preferredDate}}, {{preferredWindow}}

-- {{platformName}}`;

const HTML = `<p>New job request: <strong>{{jobReference}}</strong></p>
<p>Trade: {{trade}}<br>
Suburb: {{suburb}}<br>
Preferred: {{preferredDate}}, {{preferredWindow}}</p>
<p>-- {{platformName}}</p>`;

export const newJobRequestEmail: NotificationTemplate = {
  type: "new_job_request",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `New job request: ${String(context["jobReference"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
