-- Feature 1011 -- account mail to the account holder.
--
-- Additive only: a new enum value, safe on a database already holding
-- Notification rows -- existing rows keep their recipientType untouched.
-- `user` addresses the account holder's own login email (User.email),
-- whatever their role -- see Notifications / Account mail vs business mail.

-- AlterEnum
ALTER TYPE "NotificationRecipientType" ADD VALUE 'user';
