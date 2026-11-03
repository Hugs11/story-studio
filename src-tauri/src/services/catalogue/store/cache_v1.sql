PRAGMA foreign_keys = ON;

CREATE TABLE scan (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  visited_scopes_json TEXT NOT NULL
);

CREATE TABLE observation (
  exemplar_id TEXT PRIMARY KEY,
  container_id TEXT,
  locator_key BLOB NOT NULL UNIQUE,
  content_token TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  format TEXT NOT NULL,
  internal_format TEXT,
  modified_at INTEGER,
  byte_size INTEGER,
  capabilities_json TEXT NOT NULL,
  raw_observation_json TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scan(id)
);

CREATE TABLE coverage (
  source_id TEXT NOT NULL,
  exemplar_id TEXT NOT NULL REFERENCES observation(exemplar_id),
  PRIMARY KEY (source_id, exemplar_id)
);

CREATE TABLE extracted_value (
  exemplar_id TEXT NOT NULL REFERENCES observation(exemplar_id),
  field TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  candidate_key TEXT NOT NULL,
  presence TEXT NOT NULL CHECK (presence IN ('absent','null','present')),
  validity TEXT NOT NULL
    CHECK (validity IN ('valid','empty','invalid','unknown')),
  raw_json TEXT,
  value_json TEXT,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY (exemplar_id, field, language, candidate_key)
);

CREATE TABLE suggestion (
  key TEXT PRIMARY KEY,
  participants_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL
);

CREATE TABLE suggestion_member (
  suggestion_key TEXT NOT NULL REFERENCES suggestion(key) ON DELETE CASCADE,
  fiche_id TEXT NOT NULL,
  PRIMARY KEY (suggestion_key, fiche_id)
);

-- Indexed candidates for a reliable pack sharing a title with a legacy card.
-- This avoids filtering every homonym through pack_identity on each insertion.
CREATE TABLE unidentified_title (
  fiche_id TEXT PRIMARY KEY,
  title_json TEXT NOT NULL
);
CREATE INDEX unidentified_title_lookup ON unidentified_title(title_json, fiche_id);

CREATE TABLE search_projection (
  fiche_id TEXT PRIMARY KEY,
  durable_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  normalized_text TEXT NOT NULL,
  sort_filter_json TEXT NOT NULL
);

-- Last conclusive state of each analysed file (size/date token and file
-- identity): reconciliation reanalyses only what differs from it.
CREATE TABLE file_state (
  path_key BLOB PRIMARY KEY,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_token TEXT NOT NULL,
  file_id TEXT,
  scan_id TEXT NOT NULL
);

CREATE INDEX file_state_source ON file_state(source_id);
CREATE INDEX observation_container ON observation(container_id);
CREATE INDEX observation_state_format ON observation(state, format);
CREATE INDEX coverage_exemplar ON coverage(exemplar_id);

-- Official cover thumbnails are disposable; metadata lives in catalogue.sqlite.

CREATE TABLE migration (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);
PRAGMA user_version = 1;
