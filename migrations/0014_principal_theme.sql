ALTER TABLE principals ADD COLUMN theme TEXT NOT NULL DEFAULT 'orange'
  CHECK (theme IN ('orange', 'blue'));

UPDATE instance_meta SET schema_version = 14 WHERE schema_version = 13;
