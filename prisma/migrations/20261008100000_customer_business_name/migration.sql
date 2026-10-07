-- Feature 1017 -- business customers.
--
-- The customer's business name (the invoice is addressed to it) and the ABN,
-- held for later. Both nullable with no default, so no backfill.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "businessName" TEXT,
ADD COLUMN "abn" TEXT;
