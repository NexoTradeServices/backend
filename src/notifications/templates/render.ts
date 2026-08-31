// The renderer -- Feature 1004, notification module.
//
// Templates are code, not rows (ADR 0002), so "rendering" is deliberately the
// smallest thing that works: named placeholders, filled from the context. A
// template engine would be a dependency bought for nothing at this size, and a
// template table is the Phase-2 change ADR 0002 already names.
import type { NotificationContext } from "../types.js";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Values are ESCAPED going into an HTML part, never into a text part.
 *
 * Everything a template interpolates arrives from somewhere a person typed:
 * Sarah's name comes off the enquiry form. Unescaped, "Bob & Sons" is already
 * invalid markup in an email the platform signs its own name to, and a name
 * carrying a tag is worse. This is the one renderer every later template will
 * use -- invoice, receipt, payout notice -- so the rule is set here.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * "Hi {{name}}" + { name: "Sarah" } -> "Hi Sarah".
 *
 * A placeholder with no variable behind it THROWS rather than rendering an
 * empty gap: a password-reset email that reaches Sarah with a blank link is
 * worse than one that never left, because it looks like it worked.
 */
export function fill(template: string, context: NotificationContext): string {
  return substitute(template, context, (value) => value);
}

/** The same, for an HTML part: every interpolated value is escaped. */
export function fillHtml(template: string, context: NotificationContext): string {
  return substitute(template, context, escapeHtml);
}

function substitute(
  template: string,
  context: NotificationContext,
  transform: (value: string) => string,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = context[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`template variable "${name}" is missing from the context`);
    }
    return transform(String(value));
  });
}
