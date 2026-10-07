DROP INDEX idx_credentials_token_digest;
DROP INDEX idx_browser_launches_code_digest;
DROP INDEX idx_web_sessions_token_digest;

UPDATE instance_meta SET schema_version = 22 WHERE schema_version = 21;
