-- Generic per-field one-time passes; retain author_checked for v5 compatibility.
ALTER TABLE lunii_filled ADD COLUMN checked_fields TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(checked_fields) AND json_type(checked_fields)='array');
PRAGMA user_version=6;
