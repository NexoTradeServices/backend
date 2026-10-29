// The account offer on customer messages -- Feature 3004, guest to account.
//
// One shared piece, added by the module itself (never a copy per template) to
// the customer-audience email and text of the types below. Read from the
// customer at send time: no login yet -> "Manage your jobs online" with a Set
// your password button (the text says "Set a password" on the shorter channels
// and pages); has a password -> "Log in to see all your jobs". No amounts, per
// the message rules. Never on the enquiry confirmation (its page carries the
// offer), account mail, ops or contractor mail, or the site-contact wording.
import type { NotificationDb, NotificationChannel, NotificationContext, RenderedMessage } from "../types.js";
import { fill, fillHtml } from "./render.js";

export const OFFER_FOOTER_TYPES: ReadonlySet<string> = new Set([
  "slot_confirmed",
  "job_update",
  "job_moved",
  "job_cancelled",
  "missed_visit",
  "invoice",
  "invoice_updated",
  "callback_no_charge",
  "invoice_reminder_1",
  "invoice_reminder_2",
  "payment_receipt",
  "refund_issued",
  "review_request",
]);

export type AccountState = "guest" | "has_login";

/** Has the customer chosen a password? (A User with a credential Account row.) */
export async function accountStateOf(db: NotificationDb, customerId: string): Promise<AccountState> {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { userId: true } });
  if (customer?.userId === null || customer === null) return "guest";
  const credential = await db.account.findFirst({
    where: { userId: customer.userId, providerId: "credential" },
    select: { id: true },
  });
  return credential === null ? "guest" : "has_login";
}

const EMAIL_TEXT: Record<AccountState, string> = {
  guest: `Manage your jobs online
Create your account to view job updates, track upcoming bookings and manage your service history.

Set your password and activate your account: {{siteUrl}}/set-password`,
  has_login: "Log in to see all your jobs: {{siteUrl}}/account",
};

const EMAIL_HTML: Record<AccountState, string> = {
  guest: `<strong>Manage your jobs online</strong><br>Create your account to view job updates, track upcoming bookings and manage your service history.</p>
<p><a href="{{siteUrl}}/set-password" style="display:inline-block;padding:10px 18px;background:#1c2b3a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">Set your password and activate your account</a>`,
  has_login: `<a href="{{siteUrl}}/account">Log in to see all your jobs</a>`,
};

const SMS_TEXT: Record<AccountState, string> = {
  guest: "Track your jobs: {{siteUrl}}/set-password",
  has_login: "Your jobs: {{siteUrl}}/account",
};

/** The rendered message with the offer added, or the message as it was when this one carries none. */
export async function withOfferFooter(
  db: NotificationDb,
  row: { type: string; channel: NotificationChannel; recipientType: string; recipientId: string },
  context: NotificationContext,
  rendered: RenderedMessage,
): Promise<RenderedMessage> {
  if (!OFFER_FOOTER_TYPES.has(row.type)) return rendered;
  if (row.recipientType !== "customer" || context["audience"] === "site_contact") return rendered;
  const siteUrl = (process.env["WEB_ORIGIN"] ?? "").replace(/\/+$/, "");
  if (siteUrl === "") return rendered;
  const state = await accountStateOf(db, row.recipientId);
  const vars: NotificationContext = { siteUrl };

  if (row.channel === "sms") {
    return { ...rendered, text: `${rendered.text} ${fill(SMS_TEXT[state], vars)}` };
  }
  return {
    ...rendered,
    text: `${rendered.text}\n\n${fill(EMAIL_TEXT[state], vars)}`,
    ...(rendered.html === undefined ? {} : { html: `${rendered.html}\n<p>${fillHtml(EMAIL_HTML[state], vars)}</p>` }),
  };
}
