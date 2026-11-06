-- Feature 2004: contractor Availability.
ALTER TABLE "Contractor"
  ADD COLUMN "defaultOpening" TEXT NOT NULL DEFAULT '07:00',
  ADD COLUMN "defaultClosing" TEXT NOT NULL DEFAULT '19:00',
  ADD COLUMN "availabilitySavedAt" TIMESTAMP(3),
  ADD COLUMN "hoursNoticeSeenAt" TIMESTAMP(3);

-- Existing contractors start from the hours the business has today.
UPDATE "Contractor" SET
  "defaultOpening" = (SELECT "openingTime" FROM "PlatformSettings" LIMIT 1),
  "defaultClosing" = (SELECT "closingTime" FROM "PlatformSettings" LIMIT 1)
WHERE EXISTS (SELECT 1 FROM "PlatformSettings");

CREATE TABLE "ContractorAvailability" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "testData" TEXT,

    CONSTRAINT "ContractorAvailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContractorAvailability_contractorId_date_startTime_key"
  ON "ContractorAvailability"("contractorId", "date", "startTime");

ALTER TABLE "ContractorAvailability" ADD CONSTRAINT "ContractorAvailability_contractorId_fkey"
  FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContractorAvailability" ADD CONSTRAINT "ContractorAvailability_changedByUserId_fkey"
  FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
