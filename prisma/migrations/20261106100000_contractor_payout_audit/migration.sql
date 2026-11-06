-- Feature 2005: who last replaced a contractor's bank details, and when.
ALTER TABLE "Contractor"
  ADD COLUMN "payoutChangedByUserId" TEXT,
  ADD COLUMN "payoutChangedAt" TIMESTAMP(3);

ALTER TABLE "Contractor"
  ADD CONSTRAINT "Contractor_payoutChangedByUserId_fkey"
  FOREIGN KEY ("payoutChangedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
