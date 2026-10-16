-- Feature 6015 -- Home and business customers, and the invoice and refund documents.
--
-- Customer gains gstRegistered (empty = not asked). Refund gains billedTo: added nullable,
-- filled for every existing refund from its invoice's billedTo, then made required.
-- PlatformSettings gains accountsPhone (blank = the operator phone stands in).
ALTER TABLE "Customer" ADD COLUMN "gstRegistered" BOOLEAN;
ALTER TABLE "PlatformSettings" ADD COLUMN "accountsPhone" TEXT;
ALTER TABLE "Refund" ADD COLUMN "billedTo" JSONB;
UPDATE "Refund" SET "billedTo" = "Invoice"."billedTo" FROM "Invoice" WHERE "Refund"."invoiceId" = "Invoice"."id";
ALTER TABLE "Refund" ALTER COLUMN "billedTo" SET NOT NULL;
