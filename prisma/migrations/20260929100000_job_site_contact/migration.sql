-- Feature 4008 -- site contact.
--
-- Additive only: a nullable column and a new enum value, safe on a database
-- already holding jobs and notifications -- every existing job reads "no
-- site contact". `site_contact` addresses whoever lets the contractor in,
-- named in the row's context (Notifications / the site contact).

-- AlterEnum
ALTER TYPE "NotificationRecipientType" ADD VALUE 'site_contact';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "siteContact" JSONB;
