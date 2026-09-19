-- 0004 已发布但未推进已初始化实例的版本；保留其指纹，通过兼容迁移修复。
UPDATE instance_meta SET schema_version = 5 WHERE schema_version IN (3, 4);
