-- Feature 4002 -- dispatch to assignment, BKLG-020. No schema change: a data
-- fix only. The enquiry endpoint used to freeze the WEEKEND-MULTIPLIED rate
-- card on the job at creation; it now freezes the base card, unmultiplied
-- (Invoicing / Two-tier pricing -- rate snapshots: "what freezes is the RATE
-- CARD, never the final price"). Which price list applies is settled at
-- enquiry; whether it is a weekend job is only settled at dispatch (this
-- feature) -- so a weekend enquiry taken under the OLD code baked the
-- weekend multiplier in a year before dispatch could ever exist.
--
-- This UPDATE puts the base back on every row PROVABLY multiplied that way:
-- a web job, its preferredDate a Saturday or Sunday (a plain DATE carries no
-- zone, so EXTRACT(DOW) reads it directly), and its stored rates equal to
-- the base times the weekend multiplier, rounded, exactly. A row that fails
-- any one of those tests is left alone -- a phone-taken job, a weekday job,
-- or a row an ops price override has since touched.
UPDATE "Job" j
   SET "customerCalloutRate" = st."customerCalloutRate",
       "customerStandardRate" = st."customerStandardRate"
  FROM "ServiceType" st
 WHERE j."serviceTypeId" = st.id
   AND j.source = 'web'
   AND EXTRACT(DOW FROM j."preferredDate") IN (0, 6)
   AND j."customerCalloutRate" = ROUND(st."customerCalloutRate" * (st."serviceLevelMultipliers"->>'weekend')::numeric)
   AND j."customerStandardRate" = ROUND(st."customerStandardRate" * (st."serviceLevelMultipliers"->>'weekend')::numeric);
