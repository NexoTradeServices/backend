-- Feature 1008 -- time foundation.
--
-- The business clock (PlatformSettings.timezone) and the job clock
-- (Job.timezone) -- see Data Model / Time. PlatformSettings already has a row
-- on every environment (dev and prod, seeded before this column existed:
-- plan decision 2), so it backfills onto that row via DEFAULT; Job has no
-- rows yet (plan decision 1), so it is added NOT NULL with no default -- the
-- creation helper (3001) is the only writer, screens never ask.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Australia/Perth';

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "timezone" TEXT NOT NULL;
