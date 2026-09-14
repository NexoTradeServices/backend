// The job-dispatched email -- Feature 4002, dispatch to assignment.
// Notifications / Transactional messages ("Job dispatched", Contractor); AC30.
//
// Plan decision 12: first name, job reference, trade, the site's street and
// suburb, the slot (labelled AWST), the signature from platformName. The
// link is a respond capability link, minted by the dispatcher at send time
// and rendered as {{linkUrl}}.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

New job for you: {{jobReference}}.

Trade: {{trade}}
When: {{slotLabel}}
Where: {{street}}, {{suburb}}

Accept or decline: {{linkUrl}}

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>New job for you: <strong>{{jobReference}}</strong>.</p>
<p>Trade: {{trade}}<br>
When: {{slotLabel}}<br>
Where: {{street}}, {{suburb}}</p>
<p><a href="{{linkUrl}}">Accept or decline</a></p>
<p>-- {{platformName}}</p>`;

export const jobDispatchedEmail: NotificationTemplate = {
  type: "job_dispatched",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `New job for you - ${String(context["jobReference"] ?? "")}, ${String(context["slotLabel"] ?? "")}`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
