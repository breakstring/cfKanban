ALTER TABLE workspaces ADD COLUMN description TEXT DEFAULT NULL
  CHECK (description IS NULL OR length(CAST(description AS BLOB)) <= 32768);

UPDATE instance_meta SET schema_version = 31 WHERE schema_version = 30;
