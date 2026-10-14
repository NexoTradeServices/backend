-- Feature 8002 -- Google-visibility fail-safe.
--
-- PlatformSettings gains approvedPublicDomain: the one host name search
-- engines may list. No default, so every existing row stays null (blank =
-- invisible); launch day types the real domain on Settings.
ALTER TABLE "PlatformSettings" ADD COLUMN "approvedPublicDomain" TEXT;
