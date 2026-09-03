// The password-reset email -- Feature 1004, notification module.
//
// The one template this feature ships. Every other message's wording belongs to
// the feature that sends it (the design parks templates and cadence until each
// template build); this one exists so feature 1003's password reset has
// something to call the moment it lands.
//
// Transactional, per the design's Notifications table: password reset always
// sends, carries no unsubscribe, and ignores marketing consent.
import type { NotificationTemplate } from "../types.js";
import { fill, fillHtml } from "./render.js";

const TEXT = `Hi {{name}},

Someone asked to reset the password on your account. If that was you, open the
link below to choose a new one:

{{resetUrl}}

The link expires shortly and can be used once. If it was not you, ignore this
message -- your password has not changed.

-- {{platformName}}`;

const HTML = `<p>Hi {{name}},</p>
<p>Someone asked to reset the password on your account. If that was you, open the
link below to choose a new one:</p>
<p><a href="{{resetUrl}}">Reset your password</a></p>
<p>The link expires shortly and can be used once. If it was not you, ignore this
message -- your password has not changed.</p>
<p>-- {{platformName}}</p>`;

export const passwordResetEmail: NotificationTemplate = {
  type: "password_reset",
  channel: "email",
  category: "transactional",
  render(context) {
    // No name of its own (Foundations / Brand identity; ADR 0005): platformName
    // arrives only from the dispatcher, which puts it in AFTER the row's own
    // context -- a context missing it (as in a direct render() call) throws,
    // by the renderer's own missing-variable rule.
    return {
      subject: "Reset your password",
      text: fill(TEXT, context),
      html: fillHtml(HTML, context),
    };
  },
};
