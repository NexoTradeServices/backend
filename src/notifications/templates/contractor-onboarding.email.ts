// The contractor welcome/invite email -- Feature 2001, contractor onboarding
// (Mike's path).
//
// Design: Contractor Workflow step 1 -- "Welcome to <display name>, set your
// password to get started" ... "the contractor never sees the word reset."
// The closing line asks the contractor to log in and complete their details on My details (Feature 2005).
//
// Transactional, per the design's Notifications table (Onboarding / account
// setup row): always sends, no unsubscribe.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{name}},

Welcome to {{platformName}}. Set your password to get started:

{{resetUrl}}

Log in and complete your details.

-- {{platformName}}`;

const HTML = `<p>Hi {{name}},</p>
<p>Welcome to {{platformName}}. Set your password to get started:</p>
<p><a href="{{resetUrl}}">Set your password</a></p>
<p>Log in and complete your details.</p>
<p>-- {{platformName}}</p>`;

export const contractorOnboardingEmail: NotificationTemplate = {
  type: "contractor_onboarding",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: fill("Welcome to {{platformName}} -- set your password", context),
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
