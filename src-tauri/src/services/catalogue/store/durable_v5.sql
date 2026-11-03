-- Renew old filtered projections on the next consented catalogue access.
ALTER TABLE lunii_state ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 1;
-- A completed author pass must also remember missing authors and corrections.
ALTER TABLE lunii_filled ADD COLUMN author_checked INTEGER NOT NULL DEFAULT 0 CHECK(author_checked IN (0,1));
PRAGMA user_version=5;
