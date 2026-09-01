-- Feature 1006 -- admin settings screen.
--
-- PlatformSettings.operatorEmail: the business inbox every notice the
-- platform sends the business lands at -- see Notifications / the business
-- inbox and backlog B-004. PlatformSettings already has a row on every
-- environment (dev and prod, seeded before this column existed), so it
-- backfills onto that row via DEFAULT, the same shape as the 1008 timezone
-- column. The value IS the intended real inbox, not a placeholder -- the
-- owner can change it any day on the settings screen this feature ships.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "operatorEmail" TEXT NOT NULL DEFAULT 'ops@idelta.com.au';
