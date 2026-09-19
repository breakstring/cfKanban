ALTER TABLE attachment_storage ADD COLUMN limit_bytes INTEGER CHECK (limit_bytes IS NULL OR (typeof(limit_bytes) = 'integer' AND limit_bytes BETWEEN 1 AND 9007199254740991));
ALTER TABLE attachment_storage ADD COLUMN limit_configured INTEGER NOT NULL DEFAULT 0 CHECK (limit_configured IN (0, 1));
ALTER TABLE attachment_storage ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE attachment_storage ADD COLUMN last_operation_id TEXT;
UPDATE instance_meta SET schema_version = 7 WHERE schema_version = 6;
