-- Feature 1004 -- notification module.
--
-- Two columns the module cannot work without.
--
-- PlatformSettings.providerOverrides is the per-NOTIFICATION-TYPE exception to
-- emailProvider / smsProvider: { "password_reset": "brevo" }. Empty means every
-- type rides the default. It is what makes a provider cutover one message type
-- at a time, watched in the delivery log and rolled back by deleting one line,
-- instead of every email at once.
--
-- Notification.context holds the template variables from the moment a feature
-- asks until the dispatcher renders. Sending is async and off the request path,
-- so the caller's context has to outlive the request that supplied it; there is
-- nowhere else on the row for it to live. Reported as a design deviation in the
-- feature's change.md.

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "context" JSONB;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "providerOverrides" JSONB;
