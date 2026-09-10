-- Feature 3001 -- enquiry form to job created. The three Job-shelf
-- corrections the design has promised since 1001 and nothing needed until
-- now: `source`, `selectedOptions`, and a `preferredDate` that is actually
-- required (BKLG-002, which also drops PreferredWindow.specific -- no
-- preferredWindow ever needed it, since "specific" was never wired to
-- anything and the enquiry form always asks for a window, never a single
-- instant).
--
-- Columns are added nullable first, backfilled, then locked to NOT NULL --
-- safe on an empty (production) database and on a dev machine that already
-- carries the three fixture jobs (JOB-1042, JOB-1051, JOB-1039) from an
-- earlier seed run, where both columns are otherwise NULL. Every job that
-- can exist before this feature came in through the fixture seed, which
-- only ever wrote guest-web-shaped rows, so backfilling `source = 'web'` is
-- exactly right, not just convenient. `src/db/seed/fixtures.ts` gives the
-- three fixtures real dates of their own going forward -- this UPDATE only
-- ever touches a database that still carries the OLD, dateless rows.

-- CreateEnum
CREATE TYPE "JobSource" AS ENUM ('web', 'phone');

-- AlterTable: source
ALTER TABLE "Job" ADD COLUMN "source" "JobSource";
UPDATE "Job" SET "source" = 'web' WHERE "source" IS NULL;
ALTER TABLE "Job" ALTER COLUMN "source" SET NOT NULL;

-- AlterTable: selectedOptions
ALTER TABLE "Job" ADD COLUMN "selectedOptions" JSONB;

-- AlterTable: preferredDate NOT NULL (BKLG-002)
UPDATE "Job" SET "preferredDate" = CURRENT_DATE WHERE "preferredDate" IS NULL;
ALTER TABLE "Job" ALTER COLUMN "preferredDate" SET NOT NULL;

-- Drop PreferredWindow.specific (BKLG-002). Postgres has no DROP VALUE, so
-- the type is rebuilt without it and the column repointed at the rebuild --
-- safe because nothing has ever written 'specific' (the enquiry form that
-- creates jobs is this same feature, and it never offers it).
ALTER TYPE "PreferredWindow" RENAME TO "PreferredWindow_old";
CREATE TYPE "PreferredWindow" AS ENUM ('morning', 'afternoon', 'evening');
ALTER TABLE "Job" ALTER COLUMN "preferredWindow" TYPE "PreferredWindow" USING ("preferredWindow"::text::"PreferredWindow");
DROP TYPE "PreferredWindow_old";
