-- One-time repair of legacy unused labels; the migration ledger is the marker.
DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM tag_member WHERE tag_id=tag.id);
PRAGMA user_version=10;
