-- Feature 1020: opening hours and public holidays.
ALTER TABLE "PlatformSettings"
  ADD COLUMN "openingTime" TEXT NOT NULL DEFAULT '07:00',
  ADD COLUMN "closingTime" TEXT NOT NULL DEFAULT '19:00',
  ADD COLUMN "openingHoursChangedAt" TIMESTAMP(3);

CREATE TABLE "PublicHoliday" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "testData" TEXT,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublicHoliday_state_date_key" ON "PublicHoliday"("state", "date");

-- WA's published dates for 2026 and 2027, from
-- https://www.wa.gov.au/service/employment/workplace-arrangements/public-holidays-western-australia
-- (page last updated 2 November 2026). Regional King's Birthday dates are not statewide and are left out.
INSERT INTO "PublicHoliday" ("id", "state", "date", "name") VALUES
  (gen_random_uuid(), 'WA', DATE '2026-01-01', 'New Year''s Day'),
  (gen_random_uuid(), 'WA', DATE '2026-01-26', 'Australia Day'),
  (gen_random_uuid(), 'WA', DATE '2026-03-02', 'Labour Day'),
  (gen_random_uuid(), 'WA', DATE '2026-04-03', 'Good Friday'),
  (gen_random_uuid(), 'WA', DATE '2026-04-05', 'Easter Sunday'),
  (gen_random_uuid(), 'WA', DATE '2026-04-06', 'Easter Monday'),
  (gen_random_uuid(), 'WA', DATE '2026-04-25', 'Anzac Day'),
  (gen_random_uuid(), 'WA', DATE '2026-04-27', 'Anzac Day'),
  (gen_random_uuid(), 'WA', DATE '2026-06-01', 'Western Australia Day'),
  (gen_random_uuid(), 'WA', DATE '2026-09-28', 'King''s Birthday'),
  (gen_random_uuid(), 'WA', DATE '2026-12-25', 'Christmas Day'),
  (gen_random_uuid(), 'WA', DATE '2026-12-26', 'Boxing Day'),
  (gen_random_uuid(), 'WA', DATE '2026-12-28', 'Boxing Day'),
  (gen_random_uuid(), 'WA', DATE '2027-01-01', 'New Year''s Day'),
  (gen_random_uuid(), 'WA', DATE '2027-01-26', 'Australia Day'),
  (gen_random_uuid(), 'WA', DATE '2027-03-01', 'Labour Day'),
  (gen_random_uuid(), 'WA', DATE '2027-03-26', 'Good Friday'),
  (gen_random_uuid(), 'WA', DATE '2027-03-28', 'Easter Sunday'),
  (gen_random_uuid(), 'WA', DATE '2027-03-29', 'Easter Monday'),
  (gen_random_uuid(), 'WA', DATE '2027-04-25', 'Anzac Day'),
  (gen_random_uuid(), 'WA', DATE '2027-04-26', 'Anzac Day'),
  (gen_random_uuid(), 'WA', DATE '2027-06-07', 'Western Australia Day'),
  (gen_random_uuid(), 'WA', DATE '2027-09-27', 'King''s Birthday'),
  (gen_random_uuid(), 'WA', DATE '2027-12-25', 'Christmas Day'),
  (gen_random_uuid(), 'WA', DATE '2027-12-26', 'Boxing Day'),
  (gen_random_uuid(), 'WA', DATE '2027-12-27', 'Christmas Day'),
  (gen_random_uuid(), 'WA', DATE '2027-12-28', 'Boxing Day');
