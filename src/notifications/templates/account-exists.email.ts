// The "Already have an account" email -- Feature 3004, guest to account.
//
// Sent when someone asks to set a password for an address that already has a
// login (or belongs to a login of another role). Tells her to log in, and
// where to go if she forgot the password. Transactional account mail: always
// sends, no unsubscribe, no offer footer.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{name}},

You already have an account with {{platformName}}. Log in here:

{{loginUrl}}

Forgotten your password? You can choose a new one here:

{{forgotUrl}}

If you did not ask for this, ignore this message -- nothing has changed.

-- {{platformName}}`;

const HTML = `<p>Hi {{name}},</p>
<p>You already have an account with {{platformName}}.</p>
<p><a href="{{loginUrl}}">Log in</a></p>
<p>Forgotten your password? <a href="{{forgotUrl}}">Choose a new one</a>.</p>
<p>If you did not ask for this, ignore this message -- nothing has changed.</p>
<p>-- {{platformName}}</p>`;

export const accountExistsEmail: NotificationTemplate = {
  type: "account_exists",
  channel: "email",
  category: "transactional",
  render(context) {
    return {
      subject: "You already have an account",
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
