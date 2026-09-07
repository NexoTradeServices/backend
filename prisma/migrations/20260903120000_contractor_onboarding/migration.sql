-- Feature 2001 -- contractor onboarding (Mike's path).
--
-- No behaviour, columns only (plan.md, Scope):
--   - Contractor.address moves from a required free-text column to the
--     Places json shape, optional (Data Model / Contractor; Managing the
--     contractor record). Existing rows migrate with the old text kept as
--     { street: <old text> } so nothing is silently dropped -- AC12.
--   - Contractor.coreLocation becomes optional -- it is empty until the
--     service area page (2002) is saved once (design: Contractor Workflow
--     step 2), so requiring it here was always ahead of the build order.
--   - Contractor.abn becomes optional -- [IMPL] see the schema.prisma
--     comment on the column: the Contractor record table (settled
--     03/09/26) marks it optional to save; the Data Model sketch's missing
--     "?" was never updated to match.
--   - Contractor gains emergencyContactName/.Phone, the statusChanged
--     audit pair, and agreementVersion/.AcceptedAt (empty; leaf 2006 reads
--     and writes the pair, 2001 only opens the columns).
--   - ContractorSpecialty gains its own statusChanged audit pair
--     (per-trade suspend, Managing the contractor record).

-- AlterTable: Contractor.address, TEXT NOT NULL -> JSONB, nullable.
-- The old value survives as {"street": <old text>} (AC12); an empty string
-- (never actually written by 1001's seed, but guarded anyway) is dropped
-- rather than kept as a blank object with nothing to say.
ALTER TABLE "Contractor" ADD COLUMN "address_new" JSONB;
UPDATE "Contractor"
  SET "address_new" = jsonb_build_object('street', "address")
  WHERE "address" IS NOT NULL AND "address" <> '';
ALTER TABLE "Contractor" DROP COLUMN "address";
ALTER TABLE "Contractor" RENAME COLUMN "address_new" TO "address";

-- AlterTable: Contractor.coreLocation, JSONB NOT NULL -> JSONB nullable.
ALTER TABLE "Contractor" ALTER COLUMN "coreLocation" DROP NOT NULL;

-- AlterTable: Contractor.abn, TEXT NOT NULL -> TEXT nullable.
ALTER TABLE "Contractor" ALTER COLUMN "abn" DROP NOT NULL;

-- AlterTable: Contractor -- the new columns, all optional/empty by default.
ALTER TABLE "Contractor" ADD COLUMN "emergencyContactName" TEXT;
ALTER TABLE "Contractor" ADD COLUMN "emergencyContactPhone" TEXT;
ALTER TABLE "Contractor" ADD COLUMN "statusChangedByUserId" TEXT;
ALTER TABLE "Contractor" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "Contractor" ADD COLUMN "agreementVersion" TEXT;
ALTER TABLE "Contractor" ADD COLUMN "agreementAcceptedAt" TIMESTAMP(3);

ALTER TABLE "Contractor" ADD CONSTRAINT "Contractor_statusChangedByUserId_fkey"
  FOREIGN KEY ("statusChangedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: ContractorSpecialty -- its own audit pair.
ALTER TABLE "ContractorSpecialty" ADD COLUMN "statusChangedByUserId" TEXT;
ALTER TABLE "ContractorSpecialty" ADD COLUMN "statusChangedAt" TIMESTAMP(3);

ALTER TABLE "ContractorSpecialty" ADD CONSTRAINT "ContractorSpecialty_statusChangedByUserId_fkey"
  FOREIGN KEY ("statusChangedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
