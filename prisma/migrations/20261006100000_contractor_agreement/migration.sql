-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "businessAddress" JSONB,
ADD COLUMN     "legalEntityName" TEXT NOT NULL DEFAULT 'Trade Services';

-- CreateTable
CREATE TABLE "ContractorAgreementVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByUserId" TEXT NOT NULL,

    CONSTRAINT "ContractorAgreementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractorAgreementAcceptance" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "agreementVersionId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedFromIp" TEXT NOT NULL,
    "userAgent" TEXT,
    "recordStorageKey" TEXT,

    CONSTRAINT "ContractorAgreementAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContractorAgreementVersion_version_key" ON "ContractorAgreementVersion"("version");

-- CreateIndex
CREATE UNIQUE INDEX "ContractorAgreementAcceptance_contractorId_agreementVersion_key" ON "ContractorAgreementAcceptance"("contractorId", "agreementVersionId");

-- AddForeignKey
ALTER TABLE "ContractorAgreementVersion" ADD CONSTRAINT "ContractorAgreementVersion_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorAgreementAcceptance" ADD CONSTRAINT "ContractorAgreementAcceptance_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractorAgreementAcceptance" ADD CONSTRAINT "ContractorAgreementAcceptance_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "ContractorAgreementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

