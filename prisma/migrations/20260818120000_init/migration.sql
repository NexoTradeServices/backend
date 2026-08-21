-- Feature 1001 -- Prisma schema, migrations, sequences and seed.
-- Plan: project/delivery/1001-schema-and-seed/plan.md
-- Design: project/design/trades-platform-design.md (Data Model)
--
-- Authored with `prisma migrate diff --from-empty --to-schema`, then extended by
-- hand with the two things the datamodel cannot express: the PostGIS extension
-- and the six human-readable reference/code sequences.

-- PostGIS from day one (setup/01-dev-environment.md): service-area chips and the
-- operator's distance number are PostGIS queries, so the extension belongs in the
-- very first migration rather than a later one for no reason.
--
-- READ THIS BEFORE TRUSTING THE LINE BELOW. It does NOT provision PostGIS on the
-- dev or test databases, and no test here proves that it can. `tradeservice` is
-- deliberately not a superuser (setup/01), and Postgres refuses `CREATE EXTENSION
-- postgis` to a non-superuser -- verified: "permission denied to create extension
-- postgis, HINT: Must be superuser to create this extension." On .40 both
-- databases already carry the extension, installed by hand as a superuser by
-- setup/01, so IF NOT EXISTS makes this a silent no-op rather than an error.
--
-- So PostGIS is a PRECONDITION of migrating, not a product of it. Every
-- environment must have it before `migrate deploy` runs: setup/01 does that on
-- .40, setup/03 does it on Neon. The statement is kept because it is the correct
-- and sufficient thing wherever the migrating role IS allowed to create
-- extensions (Neon grants ordinary roles exactly that), and because it states the
-- dependency where a reader of the schema will find it.
--
-- The guard that IS real: tests/postgis.test.ts fails loudly, naming setup/01, on
-- any database reached without the extension. See review finding R1.5.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('customer', 'contractor', 'ops', 'owner');

-- CreateEnum
CREATE TYPE "PayoutCycle" AS ENUM ('weekly', 'fortnightly');

-- CreateEnum
CREATE TYPE "PayoutDay" AS ENUM ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');

-- CreateEnum
CREATE TYPE "CapabilityTokenType" AS ENUM ('respond', 'track', 'review', 'approve');

-- CreateEnum
CREATE TYPE "ContractorStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "CalendarEventType" AS ENUM ('job', 'unavailable', 'break', 'time-off');

-- CreateEnum
CREATE TYPE "PreferredWindow" AS ENUM ('morning', 'afternoon', 'evening', 'specific');

-- CreateEnum
CREATE TYPE "ServiceLevel" AS ENUM ('normal', 'emergency', 'weekend');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('new', 'assigned', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "CancelReason" AS ENUM ('customer_changed_mind', 'customer_no_show', 'no_coverage', 'duplicate', 'price', 'other');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('assigned', 'accepted', 'in_progress', 'completed', 'declined', 'cancelled');

-- CreateEnum
CREATE TYPE "PartSuppliedBy" AS ENUM ('contractor', 'platform');

-- CreateEnum
CREATE TYPE "UploadedByRole" AS ENUM ('customer', 'contractor', 'ops');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('sent', 'paid', 'void');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('labour', 'part', 'callout');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('draft', 'approved', 'paid', 'superseded');

-- CreateEnum
CREATE TYPE "NotificationRecipientType" AS ENUM ('customer', 'contractor', 'ops');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('transactional', 'marketing');

-- CreateEnum
CREATE TYPE "NotificationRelatedType" AS ENUM ('job', 'assignment', 'invoice', 'payment', 'refund', 'settlement', 'contractor', 'customer', 'user');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('unsubscribed', 'bounced', 'stopped');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
    "gstStatusChangedAt" TIMESTAMP(3),
    "gstStatusChangedByUserId" TEXT,
    "businessAbn" TEXT,
    "gstRatePercent" DECIMAL(5,2) NOT NULL,
    "paymentTermsDays" INTEGER NOT NULL,
    "serviceReachKm" DOUBLE PRECISION NOT NULL,
    "calloutFee" INTEGER NOT NULL,
    "returnVisitMinimumMinutes" INTEGER NOT NULL,
    "maxContractorPartAmount" INTEGER NOT NULL,
    "operatorPhone" TEXT NOT NULL,
    "payoutCycle" "PayoutCycle" NOT NULL,
    "payoutDay" "PayoutDay",
    "emailProvider" TEXT NOT NULL,
    "smsProvider" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "type" "CapabilityTokenType" NOT NULL,
    "jobId" TEXT,
    "assignmentId" TEXT,
    "singleUse" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapabilityToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "billingAddress" JSONB,
    "stripeCustomerId" TEXT,
    "defaultPaymentMethodId" TEXT,
    "savedPaymentMethodIds" TEXT[],
    "marketingConsent" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contractor" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessName" TEXT,
    "abn" TEXT NOT NULL,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "coreLocation" JSONB NOT NULL,
    "lastRadiusKm" DOUBLE PRECISION,
    "insurer" TEXT,
    "insurancePolicyNo" TEXT,
    "insuranceExpiry" DATE,
    "payoutBsb" TEXT,
    "payoutAccountNo" TEXT,
    "payoutAccountName" TEXT,
    "status" "ContractorStatus" NOT NULL DEFAULT 'active',
    "averageRating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contractor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractorSpecialty" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "contractorCalloutRate" INTEGER NOT NULL,
    "contractorStandardRate" INTEGER NOT NULL,
    "licenceNumber" TEXT NOT NULL,
    "licenceExpiry" DATE NOT NULL,
    "status" "ContractorStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "ContractorSpecialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractorServedPostcode" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,

    CONSTRAINT "ContractorServedPostcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "reviewText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "type" "CalendarEventType" NOT NULL,
    "jobId" TEXT,
    "assignmentId" TEXT,
    "notes" TEXT,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "parentJobId" TEXT,
    "customerId" TEXT NOT NULL,
    "serviceTypeId" TEXT NOT NULL,
    "customerCalloutRate" INTEGER NOT NULL,
    "customerStandardRate" INTEGER NOT NULL,
    "postcode" TEXT NOT NULL,
    "serviceLocation" JSONB NOT NULL,
    "siteAddress" JSONB,
    "description" TEXT,
    "preferredWindow" "PreferredWindow" NOT NULL,
    "preferredDate" DATE,
    "serviceLevel" "ServiceLevel",
    "status" "JobStatus" NOT NULL DEFAULT 'new',
    "operatorNotes" JSONB,
    "cancelReason" "CancelReason",
    "cancelNote" TEXT,
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'assigned',
    "callbackChargeable" BOOLEAN,
    "proposedSlot" TIMESTAMP(3),
    "confirmedSlot" TIMESTAMP(3),
    "billedHours" DECIMAL(6,2),
    "completionNotes" TEXT,
    "customerCalloutRate" INTEGER,
    "customerStandardRate" INTEGER,
    "contractorCalloutRate" INTEGER,
    "contractorStandardRate" INTEGER,
    "serviceLevel" "ServiceLevel",
    "customerTotal" INTEGER,
    "contractorPay" INTEGER,
    "materialsReimbursement" INTEGER,
    "ratingAtDispatch" DOUBLE PRECISION,
    "invoiceId" TEXT,
    "settlementId" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentTimeLog" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentTimeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentPart" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "suppliedBy" "PartSuppliedBy" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(10,2) NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "receiptAttachmentId" TEXT,
    "quoteAcceptNote" TEXT,

    CONSTRAINT "AssignmentPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "uploadedByRole" "UploadedByRole" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suburb" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "centroidLat" DOUBLE PRECISION NOT NULL,
    "centroidLng" DOUBLE PRECISION NOT NULL,
    "seo" JSONB,

    CONSTRAINT "Suburb_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceType" (
    "id" TEXT NOT NULL,
    "trade" TEXT NOT NULL,
    "slug" TEXT,
    "customerCalloutRate" INTEGER NOT NULL,
    "customerStandardRate" INTEGER NOT NULL,
    "serviceLevelMultipliers" JSONB NOT NULL,
    "prefilledFields" JSONB NOT NULL,
    "seo" JSONB,

    CONSTRAINT "ServiceType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "labourAmount" INTEGER NOT NULL,
    "materialsAmount" INTEGER NOT NULL,
    "gstAmount" INTEGER,
    "gstApplied" BOOLEAN NOT NULL,
    "isZeroDollar" BOOLEAN NOT NULL DEFAULT false,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'sent',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "stripePaymentLinkUrl" TEXT,
    "stripePaymentLinkId" TEXT,
    "voidReason" TEXT,
    "voidedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "paymentId" TEXT,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "stripeRefundId" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractorSettlement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "breakdownByTrade" JSONB NOT NULL,
    "materialsAmount" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "gstAmount" INTEGER,
    "contractorGstRegistered" BOOLEAN,
    "status" "SettlementStatus" NOT NULL DEFAULT 'draft',
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paidByUserId" TEXT,
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractorSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientType" "NotificationRecipientType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "type" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "relatedType" "NotificationRelatedType",
    "relatedId" TEXT,
    "jobId" TEXT,
    "provider" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'queued',
    "providerMessageId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "address" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAreaPage" (
    "id" TEXT NOT NULL,
    "serviceTypeId" TEXT NOT NULL,
    "suburbId" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "introText" TEXT,

    CONSTRAINT "ServiceAreaPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityToken_tokenHash_key" ON "CapabilityToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CapabilityToken_jobId_idx" ON "CapabilityToken"("jobId");

-- CreateIndex
CREATE INDEX "CapabilityToken_assignmentId_idx" ON "CapabilityToken"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_userId_key" ON "Customer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Contractor_code_key" ON "Contractor"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Contractor_userId_key" ON "Contractor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorSpecialty_contractorId_trade_key" ON "ContractorSpecialty"("contractorId", "trade");

-- CreateIndex
CREATE INDEX "ContractorServedPostcode_postcode_idx" ON "ContractorServedPostcode"("postcode");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorServedPostcode_contractorId_postcode_key" ON "ContractorServedPostcode"("contractorId", "postcode");

-- CreateIndex
CREATE INDEX "Review_jobId_idx" ON "Review"("jobId");

-- CreateIndex
CREATE INDEX "Review_contractorId_idx" ON "Review"("contractorId");

-- CreateIndex
CREATE INDEX "CalendarEvent_contractorId_startTime_idx" ON "CalendarEvent"("contractorId", "startTime");

-- CreateIndex
CREATE INDEX "CalendarEvent_assignmentId_idx" ON "CalendarEvent"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_reference_key" ON "Job"("reference");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_postcode_idx" ON "Job"("postcode");

-- CreateIndex
CREATE INDEX "Job_customerId_idx" ON "Job"("customerId");

-- CreateIndex
CREATE INDEX "Job_parentJobId_idx" ON "Job"("parentJobId");

-- CreateIndex
CREATE INDEX "Assignment_jobId_idx" ON "Assignment"("jobId");

-- CreateIndex
CREATE INDEX "Assignment_contractorId_idx" ON "Assignment"("contractorId");

-- CreateIndex
CREATE INDEX "Assignment_settlementId_idx" ON "Assignment"("settlementId");

-- CreateIndex
CREATE INDEX "AssignmentTimeLog_assignmentId_idx" ON "AssignmentTimeLog"("assignmentId");

-- CreateIndex
CREATE INDEX "AssignmentPart_assignmentId_idx" ON "AssignmentPart"("assignmentId");

-- CreateIndex
CREATE INDEX "Attachment_jobId_idx" ON "Attachment"("jobId");

-- CreateIndex
CREATE INDEX "Attachment_assignmentId_idx" ON "Attachment"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Suburb_slug_key" ON "Suburb"("slug");

-- CreateIndex
CREATE INDEX "Suburb_postcode_idx" ON "Suburb"("postcode");

-- CreateIndex
CREATE UNIQUE INDEX "Suburb_name_postcode_key" ON "Suburb"("name", "postcode");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceType_trade_key" ON "ServiceType"("trade");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_reference_key" ON "Invoice"("reference");

-- CreateIndex
CREATE INDEX "Invoice_jobId_idx" ON "Invoice"("jobId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_reference_key" ON "Refund"("reference");

-- CreateIndex
CREATE INDEX "Refund_invoiceId_idx" ON "Refund"("invoiceId");

-- CreateIndex
CREATE INDEX "Refund_customerId_idx" ON "Refund"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorSettlement_reference_key" ON "ContractorSettlement"("reference");

-- CreateIndex
CREATE INDEX "ContractorSettlement_contractorId_idx" ON "ContractorSettlement"("contractorId");

-- CreateIndex
CREATE INDEX "ContractorSettlement_status_idx" ON "ContractorSettlement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Notification_jobId_idx" ON "Notification"("jobId");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_channel_address_key" ON "Suppression"("channel", "address");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAreaPage_serviceTypeId_suburbId_key" ON "ServiceAreaPage"("serviceTypeId", "suburbId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_gstStatusChangedByUserId_fkey" FOREIGN KEY ("gstStatusChangedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityToken" ADD CONSTRAINT "CapabilityToken_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityToken" ADD CONSTRAINT "CapabilityToken_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contractor" ADD CONSTRAINT "Contractor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorSpecialty" ADD CONSTRAINT "ContractorSpecialty_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorServedPostcode" ADD CONSTRAINT "ContractorServedPostcode_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "ContractorSpecialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "ContractorSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTimeLog" ADD CONSTRAINT "AssignmentTimeLog_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPart" ADD CONSTRAINT "AssignmentPart_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPart" ADD CONSTRAINT "AssignmentPart_receiptAttachmentId_fkey" FOREIGN KEY ("receiptAttachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorSettlement" ADD CONSTRAINT "ContractorSettlement_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorSettlement" ADD CONSTRAINT "ContractorSettlement_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAreaPage" ADD CONSTRAINT "ServiceAreaPage_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAreaPage" ADD CONSTRAINT "ServiceAreaPage_suburbId_fkey" FOREIGN KEY ("suburbId") REFERENCES "Suburb"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Human-readable reference / code sequences
--
-- One independent Postgres sequence per prefix. nextval() is transaction-safe
-- and never hands the same number to two callers, which is exactly what a
-- document number needs; values are not reused on rollback, and that is correct
-- for tax documents (a gap is fine, a duplicate is not).
--
-- START values sit PAST the cast (project/design/cast.md) so seeded fixture
-- codes can never collide with generated ones. Mirrored in
-- src/config/references.ts -- change both together.
-- ---------------------------------------------------------------------------

-- Job.reference        JOB-  cast holds JOB-1042
CREATE SEQUENCE "job_reference_seq" AS bigint START WITH 1043 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
-- Invoice.reference    INV-  cast holds INV-2041
CREATE SEQUENCE "invoice_reference_seq" AS bigint START WITH 2042 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
-- ContractorSettlement.reference  CINV-  cast holds CINV-517
CREATE SEQUENCE "settlement_reference_seq" AS bigint START WITH 518 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
-- Refund.reference     CN-   credit note / ATO adjustment note
CREATE SEQUENCE "refund_reference_seq" AS bigint START WITH 1001 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
-- Customer.code        CUS-  cast holds CUS-1050
CREATE SEQUENCE "customer_code_seq" AS bigint START WITH 1051 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
-- Contractor.code      CON-  cast holds CON-014, CON-021, CON-030
CREATE SEQUENCE "contractor_code_seq" AS bigint START WITH 31 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
