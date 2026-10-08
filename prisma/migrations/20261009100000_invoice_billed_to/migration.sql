-- Feature 6001 -- invoice at completion.
--
-- Invoice.billedTo: { name, businessName?, address? }, copied from the customer
-- when the invoice issues. Required on new rows. No invoice exists yet, so there
-- is nothing to backfill.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "billedTo" JSONB NOT NULL;
