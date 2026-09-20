import assert from "node:assert/strict";
import test from "node:test";
import { groupProjects, projectReturnTarget } from "../../apps/web/src/lib/project-navigation.ts";

const projects = [
  { workspace_id: "a", workspace_display_name: "Workspace A", project_id: "1", project_display_name: "Project 1", role: "writer" },
  { workspace_id: "b", workspace_display_name: "Workspace B", project_id: "3", project_display_name: "Project 3", role: "writer" },
  { workspace_id: "b", workspace_display_name: "Workspace B", project_id: "4", project_display_name: "Project 4", role: "writer" },
  { workspace_id: "c", workspace_display_name: "Workspace C", project_id: "5", project_display_name: "Project 5", role: "reader" },
];
const workspaces = [{ id: "b", display_name: "Workspace B", allowed_actions: ["create_project"] }, { id: "empty", display_name: "Empty", allowed_actions: ["update"] }];
test("group search preserves workspace permissions, empty managed workspaces and full workspace matches", () => {
  const all = groupProjects(projects, workspaces);
  assert.equal(all.find(group => group.id === "a").canManage, false);
  assert.equal(all.find(group => group.id === "c").canManage, false);
  assert.equal(all.find(group => group.id === "empty").projects.length, 0);
  assert.equal(groupProjects(projects, workspaces, "Workspace B")[0].projects.length, 2);
  const searched = groupProjects(projects, workspaces, "Project 4");
  assert.equal(searched.length, 1);
  assert.equal(searched[0].canManage, true);
  assert.deepEqual(searched[0].projects.map(project => project.project_id), ["4"]);
});
test("return paths must name a currently accessible exact project", () => {
  assert.equal(projectReturnTarget("/app/w/a/p/1", projects), projects[0]);
  for (const path of ["https://evil.example/app/w/a/p/1", "//evil.example/app/w/a/p/1", "/app/w/a/p/1?admin=1", "/app/w/c/p/1", "/app/admin"]) {
    assert.equal(projectReturnTarget(path, projects), undefined);
  }
  assert.equal(projectReturnTarget("/app/w/a/p/1", projects.slice(1)), undefined);
});
