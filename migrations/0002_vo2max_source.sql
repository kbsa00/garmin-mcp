-- VO2 max now also comes from the activity FIT file (undocumented message 140). Re-process the FIT
-- of every non-strength activity once so existing history gets its VO2 max.
ALTER TABLE activities ADD COLUMN vo2max_source TEXT;
UPDATE activities SET vo2max_source = 'activity_summary' WHERE vo2max IS NOT NULL;
UPDATE activities SET fit_status = 'pending', fit_attempts = 0 WHERE type NOT LIKE '%strength%';
