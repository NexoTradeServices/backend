-- Feature 1002 -- suburb reference seed.
--
-- Suburb identity widens from (name, postcode) to (name, postcode, state).
-- Border towns are listed once per state and both rows are real places: TEXAS
-- 4385 is both QLD and NSW, and so are Mungindi 2406, Cottonvale 4375 and
-- Williamsdale 2620. Name and postcode alone cannot identify a suburb, so the
-- old key would reject the second half of each pair.
--
-- Safe to run against a populated table: no row anywhere carries a duplicate
-- (name, postcode, state), so the wider index cannot fail to build.

-- DropIndex
DROP INDEX "Suburb_name_postcode_key";

-- CreateIndex
CREATE UNIQUE INDEX "Suburb_name_postcode_state_key" ON "Suburb"("name", "postcode", "state");
