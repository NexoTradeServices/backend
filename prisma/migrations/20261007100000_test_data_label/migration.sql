-- Feature 9002 -- test data hygiene.
--
-- `testData` on every table: empty on every real record, a label (e2e, uat-<id>)
-- on test data. Nullable with no default, so no backfill.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Verification" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "ContractorAgreementVersion" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "ContractorAgreementAcceptance" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "CapabilityToken" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Contractor" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "ContractorSpecialty" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "ContractorServedPostcode" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "AssignmentTimeLog" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "AssignmentPart" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Suburb" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "ServiceType" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "ContractorSettlement" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "testData" TEXT;

-- AlterTable
ALTER TABLE "Suppression" ADD COLUMN "testData" TEXT;


-- AlterTable
ALTER TABLE "ServiceAreaPage" ADD COLUMN "testData" TEXT;
