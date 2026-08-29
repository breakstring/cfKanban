const PUBLIC_PROJECTS_SELECT = `SELECT policy.public_id, project.display_name, policy.public_summary
 FROM public_join_policies policy INDEXED BY idx_public_join_enabled
 JOIN projects project ON project.id = policy.project_id
 JOIN workspaces workspace ON workspace.id = project.workspace_id
 JOIN project_usage usage ON usage.project_id = project.id
 WHERE policy.disabled_at IS NULL AND policy.enabled_at IS NOT NULL
   AND project.deleted_at IS NULL AND workspace.deleted_at IS NULL
   AND project.issue_limit IS NOT NULL
   AND project.comment_limit IS NOT NULL
   AND project.principal_limit IS NOT NULL`;

export const PUBLIC_PROJECTS_FIRST_PAGE_SQL = `${PUBLIC_PROJECTS_SELECT}
 ORDER BY policy.public_id
 LIMIT ?1`;

export const PUBLIC_PROJECTS_CONTINUATION_SQL = `${PUBLIC_PROJECTS_SELECT}
   AND policy.public_id > ?1
 ORDER BY policy.public_id
 LIMIT ?2`;
