-- Feature 4003 -- accept / decline.
--
-- Additive only: two nullable columns, safe on a database already holding
-- assignments -- every existing assignment reads "never declined".

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN "declinedAt" TIMESTAMP(3),
ADD COLUMN "declineNote" TEXT;
