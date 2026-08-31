// The template registry -- Feature 1004, notification module.
//
// One entry per `type` + channel, which is exactly the design's rule: templates
// "render each type + channel from a template + variables". A feature that
// needs to send something new adds its template file beside this one and lists
// it in BUILT_IN below -- the wording stays inside the module, and no feature
// anywhere grows message text of its own.
import type { NotificationChannel, NotificationTemplate } from "../types.js";
import { passwordResetEmail } from "./password-reset.email.js";

/** Every template this build ships. Features append; nothing else registers. */
const BUILT_IN: NotificationTemplate[] = [passwordResetEmail];

function key(type: string, channel: NotificationChannel): string {
  return `${type}:${channel}`;
}

const templates = new Map<string, NotificationTemplate>();

function loadBuiltIns(): void {
  templates.clear();
  for (const template of BUILT_IN) {
    templates.set(key(template.type, template.channel), template);
  }
}

loadBuiltIns();

export function getTemplate(
  type: string,
  channel: NotificationChannel,
): NotificationTemplate | undefined {
  return templates.get(key(type, channel));
}

/**
 * Add or replace a template at runtime.
 *
 * MODULE-INTERNAL, and the tests are its real caller: a criterion about Bob's
 * dispatch SMS or a marketing message needs those templates to exist without
 * this feature writing wording that belongs to feature 4002 or to Phase 2.
 * Nothing outside `src/notifications/` imports this -- features get their
 * template in by adding a file to BUILT_IN above.
 */
export function registerTemplate(template: NotificationTemplate): void {
  templates.set(key(template.type, template.channel), template);
}

/** Back to the shipped set. Tests call this so one file cannot leak into the next. */
export function resetTemplates(): void {
  loadBuiltIns();
}
