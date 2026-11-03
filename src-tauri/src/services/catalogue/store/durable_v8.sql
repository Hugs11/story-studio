-- Last scope errors reported by an automatic reconciliation, per source, as
-- a stable fingerprint (path and reason only). NULL: never recorded, so the
-- first reconciliation reports existing errors once, then remembers them.
ALTER TABLE source_health ADD COLUMN scope_errors_fingerprint TEXT;
PRAGMA user_version=8;
