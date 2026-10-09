-- Feature 6003 -- Settlement run.
--
-- Contractor.gstRegistered becomes a three-way answer (empty = not asked yet). The old
-- two-way switch could not tell "no" from "never asked", so every existing false becomes
-- empty; true stays. ContractorSettlement gains the adjustments sum and the supersede audit
-- pair, with at most one draft per contractor. CapabilityToken can point at a settlement
-- (the approve link). ContractorPayAdjustment is new. A payout day still on Friday becomes
-- Wednesday (pre-launch; nobody has chosen it).

-- AlterTable
ALTER TABLE "Contractor" ALTER COLUMN "gstRegistered" DROP NOT NULL,
ALTER COLUMN "gstRegistered" DROP DEFAULT;

UPDATE "Contractor" SET "gstRegistered" = NULL WHERE "gstRegistered" = false;

-- AlterTable
ALTER TABLE "ContractorSettlement" ADD COLUMN "adjustmentsAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "supersededAt" TIMESTAMP(3),
ADD COLUMN "supersededByUserId" TEXT;

-- At most one draft per contractor (Prisma has no syntax for a partial index).
CREATE UNIQUE INDEX "ContractorSettlement_one_draft_per_contractor" ON "ContractorSettlement"("contractorId") WHERE "status" = 'draft';

-- AlterTable
ALTER TABLE "CapabilityToken" ADD COLUMN "settlementId" TEXT;

-- CreateTable
CREATE TABLE "ContractorPayAdjustment" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "jobId" TEXT,
    "settlementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "testData" TEXT,

    CONSTRAINT "ContractorPayAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContractorPayAdjustment_amount_above_zero" CHECK ("amount" > 0)
);

-- CreateIndex
CREATE INDEX "ContractorPayAdjustment_contractorId_idx" ON "ContractorPayAdjustment"("contractorId");

-- CreateIndex
CREATE INDEX "ContractorPayAdjustment_settlementId_idx" ON "ContractorPayAdjustment"("settlementId");

-- CreateIndex
CREATE INDEX "CapabilityToken_settlementId_idx" ON "CapabilityToken"("settlementId");

-- AddForeignKey
ALTER TABLE "ContractorSettlement" ADD CONSTRAINT "ContractorSettlement_supersededByUserId_fkey" FOREIGN KEY ("supersededByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityToken" ADD CONSTRAINT "CapabilityToken_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "ContractorSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorPayAdjustment" ADD CONSTRAINT "ContractorPayAdjustment_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorPayAdjustment" ADD CONSTRAINT "ContractorPayAdjustment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorPayAdjustment" ADD CONSTRAINT "ContractorPayAdjustment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "ContractorSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorPayAdjustment" ADD CONSTRAINT "ContractorPayAdjustment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Pay day: a row still on Friday becomes Wednesday.
UPDATE "PlatformSettings" SET "payoutDay" = 'wed' WHERE "payoutDay" = 'fri';
