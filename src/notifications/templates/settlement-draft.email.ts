// The draft-invoice email -- Feature 6003, settlement run.
// Notifications / Contractor messages (draft invoice to approve).
//
// Goes to the CONTRACTOR the Monday his draft is made (and again, fresh, when a draft is
// replaced or rebuilt). It names the invoice and the period and the two dates he needs --
// approve by, paid on -- and nothing else: no amount, no job count. One button, "Review and
// approve", opens his approve page; the link is minted by the dispatcher at send time and
// rendered as {{linkUrl}}.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{firstName}},

Your invoice {{reference}} for {{period}} is ready. Please approve it by {{approveBy}} to be paid on {{payDay}}. If anything looks wrong, ring the office on {{officePhone}} before approving.

Review and approve: {{linkUrl}}

-- {{platformName}}`;

const HTML = `<p>Hi {{firstName}},</p>
<p>Your invoice <strong>{{reference}}</strong> for {{period}} is ready. Please approve it by {{approveBy}} to be paid on {{payDay}}. If anything looks wrong, ring the office on {{officePhone}} before approving.</p>
<p><a href="{{linkUrl}}" style="display:inline-block;padding:10px 18px;background:#e8762d;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700">Review and approve</a></p>
<p>-- {{platformName}}</p>`;

export const settlementDraftEmail: NotificationTemplate = {
  type: "settlement_draft",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: `Your invoice ${String(context["reference"] ?? "")} is awaiting your approval`,
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
