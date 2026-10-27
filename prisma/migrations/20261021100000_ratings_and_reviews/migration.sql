-- Feature 6009: Ratings and reviews.
-- A review may carry the 0-10 "recommend us" score, and a job has at most one review.

-- DropIndex
DROP INDEX "Review_jobId_idx";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN "recommendScore" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Review_jobId_key" ON "Review"("jobId");
