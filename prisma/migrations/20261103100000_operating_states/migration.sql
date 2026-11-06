-- Feature 1021: operating states.
CREATE TABLE "OperatingState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT false,
    "changedAt" TIMESTAMP(3),
    "changedByUserId" TEXT,
    "testData" TEXT,

    CONSTRAINT "OperatingState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperatingState_state_key" ON "OperatingState"("state");

ALTER TABLE "OperatingState" ADD CONSTRAINT "OperatingState_changedByUserId_fkey"
  FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per state; WA is open, the rest are closed.
INSERT INTO "OperatingState" ("id", "state", "open") VALUES
  (gen_random_uuid(), 'WA', true),
  (gen_random_uuid(), 'NSW', false),
  (gen_random_uuid(), 'VIC', false),
  (gen_random_uuid(), 'QLD', false),
  (gen_random_uuid(), 'SA', false),
  (gen_random_uuid(), 'TAS', false),
  (gen_random_uuid(), 'ACT', false),
  (gen_random_uuid(), 'NT', false);

-- Every contractor so far works in WA. The column is required; a contractor made without naming a state
-- (a script, a test) works in WA - the API still requires the state on a new contractor.
ALTER TABLE "Contractor" ADD COLUMN "operatingState" TEXT NOT NULL DEFAULT 'WA';
