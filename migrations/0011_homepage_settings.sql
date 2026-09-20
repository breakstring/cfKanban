CREATE TABLE homepage_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  notice_en TEXT CHECK (notice_en IS NULL OR (typeof(notice_en) = 'text' AND length(notice_en) <= 500)),
  notice_zh_cn TEXT CHECK (notice_zh_cn IS NULL OR (typeof(notice_zh_cn) = 'text' AND length(notice_zh_cn) <= 500)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_operation_id TEXT
);
INSERT INTO homepage_settings(singleton) VALUES (1);
UPDATE instance_meta SET schema_version = 11 WHERE schema_version = 10;
