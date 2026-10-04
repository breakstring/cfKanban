ALTER TABLE principals ADD COLUMN locale TEXT DEFAULT NULL
  CHECK (locale IS NULL OR locale IN ('en', 'zh-CN'));

UPDATE instance_meta SET schema_version = 19 WHERE schema_version = 18;
