-- Feature 6007: Correct & reissue and pay adjustments.
-- An invoice a correction made names the voided one it replaces. A pay-adjustment row gets a kind
-- (adjustment | correction) and a link to the correction it is the unswept rest of; the "above
-- zero" rule now binds adjustments only -- a correction is plus or minus, never zero.

-- CreateEnum
CREATE TYPE "PayAdjustmentKind" AS ENUM ('adjustment', 'correction');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "replacesInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "ContractorPayAdjustment" ADD COLUMN "kind" "PayAdjustmentKind" NOT NULL DEFAULT 'adjustment',
ADD COLUMN "carriedFromId" TEXT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_replacesInvoiceId_fkey" FOREIGN KEY ("replacesInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorPayAdjustment" ADD CONSTRAINT "ContractorPayAdjustment_carriedFromId_fkey" FOREIGN KEY ("carriedFromId") REFERENCES "ContractorPayAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The amount rule, by kind (Prisma has no syntax for a check constraint).
ALTER TABLE "ContractorPayAdjustment" DROP CONSTRAINT "ContractorPayAdjustment_amount_above_zero";
ALTER TABLE "ContractorPayAdjustment" ADD CONSTRAINT "ContractorPayAdjustment_amount_by_kind"
  CHECK (("kind" = 'adjustment' AND "amount" > 0) OR ("kind" = 'correction' AND "amount" <> 0));
