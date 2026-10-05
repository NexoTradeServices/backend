-- Feature 3003 -- enquiry photos.
--
-- `Attachment.fileName` is the name the file had on the person's device.
-- Nothing wrote the Attachment table before this feature, so the NOT NULL
-- column needs no backfill.

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "fileName" TEXT NOT NULL;
