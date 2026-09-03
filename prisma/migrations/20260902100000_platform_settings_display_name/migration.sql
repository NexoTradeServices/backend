-- Feature 1014 -- brand strings go to config.
--
-- PlatformSettings.displayName: the brand's display name -- screens, email
-- sender name and template signatures all read THIS, never a literal (see
-- Foundations / Brand identity; ADR 0005). PlatformSettings already has a
-- row on every environment (dev and prod, seeded before this column
-- existed), so it backfills onto that row via DEFAULT, the same shape as
-- the 1006 operatorEmail and 1008 timezone columns. The value is the
-- INTERIM wording -- undecided, never formally chosen (ADR 0005) -- the
-- owner types the real name here on the settings screen on decision day.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "displayName" TEXT NOT NULL DEFAULT 'Perth Trades & Services';
