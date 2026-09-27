ALTER TABLE credentials ADD COLUMN device_name TEXT
  CHECK (device_name IS NULL OR (typeof(device_name) = 'text' AND length(device_name) BETWEEN 1 AND 80));
UPDATE instance_meta SET schema_version = 12 WHERE schema_version = 11;
