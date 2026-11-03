PRAGMA foreign_keys = ON;

CREATE TABLE catalogue (
  id TEXT PRIMARY KEY,
  sources_revision INTEGER NOT NULL DEFAULT 0 CHECK (sources_revision >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  -- Official cover retention advances notifications without changing authored data.
  cover_revision INTEGER NOT NULL DEFAULT 0 CHECK (cover_revision >= 0)
);

-- Internal fill tool, intentionally excluded from portable backup.
CREATE TABLE lunii_pack (uuid TEXT PRIMARY KEY, document_json TEXT NOT NULL);
CREATE TABLE lunii_state (id INTEGER PRIMARY KEY CHECK(id=1), cached_at INTEGER NOT NULL, source TEXT NOT NULL);
CREATE TABLE lunii_context (id INTEGER PRIMARY KEY CHECK(id=1), locale TEXT NOT NULL);
INSERT INTO lunii_context VALUES (1,'');
CREATE TABLE lunii_permission (id INTEGER PRIMARY KEY CHECK(id=1), allowed INTEGER CHECK(allowed IN (0,1)));
INSERT INTO lunii_permission VALUES (1,NULL);
CREATE TABLE lunii_automatic (id INTEGER PRIMARY KEY CHECK(id=1), attempted_at INTEGER);
INSERT INTO lunii_automatic VALUES (1,NULL);

CREATE TABLE migration (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  path BLOB NOT NULL,
  path_key BLOB NOT NULL UNIQUE,
  origin TEXT NOT NULL
    CHECK (origin IN ('workspace','manual','import_hint')),
  status TEXT NOT NULL
    CHECK (status IN ('active','removed','declined','hint')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  -- Path resolved through its links at the last background resolution;
  -- listings read it instead of probing a possibly hung volume. NULL until
  -- the first resolution (the stored path is then used as is).
  resolved_path BLOB
);

-- Every workspace root ever seen: role exclusions of former workspaces must
-- survive cache purges and workspace changes, or their technical folders
-- would be indexed again.
CREATE TABLE workspace_root (
  id TEXT PRIMARY KEY,
  path BLOB NOT NULL,
  path_key BLOB NOT NULL UNIQUE,
  first_seen_at INTEGER NOT NULL,
  last_current_at INTEGER NOT NULL
);

CREATE TABLE fiche (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

CREATE TABLE lunii_filled (fiche_id TEXT PRIMARY KEY REFERENCES fiche(id) ON DELETE CASCADE);

CREATE TABLE fiche_forgotten (
  fiche_id TEXT PRIMARY KEY REFERENCES fiche(id)
);

CREATE TABLE fiche_grouping (
  fiche_id TEXT PRIMARY KEY REFERENCES fiche(id),
  target_id TEXT NOT NULL REFERENCES fiche(id)
);

CREATE TABLE pack_identity (
  pack_uuid TEXT PRIMARY KEY,
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  provenance_json TEXT NOT NULL,
  CHECK (length(pack_uuid) = 36)
);
CREATE INDEX identity_fiche ON pack_identity(fiche_id);

CREATE TABLE container (
  id TEXT PRIMARY KEY,
  anchor_json TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1))
);

CREATE TABLE exemplar (
  id TEXT PRIMARY KEY,
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  container_id TEXT REFERENCES container(id),
  anchor_json TEXT NOT NULL,
  verified_uuid TEXT,
  proof_json TEXT NOT NULL,
  content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1)),
  -- Date the exemplar joined the catalogue (Unix seconds).
  created_at INTEGER
);
CREATE INDEX exemplar_fiche ON exemplar(fiche_id);
CREATE INDEX exemplar_container ON exemplar(container_id);
-- Expression indexes: anchor lookups must use exactly these expressions.
CREATE INDEX exemplar_anchor_path ON exemplar(json_extract(anchor_json,'$.pathKey'));
CREATE INDEX exemplar_anchor_member ON exemplar(json_extract(anchor_json,'$.memberKey'));
CREATE INDEX container_anchor_path ON container(json_extract(anchor_json,'$.pathKey'));

CREATE TABLE image_asset (
  sha256 TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  relative_path TEXT NOT NULL UNIQUE
);

CREATE TABLE provenance (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('file','project','filename','manual','web','import','lunii')),
  exemplar_id TEXT REFERENCES exemplar(id),
  locator_json TEXT,
  url TEXT,
  language TEXT,
  retrieved_at INTEGER,
  raw_json TEXT,
  diagnostic_json TEXT
);

CREATE TABLE reference_source (
  fiche_id TEXT PRIMARY KEY REFERENCES fiche(id),
  exemplar_id TEXT NOT NULL REFERENCES exemplar(id),
  selected_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

CREATE TABLE reference_value (
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  field TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  image_sha256 TEXT REFERENCES image_asset(sha256),
  PRIMARY KEY (fiche_id, field, language)
);

CREATE INDEX reference_title ON reference_value(field, value_json, fiche_id);

CREATE TABLE correction (
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  field TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('defined','cleared','source')),
  value_json TEXT,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  image_sha256 TEXT REFERENCES image_asset(sha256),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (fiche_id, field, language),
  CHECK (
    (state = 'defined' AND value_json IS NOT NULL) OR
    (state IN ('cleared','source') AND value_json IS NULL)
  ),
  CHECK (state = 'defined' OR image_sha256 IS NULL)
);

CREATE TABLE collection (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  normalized_label TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

CREATE TABLE collection_member (
  collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  PRIMARY KEY (collection_id, fiche_id)
);
CREATE INDEX collection_member_fiche ON collection_member(fiche_id);

CREATE TABLE tag (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  normalized_label TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE UNIQUE INDEX tag_lookup ON tag(normalized_label);

CREATE TABLE tag_member (
  tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  PRIMARY KEY (tag_id, fiche_id)
);
CREATE INDEX tag_member_fiche ON tag_member(fiche_id);
-- Portable source evidence belongs to the validated membership, not the label.
CREATE TABLE enrichment_tag_origin (
  tag_id TEXT NOT NULL,
  fiche_id TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY (tag_id, fiche_id),
  FOREIGN KEY (tag_id, fiche_id) REFERENCES tag_member(tag_id, fiche_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE operation (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared','running','committed','failed','cancelled','undone')
  ),
  request_key TEXT NOT NULL UNIQUE,
  expected_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  recovery_json TEXT
);

-- A purged/undone head never makes an older operation eligible again.
CREATE TABLE undo_head (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  operation_id TEXT NOT NULL
);

CREATE TABLE association_event (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operation(id),
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL
);

CREATE TABLE operation_change (
  operation_id TEXT NOT NULL REFERENCES operation(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  post_revision INTEGER NOT NULL,
  PRIMARY KEY (operation_id, entity_type, entity_id)
);

CREATE TABLE suggestion_decision (
  key TEXT PRIMARY KEY,
  participants_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted','refused')),
  operation_id TEXT NOT NULL REFERENCES operation(id)
);

CREATE TABLE import_identity (
  origin_catalogue_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  origin_entity_id TEXT NOT NULL,
  local_entity_id TEXT NOT NULL,
  last_imported_json TEXT NOT NULL,
  PRIMARY KEY (origin_catalogue_id, entity_type, origin_entity_id)
);

CREATE TABLE import_receipt (
  archive_digest TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operation(id),
  result_json TEXT NOT NULL
);

-- Successful legacy-project saves awaiting identity publication. A receipt
-- is verified against the final file and consumed in the publication transaction.
CREATE TABLE exemplar_file_state (
  exemplar_id TEXT PRIMARY KEY REFERENCES exemplar(id),
  file_id TEXT
);

CREATE TABLE identity_convergence (
  exemplar_id TEXT PRIMARY KEY REFERENCES exemplar(id),
  known_fiche_id TEXT NOT NULL REFERENCES fiche(id),
  pack_uuid TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE save_receipt (
  path_key BLOB PRIMARY KEY,
  receipt_json TEXT NOT NULL
);

CREATE TABLE generation_receipt (
  id TEXT PRIMARY KEY,
  project_exemplar_id TEXT NOT NULL REFERENCES exemplar(id),
  output_exemplar_id TEXT NOT NULL REFERENCES exemplar(id),
  generated_project_token TEXT NOT NULL,
  output_content_token TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  evidence_json TEXT NOT NULL
);

-- Source scan health survives reopening; operation reports remain session-only.
CREATE TABLE source_health (
  source_id TEXT PRIMARY KEY REFERENCES source(id) ON DELETE CASCADE,
  last_scan_at INTEGER,
  last_scan_status TEXT,
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('available','unavailable','unknown'))
);

-- File mutation receipts and recovery evidence survive application restart.
CREATE TABLE file_operation (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);
CREATE TABLE file_journal (
  id TEXT PRIMARY KEY,
  evidence_json TEXT NOT NULL
);
-- Only unfinished operations participate in association reservations.
CREATE INDEX file_journal_pending ON file_journal(id)
 WHERE json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END,'$.stage') NOT IN ('complete','failed','rolledBack');
-- Verified direct-pack publications retain their card without a UUID.
CREATE TABLE file_publication (
  path_key TEXT PRIMARY KEY,
  source_token TEXT NOT NULL,
  fiche_id TEXT NOT NULL REFERENCES fiche(id),
  exemplar_id TEXT NOT NULL,
  mode TEXT NOT NULL
);
-- Identity association finalization shares the file journal's durable operation id.
CREATE TABLE file_identity_receipt (
  journal_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL
);
CREATE TABLE project_metadata_operation (
 id TEXT PRIMARY KEY,
 request_id TEXT UNIQUE,
 state TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 receipt_json TEXT
);
CREATE INDEX project_metadata_pending ON project_metadata_operation(id)
 WHERE state IN ('saving','publishing','published');
CREATE TABLE project_session_origin (work_id TEXT NOT NULL,path_key TEXT NOT NULL,file_id TEXT,PRIMARY KEY(work_id,path_key));
PRAGMA user_version = 1;

-- Verified conversion provenance; projected UUIDs do not identify native sources.
CREATE TABLE file_conversion (
  path_key TEXT PRIMARY KEY,
  source_token TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);

-- Complete portable documents retain evidence that cannot be associated safely.
CREATE TABLE pending_import (
 origin_catalogue_id TEXT NOT NULL,
 archive_digest TEXT PRIMARY KEY,
 document_json TEXT NOT NULL
);
CREATE TABLE import_reference (
 fiche_id TEXT PRIMARY KEY REFERENCES fiche(id),
 reference_json TEXT NOT NULL
);
-- Backup identity evidence is distinct from a locally verified file identity.
CREATE TABLE saved_pack_identity (
 pack_uuid TEXT PRIMARY KEY,
 fiche_id TEXT NOT NULL REFERENCES fiche(id),
 provenance_json TEXT NOT NULL
);

-- Publication intent survives interruption between exclusive archive moves.
CREATE TABLE backup_publication (
    id TEXT PRIMARY KEY,
    evidence_json TEXT NOT NULL
);

-- Removal evidence is reconciled after interruption, never destructively replayed.
CREATE TABLE file_removal (
    id TEXT PRIMARY KEY,
    evidence_json TEXT NOT NULL,
    state TEXT NOT NULL
);

CREATE TABLE lunii_image_attempt (fiche_id TEXT PRIMARY KEY REFERENCES fiche(id) ON DELETE CASCADE, failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3));

-- Local official cover links awaiting a permitted fill, not network requests.
CREATE TABLE lunii_pending_cover (
  fiche_id TEXT NOT NULL REFERENCES fiche(id) ON DELETE CASCADE,
  pack_uuid TEXT NOT NULL,
  cover_key TEXT NOT NULL,
  image_path TEXT NOT NULL,
  image_sha256 TEXT NOT NULL REFERENCES image_asset(sha256),
  PRIMARY KEY (fiche_id, pack_uuid, cover_key, image_path)
);
