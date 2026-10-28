// The "Set your password" email -- Feature 3004, guest to account.
//
// Design: Guest by default, account by invitation. A guest who asked for a
// login gets one link; the button opens the existing Set a new password page.
// Transactional account mail (addressed to the User's own login email): always
// sends, no unsubscribe, no offer footer.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{name}},

We've already got you - just set a password to finish.

{{resetUrl}}

The link works once and expires within the hour. If you did not ask for this, ignore this message -- nothing has changed.

-- {{platformName}}`;

const HTML = `<p>Hi {{name}},</p>
<p>We've already got you - just set a password to finish.</p>
<p><a href="{{resetUrl}}">Set your password</a></p>
<p>The link works once and expires within the hour. If you did not ask for this, ignore this message -- nothing has changed.</p>
<p>-- {{platformName}}</p>`;

export const customerSetPasswordEmail: NotificationTemplate = {
  type: "customer_set_password",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: "Set your password",
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
