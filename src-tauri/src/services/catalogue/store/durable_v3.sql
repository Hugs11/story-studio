-- Restore UUID-only cards after retirement of manual grouping. Personal data
-- stays on the original card, assigned to its oldest identified exemplar.
CREATE TEMP TABLE menage_partition AS
SELECT e.id AS exemplar_id,e.fiche_id AS old_card,
       COALESCE(e.verified_uuid,'exemplar:' || e.id) AS identity_key,
       e.created_at
FROM exemplar e
UNION ALL
SELECT NULL,p.fiche_id,p.pack_uuid,NULL FROM pack_identity p
WHERE NOT EXISTS(SELECT 1 FROM exemplar e WHERE e.fiche_id=p.fiche_id AND e.verified_uuid=p.pack_uuid)
UNION ALL
SELECT NULL,p.fiche_id,p.pack_uuid,NULL FROM saved_pack_identity p
WHERE NOT EXISTS(SELECT 1 FROM exemplar e WHERE e.fiche_id=p.fiche_id AND e.verified_uuid=p.pack_uuid)
  AND NOT EXISTS(SELECT 1 FROM pack_identity i WHERE i.pack_uuid=p.pack_uuid AND i.fiche_id=p.fiche_id);
CREATE UNIQUE INDEX menage_exemplar ON menage_partition(exemplar_id);
CREATE INDEX menage_card ON menage_partition(old_card,created_at,exemplar_id);
CREATE TEMP TABLE menage_keeper AS
SELECT f.id AS old_card,
       COALESCE((SELECT p.identity_key FROM menage_partition p JOIN fiche local ON local.id=p.old_card
                 WHERE p.old_card=f.id AND p.identity_key NOT LIKE 'exemplar:%'
                 ORDER BY p.exemplar_id IS NULL,COALESCE(p.created_at,local.created_at),p.identity_key,p.exemplar_id LIMIT 1),
                (SELECT p.identity_key FROM menage_partition p JOIN fiche local ON local.id=p.old_card WHERE p.old_card=f.id
                 ORDER BY COALESCE(p.created_at,local.created_at),p.exemplar_id LIMIT 1)) AS identity_key
FROM fiche f;
CREATE UNIQUE INDEX menage_keeper_card ON menage_keeper(old_card);
CREATE TEMP TABLE menage_destination AS
SELECT p.old_card,p.identity_key,
       CASE WHEN p.identity_key=k.identity_key THEN p.old_card
            ELSE 'menage-' || lower(hex(randomblob(16))) END AS new_card
FROM menage_partition p JOIN menage_keeper k ON k.old_card=p.old_card
GROUP BY p.old_card,p.identity_key;
CREATE UNIQUE INDEX menage_destination_identity ON menage_destination(old_card,identity_key);
INSERT INTO fiche
SELECT d.new_card,MIN(COALESCE(p.created_at,f.created_at)),0,0
FROM menage_destination d JOIN fiche f ON f.id=d.old_card
JOIN menage_partition p ON p.old_card=d.old_card AND p.identity_key=d.identity_key
WHERE d.new_card<>d.old_card GROUP BY d.new_card;
UPDATE exemplar SET fiche_id=(SELECT d.new_card FROM menage_partition p
 JOIN menage_destination d ON d.old_card=p.old_card AND d.identity_key=p.identity_key
 WHERE p.exemplar_id=exemplar.id)
WHERE id IN (SELECT p.exemplar_id FROM menage_partition p JOIN menage_destination d
 ON d.old_card=p.old_card AND d.identity_key=p.identity_key WHERE d.new_card<>d.old_card);
UPDATE pack_identity SET fiche_id=(SELECT d.new_card FROM menage_destination d
 WHERE d.old_card=pack_identity.fiche_id AND d.identity_key=pack_identity.pack_uuid)
WHERE EXISTS (SELECT 1 FROM menage_destination d WHERE d.old_card=pack_identity.fiche_id
 AND d.identity_key=pack_identity.pack_uuid AND d.new_card<>d.old_card);
UPDATE saved_pack_identity SET fiche_id=(SELECT d.new_card FROM menage_destination d
 WHERE d.old_card=saved_pack_identity.fiche_id AND d.identity_key=saved_pack_identity.pack_uuid)
WHERE EXISTS (SELECT 1 FROM menage_destination d WHERE d.old_card=saved_pack_identity.fiche_id
 AND d.identity_key=saved_pack_identity.pack_uuid AND d.new_card<>d.old_card);
-- Accepted values follow their exemplar, including when its disk/cache is absent.
-- Keep the original provenance, image and reference selection receipts intact.
UPDATE reference_value SET fiche_id=(SELECT e.fiche_id FROM reference_source r
 JOIN exemplar e ON e.id=r.exemplar_id WHERE r.fiche_id=reference_value.fiche_id)
WHERE fiche_id IN (SELECT r.fiche_id FROM reference_source r JOIN exemplar e ON e.id=r.exemplar_id
 WHERE r.fiche_id<>e.fiche_id);
UPDATE reference_source SET fiche_id=(SELECT e.fiche_id FROM exemplar e
 WHERE e.id=reference_source.exemplar_id)
WHERE fiche_id IN (SELECT old_card FROM menage_destination WHERE new_card<>old_card);
-- Only empty historical aliases remain hidden. A detached card is visible.
DELETE FROM fiche_grouping WHERE fiche_id IN
 (SELECT new_card FROM menage_destination WHERE old_card IN
  (SELECT old_card FROM menage_destination WHERE new_card<>old_card));
DELETE FROM identity_convergence WHERE exemplar_id IN
 (SELECT p.exemplar_id FROM menage_partition p JOIN menage_destination d
  ON d.old_card=p.old_card AND d.identity_key=p.identity_key WHERE d.new_card<>d.old_card);
-- These undo receipts could restore an association prohibited by the new rule.
DELETE FROM undo_head WHERE operation_id IN
 (SELECT id FROM operation WHERE kind IN ('groupCards','splitCard','applyEnrichment','resolveSuggestion','importGroup'))
 AND EXISTS (SELECT 1 FROM menage_destination WHERE new_card<>old_card);
DELETE FROM suggestion_decision WHERE EXISTS
 (SELECT 1 FROM menage_destination WHERE new_card<>old_card);
UPDATE fiche SET revision=revision+1 WHERE id IN
 (SELECT old_card FROM menage_destination WHERE new_card<>old_card);
UPDATE catalogue SET revision=revision+1 WHERE EXISTS
 (SELECT 1 FROM menage_destination WHERE new_card<>old_card);
DROP TABLE menage_destination;
DROP TABLE menage_keeper;
DROP TABLE menage_partition;
PRAGMA user_version=3;
