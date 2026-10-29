-- Feature 3010: what the customer typed on the request (name, phone, business name) is kept on the job.
-- Older jobs stay empty.
ALTER TABLE "Job" ADD COLUMN "enquiryContact" JSONB;
