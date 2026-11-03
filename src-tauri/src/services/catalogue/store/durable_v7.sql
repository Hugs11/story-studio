-- Language markers written from projections v3 and earlier are void: those
-- projections never read Lunii's locale map. Only the "language" entry is
-- removed; author_checked, corrections and other fields are kept.
UPDATE lunii_filled SET checked_fields=(
  SELECT json_group_array(CASE WHEN type IN ('object','array') THEN json(value) ELSE value END)
  FROM (SELECT value,type FROM json_each(lunii_filled.checked_fields)
        WHERE NOT (type='text' AND value='language') ORDER BY key)
) WHERE EXISTS(SELECT 1 FROM json_each(lunii_filled.checked_fields) WHERE type='text' AND value='language');
PRAGMA user_version=7;
