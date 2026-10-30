-- Feature 7003: each failed send stamps when the row may be tried next, so a backlog after an outage
-- gets its retries spread out. Rows queued before this stay null, which means due now, as before.
ALTER TABLE "Notification" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");
