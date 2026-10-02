// 显式限定三个来源的目标范围，避免 effective_project_grants 的窗口排序扫描无关授权。
export function activeProjectPrincipalCountSql(projectIdSql: string): string {
  return `(SELECT COUNT(DISTINCT member.principal_id) FROM (
    SELECT direct.principal_id FROM project_grants direct
    WHERE direct.project_id = ${projectIdSql} AND direct.revoked_at IS NULL
    UNION ALL
    SELECT administrator.principal_id FROM scoped_administrator_grants administrator
    WHERE administrator.project_id = ${projectIdSql}
      AND administrator.workspace_id = (SELECT workspace_id FROM projects WHERE id = ${projectIdSql})
      AND administrator.revoked_at IS NULL
    UNION ALL
    SELECT administrator.principal_id FROM scoped_administrator_grants administrator
    WHERE administrator.project_id IS NULL
      AND administrator.workspace_id = (SELECT workspace_id FROM projects WHERE id = ${projectIdSql})
      AND administrator.revoked_at IS NULL
  ) member)`;
}
