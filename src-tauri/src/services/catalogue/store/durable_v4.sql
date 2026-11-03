-- Repair UUID-less publications detached by v3. A v3-created card starts at
-- revision zero with no favorite, tags or corrections. Reference receipts are
-- allowed only for its sole exemplar; conflicting accepted values are retained
-- on their separate card rather than silently overwritten.
CREATE TEMP TABLE publication_repair AS
SELECT e.id AS exemplar_id,e.fiche_id AS old_card,MIN(p.fiche_id) AS new_card
FROM exemplar e JOIN fiche f ON f.id=e.fiche_id
JOIN file_publication p ON p.exemplar_id=e.id
JOIN fiche target ON target.id=p.fiche_id
WHERE e.verified_uuid IS NULL AND p.fiche_id<>e.fiche_id
  AND f.favorite=0 AND f.revision=0
  AND NOT EXISTS (SELECT 1 FROM exemplar other WHERE other.fiche_id=f.id AND other.id<>e.id)
  AND NOT EXISTS (SELECT 1 FROM correction WHERE fiche_id=f.id)
  AND NOT EXISTS (SELECT 1 FROM tag_member WHERE fiche_id=f.id)
  AND NOT EXISTS (SELECT 1 FROM fiche_forgotten WHERE fiche_id=f.id)
  AND NOT EXISTS (SELECT 1 FROM import_reference WHERE fiche_id=f.id)
  AND NOT EXISTS (SELECT 1 FROM reference_source WHERE fiche_id=f.id AND exemplar_id<>e.id)
  AND NOT EXISTS (SELECT 1 FROM reference_value WHERE fiche_id=f.id
                  AND NOT EXISTS (SELECT 1 FROM reference_source WHERE fiche_id=f.id AND exemplar_id=e.id))
  AND NOT EXISTS (SELECT 1 FROM reference_source a JOIN reference_source b
                  ON b.fiche_id=p.fiche_id WHERE a.fiche_id=f.id
                  AND (a.exemplar_id<>b.exemplar_id OR a.selected_at<>b.selected_at OR a.revision<>b.revision))
  AND NOT EXISTS (SELECT 1 FROM reference_value a JOIN reference_value b
                  ON b.fiche_id=p.fiche_id AND b.field=a.field AND b.language=a.language
                  WHERE a.fiche_id=f.id AND (a.value_json<>b.value_json
                    OR a.provenance_id<>b.provenance_id OR a.image_sha256 IS NOT b.image_sha256))
GROUP BY e.id,e.fiche_id
HAVING MIN(p.fiche_id)=MAX(p.fiche_id)
   AND NOT EXISTS (SELECT 1 FROM file_publication conflicting
                   WHERE conflicting.exemplar_id=e.id AND conflicting.fiche_id=e.fiche_id);
CREATE UNIQUE INDEX publication_repair_card ON publication_repair(old_card);
-- Ambiguous chains/cycles are not evidence of a single surviving source card.
CREATE TEMP TABLE publication_repair_ambiguous AS
SELECT a.old_card FROM publication_repair a JOIN publication_repair b
ON a.old_card=b.new_card OR a.new_card=b.old_card
-- Two detached selections for the same destination cannot both retain their
-- selection receipt. Preserve those cards for review instead of discarding one.
OR (a.new_card=b.new_card AND a.old_card<>b.old_card
    AND EXISTS (SELECT 1 FROM reference_source WHERE fiche_id=a.old_card)
    AND EXISTS (SELECT 1 FROM reference_source WHERE fiche_id=b.old_card));
DELETE FROM publication_repair WHERE old_card IN (SELECT old_card FROM publication_repair_ambiguous);
DROP TABLE publication_repair_ambiguous;

INSERT INTO reference_value
SELECT r.new_card,v.field,v.language,v.value_json,v.provenance_id,v.image_sha256
FROM reference_value v JOIN publication_repair r ON r.old_card=v.fiche_id
WHERE NOT EXISTS (SELECT 1 FROM reference_value existing WHERE existing.fiche_id=r.new_card
                  AND existing.field=v.field AND existing.language=v.language);
INSERT INTO reference_source
SELECT r.new_card,s.exemplar_id,s.selected_at,s.revision
FROM reference_source s JOIN publication_repair r ON r.old_card=s.fiche_id
WHERE NOT EXISTS (SELECT 1 FROM reference_source existing WHERE existing.fiche_id=r.new_card);
DELETE FROM reference_value WHERE fiche_id IN (SELECT old_card FROM publication_repair);
DELETE FROM reference_source WHERE fiche_id IN (SELECT old_card FROM publication_repair);
UPDATE exemplar SET fiche_id=(SELECT new_card FROM publication_repair WHERE exemplar_id=exemplar.id)
WHERE id IN (SELECT exemplar_id FROM publication_repair);
DELETE FROM pack_identity WHERE fiche_id IN (SELECT old_card FROM publication_repair);
DELETE FROM saved_pack_identity WHERE fiche_id IN (SELECT old_card FROM publication_repair);
DELETE FROM fiche_grouping WHERE fiche_id IN (SELECT old_card FROM publication_repair)
 OR target_id IN (SELECT old_card FROM publication_repair);
UPDATE identity_convergence SET known_fiche_id=(SELECT new_card FROM publication_repair WHERE old_card=known_fiche_id)
WHERE known_fiche_id IN (SELECT old_card FROM publication_repair);
UPDATE file_publication SET fiche_id=(SELECT new_card FROM publication_repair WHERE old_card=fiche_id)
WHERE fiche_id IN (SELECT old_card FROM publication_repair);
DELETE FROM import_identity WHERE entity_type IN ('card','groupMember') AND local_entity_id IN (SELECT old_card FROM publication_repair);
UPDATE fiche SET revision=revision+1 WHERE id IN (SELECT new_card FROM publication_repair);
DELETE FROM fiche WHERE id IN (SELECT old_card FROM publication_repair);
UPDATE catalogue SET revision=revision+1 WHERE EXISTS (SELECT 1 FROM publication_repair);
DROP TABLE publication_repair;
PRAGMA user_version=4;
