-- Legacy SQL backfill is deliberately limited to ASCII and basic Han names.
-- Other Unicode names need an explicit normalization review, never SQLite lower() guesswork.
CREATE TABLE principal_name_migration_guard (
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 128
    AND instr(name, char(0)) = 0
    AND name NOT GLOB '*[^A-Za-z0-9一-鿿_·-]*'
    AND lower(name) NOT IN ('admin', 'administrator', 'owner', 'system', '管理员', '所有者', '系统')
  ),
  name_key TEXT NOT NULL UNIQUE
) STRICT;
INSERT INTO principal_name_migration_guard (name, name_key)
SELECT replace(trim(display_name), ' ', '_'), lower(replace(trim(display_name), ' ', '_'))
FROM principals;

ALTER TABLE principals ADD COLUMN display_name_key TEXT NOT NULL DEFAULT '';
UPDATE principals
SET display_name = replace(trim(display_name), ' ', '_'),
    display_name_key = lower(replace(trim(display_name), ' ', '_')),
    version = version + CASE WHEN display_name != replace(trim(display_name), ' ', '_') THEN 1 ELSE 0 END,
    updated_at = CASE WHEN display_name != replace(trim(display_name), ' ', '_') THEN unixepoch() * 1000 ELSE updated_at END;
CREATE UNIQUE INDEX idx_principals_display_name_key ON principals(display_name_key);
CREATE TRIGGER principal_name_key_insert BEFORE INSERT ON principals
WHEN length(NEW.display_name_key) NOT BETWEEN 1 AND 128
BEGIN
  SELECT RAISE(ABORT, 'principal_name_key_required');
END;
CREATE TRIGGER principal_name_key_update BEFORE UPDATE OF display_name, display_name_key ON principals
WHEN length(NEW.display_name_key) NOT BETWEEN 1 AND 128
BEGIN
  SELECT RAISE(ABORT, 'principal_name_key_required');
END;
DROP TABLE principal_name_migration_guard;
UPDATE instance_meta SET schema_version = MAX(schema_version, 8);
