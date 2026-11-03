-- Collections have been removed from the catalogue.
DROP TABLE collection_member;
DROP TABLE collection;
DELETE FROM undo_head;
DELETE FROM import_identity WHERE entity_type='collection';
UPDATE pending_import SET document_json=json_remove(document_json,'$.collections','$.collectionMembers');
PRAGMA user_version=2;
