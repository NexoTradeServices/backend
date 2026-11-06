-- Feature 5002: return visits.
CREATE TYPE "ReturnReasonKind" AS ENUM ('part_on_order', 'more_time_needed', 'other');

-- A block's creation time. Existing blocks take the time their booking was dispatched, so a visit already booked is never
-- mistaken for a return booked later.
ALTER TABLE "CalendarEvent" ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "CalendarEvent" ce SET "createdAt" = COALESCE(
  (SELECT a."dispatchedAt" FROM "Assignment" a WHERE a."id" = ce."assignmentId"),
  ce."startTime"
);
ALTER TABLE "CalendarEvent" ALTER COLUMN "createdAt" SET NOT NULL;
ALTER TABLE "CalendarEvent" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "ReturnReason" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "reason" "ReturnReasonKind" NOT NULL,
    "otherText" TEXT,
    "officeNote" TEXT,
    "byUserId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "testData" TEXT,
    CONSTRAINT "ReturnReason_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReturnReason_jobId_at_idx" ON "ReturnReason"("jobId", "at");
CREATE INDEX "ReturnReason_assignmentId_idx" ON "ReturnReason"("assignmentId");

ALTER TABLE "ReturnReason" ADD CONSTRAINT "ReturnReason_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnReason" ADD CONSTRAINT "ReturnReason_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReturnReason" ADD CONSTRAINT "ReturnReason_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
