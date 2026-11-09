-- One row per calendar date (Europe/Oslo). `data` holds the normalized DayRecovery JSON returned
-- by get_recovery; the numeric columns duplicate the fields used by metrics for cheap queries.
CREATE TABLE daily_recovery (
  date TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  hrv_last_night_ms REAL,
  hrv_status TEXT,
  hrv_balanced_low_ms REAL,
  hrv_balanced_high_ms REAL,
  resting_hr_bpm REAL,
  sleep_score REAL,
  sleep_seconds REAL,
  body_battery_at_wake REAL,
  stress_avg REAL,
  -- A row is "final" once synced on a later date than `date` (the day is complete).
  final INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL
);

CREATE TABLE activities (
  activity_id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,              -- local start date (YYYY-MM-DD)
  start_local TEXT,
  start_utc TEXT,
  type TEXT,
  name TEXT,
  distance_m REAL,
  duration_s REAL,
  moving_s REAL,
  elapsed_s REAL,
  avg_speed_mps REAL,
  max_speed_mps REAL,
  avg_hr_bpm REAL,
  max_hr_bpm REAL,
  avg_cadence_spm REAL,
  avg_power_w REAL,
  normalized_power_w REAL,
  avg_stride_length_m REAL,
  avg_vertical_oscillation_cm REAL,
  avg_vertical_ratio_percent REAL,
  elevation_gain_m REAL,
  calories REAL,
  aerobic_te REAL,
  anaerobic_te REAL,
  te_label TEXT,
  training_load REAL,
  vo2max REAL,
  lap_count INTEGER,
  -- FIT processing: 'pending' | 'done' | 'error'
  fit_status TEXT NOT NULL DEFAULT 'pending',
  fit_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX activities_date ON activities(date);
CREATE INDEX activities_fit_status ON activities(fit_status);

CREATE TABLE activity_laps (
  activity_id INTEGER NOT NULL,
  lap_index INTEGER NOT NULL,
  data TEXT NOT NULL,              -- FitLap JSON
  distance_m REAL,
  moving_s REAL,
  avg_speed_mps REAL,
  avg_hr_bpm REAL,
  PRIMARY KEY (activity_id, lap_index)
);

CREATE TABLE strength_sets (
  activity_id INTEGER NOT NULL,
  set_index INTEGER NOT NULL,
  set_type TEXT,
  category TEXT,
  exercise TEXT,
  reps INTEGER,
  weight_kg REAL,
  duration_s REAL,
  muscle_groups TEXT,              -- JSON {primary:[], secondary:[]}
  start_utc TEXT,
  PRIMARY KEY (activity_id, set_index)
);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
