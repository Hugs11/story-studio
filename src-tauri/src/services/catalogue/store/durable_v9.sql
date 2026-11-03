-- Rebuild only source: preserve IDs and every referencing row.
CREATE TABLE source_v9 (
  id TEXT PRIMARY KEY,
  path BLOB NOT NULL,
  path_key BLOB NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('workspace','manual','import_hint','repatriated')),
  status TEXT NOT NULL CHECK (status IN ('active','removed','declined','hint')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  resolved_path BLOB
);
INSERT INTO source_v9 SELECT * FROM source;
-- source_health is the sole durable foreign key to source in v8.
-- Temporarily detach its rows so the parent rebuild cannot cascade them away.
-- Foreign keys stay enabled throughout the migration transaction.
CREATE TEMP TABLE source_health_v9 AS SELECT * FROM source_health;
DELETE FROM source_health;
DROP TABLE source;
ALTER TABLE source_v9 RENAME TO source;
INSERT INTO source_health SELECT * FROM source_health_v9;
DROP TABLE source_health_v9;
PRAGMA user_version=9;
