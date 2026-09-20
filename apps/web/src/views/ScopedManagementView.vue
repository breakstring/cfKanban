<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import PersonSelect from "../components/PersonSelect.vue";
import CasConflictNotice from "../components/CasConflictNotice.vue";
import ErrorNotice from "../components/ErrorNotice.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import PublicJoinRestorePreview from "../components/PublicJoinRestorePreview.vue";
import ScopedInvitations from "../components/ScopedInvitations.vue";
import { ApiProblem, apiRequest } from "../lib/api";
import { captureCasConflict, markCasReadbackComplete, markCasReadbackFailed, type CasConflictState } from "../lib/cas-recovery";
import { locale, t } from "../lib/i18n";
import { useLocalizedError } from "../lib/localized-error";
import { continuationCursor } from "../lib/pagination";
import { navigate } from "../lib/router";
import { hasManagementActions, managementPath, remainingAccessSources, sourceLabel } from "../lib/scoped-management";
import type { AccessSource, AdministratorCandidate, AdministratorResource, ContainerResource, GrantResource, ListResult, MemberCandidate, ProjectMember, ProjectStatusResource, WebSessionView } from "../types";

const props = defineProps<{ workspaceId: string; projectId?: string | undefined; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();
const ui = (en: string, zh: string) => locale.value === "zh-CN" ? zh : en;
const workspacePath = `/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}`;
const resourcePath = props.projectId ? `${workspacePath}/projects/${encodeURIComponent(props.projectId)}` : workspacePath;
const resource = ref<ContainerResource | null>(null);
const administrators = ref<AdministratorResource[]>([]);
const members = ref<ProjectMember[]>([]);
const grants = ref<GrantResource[]>([]);
const projects = ref<ContainerResource[]>([]);
const statuses = ref<ProjectStatusResource[]>([]);
const statusDrafts = ref<Record<string, string>>({});
const cursors = ref<Record<string, string | null>>({});
const loading = ref(true);
const busy = ref(false);
const archived = ref(false);
const draft = ref({ display_name: "", context: "" });
const projectName = ref("");
const administratorCandidate = ref<AdministratorCandidate | null>(null);
const memberCandidate = ref<MemberCandidate | null>(null);
const memberRole = ref<"reader" | "writer">("writer");
const conflict = ref<CasConflictState | null>(null);
const confirmation = ref<{ title: string; message: string; run: () => Promise<void>; restore?: ContainerResource } | null>(null);
const { error, clearError, setError } = useLocalizedError();
let mounted = true;
let generation = 0;
const can = (action: string) => resource.value?.allowed_actions?.includes(action) ?? false;
const active = computed(() => resource.value?.deleted_at === null);
const grantsPath = `/api/v1/admin/projects/${encodeURIComponent(props.projectId ?? "")}/grants`;
const endpoints: Record<string, string> = {
  administrators: `${resourcePath}/administrators`, members: `${resourcePath}/members`, grants: grantsPath,
  projects: `${workspacePath}/projects`,
};

function clearFacts(): void {
  resource.value = null;
  administratorCandidate.value = null;
  memberCandidate.value = null;
  administrators.value = []; members.value = []; grants.value = []; projects.value = []; statuses.value = [];
  cursors.value = {}; confirmation.value = null;
}

async function readPage(kind: string, reset = true): Promise<void> {
  const cursor = cursors.value[kind];
  if (!reset && !cursor) return;
  const query = new URLSearchParams({ limit: "100" });
  if (kind === "projects" && archived.value) query.set("deleted", "only");
  if (!reset && cursor) query.set("cursor", cursor);
  const currentGeneration = generation;
  const result = await apiRequest<ListResult<AdministratorResource | ProjectMember | GrantResource | ContainerResource>>(`${endpoints[kind]}?${query}`);
  if (!mounted || currentGeneration !== generation) return;
  cursors.value[kind] = continuationCursor(result);
  if (kind === "administrators") administrators.value = reset ? result.items as AdministratorResource[] : [...administrators.value, ...result.items as AdministratorResource[]];
  if (kind === "members") members.value = reset ? result.items as ProjectMember[] : [...members.value, ...result.items as ProjectMember[]];
  if (kind === "grants") grants.value = reset ? result.items as GrantResource[] : [...grants.value, ...result.items as GrantResource[]];
  if (kind === "projects") projects.value = reset ? result.items as ContainerResource[] : [...projects.value, ...result.items as ContainerResource[]];
}

async function load(resetDraft = false): Promise<void> {
  generation += 1;
  const currentGeneration = generation;
  loading.value = true;
  clearError();
  try {
    const result = await apiRequest<ContainerResource>(`${resourcePath}${archived.value && props.projectId ? "?deleted=only" : ""}`);
    if (!mounted || currentGeneration !== generation) return;
    clearFacts();
    resource.value = result;
    if (!hasManagementActions(result)) return;
    if (resetDraft) draft.value = { display_name: result.display_name, context: result.context ?? "" };
    emit("context", { label: result.display_name, role: ui("Scoped management", "范围管理") });
    if (result.deleted_at !== null) return;
    const reads: Promise<unknown>[] = [readPage("administrators")];
    if (props.projectId && can("manage_members")) reads.push(readPage("members"), readPage("grants"));
    if (!props.projectId && can("create_project")) reads.push(readPage("projects"));
    if (props.projectId && can("manage_status_names")) reads.push((async () => {
      const result = await apiRequest<ListResult<ProjectStatusResource>>(`${resourcePath}/statuses`);
      if (!mounted || currentGeneration !== generation) return;
      statuses.value = result.items;
      if (resetDraft) statusDrafts.value = Object.fromEntries(result.items.map(item => [item.key, item.display_name]));
    })());
    await Promise.all(reads);
  } catch (caught) {
    if (currentGeneration === generation) { generation += 1; loading.value = false; clearFacts(); setError(caught); }
    throw caught;
  } finally { if (currentGeneration === generation) loading.value = false; }
}

async function refresh(): Promise<void> {
  try {
    await load();
    if (conflict.value) conflict.value = markCasReadbackComplete(conflict.value);
  } catch { if (conflict.value) conflict.value = markCasReadbackFailed(conflict.value); }
}

async function more(kind: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try { await readPage(kind, false); }
  catch (caught) {
    cursors.value[kind] = null;
    if (caught instanceof ApiProblem && [401, 403, 404].includes(caught.status)) clearFacts();
    setError(caught);
  } finally { busy.value = false; }
}

async function write(path: string, method: string, body?: unknown, nextArchived?: boolean): Promise<void> {
  if (busy.value || loading.value) return;
  busy.value = true; clearError();
  try {
    await apiRequest(path, { method, ...(body === undefined ? {} : { body }) });
    if (!mounted) return;
    confirmation.value = null;
    conflict.value = null;
    if (nextArchived !== undefined && props.projectId) {
      navigate(`${managementPath(props.workspaceId, props.projectId)}${nextArchived ? "&archived=1" : ""}`, true);
    } else {
      await load(true);
    }
    window.dispatchEvent(new CustomEvent("cfkanban:authorization-stale"));
  } catch (caught) {
    if (!mounted) return;
    const next = captureCasConflict(caught, resource.value?.display_name ?? ui("Permissions", "权限"), body ?? { method, path });
    if (next) { conflict.value = next; await refresh(); }
    else {
      if (caught instanceof ApiProblem && [401, 403, 404].includes(caught.status)) clearFacts();
      setError(caught);
    }
  } finally { busy.value = false; }
}

function saveSettings(): void {
  if (!resource.value || !can("update")) return;
  void write(resourcePath, "PATCH", { display_name: draft.value.display_name.trim(), expected_version: resource.value.version, ...(props.projectId ? { context: draft.value.context || null } : {}) });
}
function grantAdministrator(item?: AdministratorResource): void {
  if (!can("manage_administrators")) return;
  const candidate = administratorCandidate.value;
  if (!item && !candidate) return;
  const id = item?.principal_id ?? candidate!.principal_id;
  const displayName = item?.principal.display_name ?? candidate!.display_name;
  const expectedVersion = item?.version ?? candidate!.expected_version;
  confirmation.value = {
    title: ui("Grant administrator access", "授予管理员权限"),
    message: `${displayName} — ${props.projectId ? ui("Can manage this project's settings and ordinary members. Counts toward its participant quota.", "可维护本项目设置和普通成员，计入项目人数配额。") : ui("Can read, write and manage all current and future projects in this workspace. Counts toward every project's participant quota; any full public project blocks the entire grant.", "可读写并管理本工作区现在及未来的全部项目，计入各项目人数配额；任一公开项目满额将使整次授权失败。")}`,
    run: () => write(`${resourcePath}/administrators`, "POST", { principal_id: id, expected_version: expectedVersion }),
  };
}
function grantMember(): void {
  if (!can("manage_members") || !memberCandidate.value) return;
  void write(grantsPath, "POST", { principal_id: memberCandidate.value.principal_id, role: memberRole.value });
}
function sourcesText(sources: AccessSource[]): string {
  return sources.map(source => `${sourceLabel(source.kind, locale.value === "zh-CN")}${source.role ? ` · ${source.role}` : ""}`).join(" / ");
}
function revokeAdministrator(item: AdministratorResource): void {
  const member = members.value.find(row => row.principal_id === item.principal_id);
  const remaining = member ? remainingAccessSources(member.sources, item.id) : null;
  confirmation.value = {
    title: ui("Revoke administrator access", "撤销管理员权限"),
    message: `${item.principal.display_name} — ${remaining === null ? ui("Other independent permissions remain. Workspace revocation removes inherited access from all its projects. Invitations issued under this grant become permanently invalid.", "其他独立授权保留；撤销工作区授权会移除其全部子项目的继承访问。通过本授权签发的未兑换邀请将永久失效。") : `${ui("Remaining access", "移除后剩余访问")}：${remaining.length ? sourcesText(remaining) : ui("None from current grants", "当前授权无剩余访问")}。${ui("Unredeemed invitations issued under this grant become permanently invalid.", "通过本授权签发的未兑换邀请将永久失效。")}`}`,
    run: () => write(`${resourcePath}/administrators/${encodeURIComponent(item.id)}?expected_version=${item.version}`, "DELETE"),
  };
}
function revokeGrant(item: GrantResource): void {
  const member = members.value.find(row => row.principal_id === item.principal_id);
  const remaining = member ? remainingAccessSources(member.sources, item.id) : null;
  confirmation.value = {
    title: ui("Remove direct membership", "移除直接成员授权"),
    message: `${item.principal.display_name} — ${ui("Remaining access", "移除后剩余访问")}：${remaining === null ? ui("Load this member's effective sources to inspect other permissions; independent permissions remain.", "可在有效成员列表加载此成员的来源；其他独立授权保留。") : remaining.length ? sourcesText(remaining) : ui("None from current grants", "当前授权无剩余访问")}。${ui("If Public Join is enabled, this person may join again.", "若公开加入仍开启，此人可以再次加入。")}`,
    run: () => write(`/api/v1/admin/grants/${encodeURIComponent(item.id)}?expected_version=${item.version}`, "DELETE"),
  };
}
function editGrant(item: GrantResource, role: "reader" | "writer"): void {
  void write(item.revoked_at ? grantsPath : `/api/v1/admin/grants/${encodeURIComponent(item.id)}`, item.revoked_at ? "POST" : "PATCH", item.revoked_at ? { principal_id: item.principal_id, role } : { expected_version: item.version, role });
}
async function confirmArchive(item: ContainerResource, restore: boolean): Promise<void> {
  const path = `${workspacePath}/projects/${encodeURIComponent(item.id)}`;
  try {
    const current = await apiRequest<ContainerResource>(`${path}${restore ? "?deleted=only" : ""}`);
    confirmation.value = {
      title: restore ? ui("Restore project", "恢复项目") : ui("Archive project", "归档项目"),
      message: `${current.display_name} — ${restore ? ui("Restoring resumes existing access and any previously enabled Public Join policy.", "恢复将重新开放既有访问，并恢复此前开启的公开加入策略。") : ui("This pauses all project access. Existing permissions and Public Join settings are retained.", "将暂停整个项目的访问；已有授权和公开加入设置保留。")}`,
      ...(restore ? { restore: current } : {}),
      run: async () => {
        await write(restore ? `${path}/commands/restore` : `${path}?expected_version=${current.version}`, restore ? "POST" : "DELETE", restore ? { expected_version: current.version } : undefined, props.projectId ? !restore : undefined);
      },
    };
  } catch (caught) { setError(caught); }
}
async function toggleArchive(): Promise<void> {
  if (busy.value || loading.value) return;
  busy.value = true;
  archived.value = !archived.value;
  projects.value = []; cursors.value.projects = null;
  try { await readPage("projects"); } catch (caught) { setError(caught); }
  finally { busy.value = false; }
}
onMounted(() => { archived.value = new URLSearchParams(window.location.search).get("archived") === "1"; void load(true).catch(() => {}); });
onUnmounted(() => { mounted = false; generation += 1; clearFacts(); });
</script>

<template>
  <main class="page-shell scoped-management">
    <header class="page-title-block">
      <p class="eyebrow">{{ props.projectId ? ui('Project management', '项目管理') : ui('Workspace management', '工作区管理') }}</p>
      <h1>{{ resource?.display_name ?? ui('Management', '管理') }}</h1>
      <div class="form-actions">
        <button class="text-button" type="button" @click="navigate('/app')">{{ t('project.choose') }}</button>
        <button v-if="props.projectId && active" class="text-button" type="button" @click="navigate(`/app/w/${encodeURIComponent(workspaceId)}/p/${encodeURIComponent(projectId!)}`)">{{ ui('Open board', '打开看板') }}</button>
        <button class="text-button" type="button" :disabled="busy || loading" @click="refresh">{{ t('action.refresh') }}</button>
      </div>
    </header>
    <ErrorNotice v-if="error" :error="error" />
    <CasConflictNotice v-if="conflict" :conflict="conflict" :busy="busy || loading" @refresh="refresh" @dismiss="conflict = null" />
    <PageState :loading="loading" />
    <p v-if="!loading && resource && !hasManagementActions(resource)">{{ ui('Management is unavailable in this session.', '当前会话没有此范围的管理权限。') }}</p>
    <template v-if="!loading && resource && hasManagementActions(resource)">
      <form v-if="active && can('update')" class="form-stack management-section" @submit.prevent="saveSettings">
        <h2>{{ ui('Settings', '设置') }}</h2>
        <label>{{ ui('Name', '名称') }}<input v-model="draft.display_name" required maxlength="128" /></label>
        <label v-if="projectId">{{ ui('Project context', '项目说明') }}<textarea v-model="draft.context" rows="4" /></label>
        <div class="form-actions"><button class="primary-button" :disabled="busy" type="submit">{{ t('action.save') }}</button></div>
      </form>
      <section v-if="statuses.length && can('manage_status_names')" class="management-section">
        <h2>{{ ui('Status names', '状态显示名') }}</h2>
        <form v-for="status in statuses" :key="status.key" class="management-row" @submit.prevent="write(`${resourcePath}/statuses/${status.key}`, 'PATCH', { display_name: statusDrafts[status.key], expected_version: status.version })">
          <label>{{ status.key }}<input v-model="statusDrafts[status.key]" required maxlength="128" /></label>
          <button class="secondary-button" type="submit" :disabled="busy">{{ t('action.save') }}</button>
        </form>
      </section>
      <section v-if="!projectId && can('create_project')" class="management-section">
        <h2>{{ ui('Projects', '项目') }}</h2>
        <form class="management-row" @submit.prevent="write(`${workspacePath}/projects`, 'POST', { display_name: projectName.trim() })">
          <label>{{ ui('New project name', '新项目名称') }}<input v-model="projectName" required maxlength="128" /></label>
          <button class="secondary-button" type="submit" :disabled="busy">{{ ui('Create project', '创建项目') }}</button>
        </form>
        <button class="text-button" :disabled="busy" type="button" @click="toggleArchive">{{ archived ? ui('Show active projects', '显示有效项目') : ui('Show archived projects', '显示归档项目') }}</button>
        <div v-for="project in projects" :key="project.id" class="management-row">
          <strong>{{ project.display_name }}</strong>
          <button v-if="hasManagementActions(project)" class="text-button" type="button" @click="navigate(`${managementPath(workspaceId, project.id)}${project.deleted_at ? '&archived=1' : ''}`)">{{ ui('Manage', '管理') }}</button>
          <button v-if="project.allowed_actions?.includes('delete')" class="text-button" type="button" :disabled="busy" @click="confirmArchive(project, false)">{{ ui('Archive', '归档') }}</button>
          <button v-if="project.allowed_actions?.includes('restore')" class="secondary-button" type="button" :disabled="busy" @click="confirmArchive(project, true)">{{ t('action.restore') }}</button>
        </div>
        <button v-if="cursors.projects" class="secondary-button" type="button" :disabled="busy" @click="more('projects')">{{ ui('Load more', '加载更多') }}</button>
      </section>
      <section v-if="active" class="management-section">
        <h2>{{ ui('Administrators', '管理员') }}</h2>
        <p>{{ projectId ? ui('Workspace administrators also inherit management access. Project administrators cannot appoint or remove peers.', '工作区管理员也继承本项目管理权；项目管理员不能任免同级管理员。') : ui('Only the Owner can appoint or remove workspace administrators. All current and future projects inherit this access.', '只有实例所有者可以任免工作区管理员；授权覆盖现在和未来的全部子项目。') }}</p>
        <form v-if="can('manage_administrators')" class="management-person-form" @submit.prevent="grantAdministrator()">
          <PersonSelect v-model="administratorCandidate" :endpoint="`${resourcePath}/administrator-candidates`" :disabled="busy"
            :placeholder="ui('Choose an administrator', '请选择要添加的管理员')"
            :empty-text="ui('No people available to add as administrators.', '当前没有可添加的管理员。')"
            :hint="ui('Search within your visible scope. The Owner and people with administrator access are excluded.', '仅搜索当前可见范围内的人员，已排除实例所有者和已有管理权限的人员。')" v-slot="{ ready }">
            <button class="secondary-button" type="submit" :disabled="busy || !ready">{{ ui('Grant administrator access', '授予管理员权限') }}</button>
          </PersonSelect>
        </form>
        <div v-for="administrator in administrators" :key="administrator.id" class="management-row">
          <div><strong>{{ administrator.principal.display_name }}</strong><p><code>{{ administrator.principal_id }}</code> · {{ administrator.revoked_at ? ui('Revoked', '已撤销') : ui('Active', '有效') }}</p></div>
          <button v-if="can('manage_administrators') && administrator.allowed_actions.includes('revoke') && !administrator.revoked_at" class="text-button" type="button" :disabled="busy" @click="revokeAdministrator(administrator)">{{ ui('Revoke', '撤销') }}</button>
          <button v-if="can('manage_administrators') && administrator.allowed_actions.includes('regrant') && administrator.revoked_at" class="text-button" type="button" :disabled="busy" @click="grantAdministrator(administrator)">{{ ui('Grant again', '重新授予') }}</button>
        </div>
        <button v-if="cursors.administrators" class="secondary-button" type="button" :disabled="busy" @click="more('administrators')">{{ ui('Load more', '加载更多') }}</button>
      </section>
      <section v-if="projectId && active && can('manage_members')" class="management-section">
        <h2>{{ ui('Effective members and permission sources', '有效成员与权限来源') }}</h2>
        <p>{{ ui('Independent sources are combined. Removing one source preserves all others; inherited administration cannot be reduced by a reader grant.', '各项独立权限合并生效；移除一项仍保留其他来源，reader 授权不能降低继承管理权。') }}</p>
        <div v-for="member in members" :key="member.principal_id" class="management-row">
          <div><strong>{{ member.display_name }} · {{ member.effective_role }}</strong><p><code>{{ member.principal_id }}</code></p><p>{{ sourcesText(member.sources) }}</p></div>
        </div>
        <button v-if="cursors.members" class="secondary-button" type="button" :disabled="busy" @click="more('members')">{{ ui('Load more members', '加载更多成员') }}</button>
        <h3>{{ ui('Direct memberships', '直接成员授权') }}</h3>
        <form class="management-person-form" @submit.prevent="grantMember">
          <PersonSelect v-model="memberCandidate" :endpoint="`${resourcePath}/member-candidates`" :disabled="busy"
            :placeholder="ui('Choose a member', '请选择要添加的成员')"
            :empty-text="ui('No people available for direct access. Use an invitation below to add new members.', '当前没有可直接授权的人员。添加新成员，请使用下方的项目邀请。')"
            :hint="ui('Search within your visible scope. Existing direct members can be managed below; new people can join by invitation.', '仅搜索当前可见范围内的人员。已有直接成员在下方管理，新成员通过邀请加入。')" v-slot="{ ready }">
            <label>{{ ui('Role', '角色') }}<select v-model="memberRole" :aria-label="ui('Role', '角色')" :disabled="busy"><option value="reader">{{ ui('Reader', '只读者') }}</option><option value="writer">{{ ui('Writer', '协作者') }}</option></select></label>
            <button class="secondary-button" type="submit" :disabled="busy || !ready">{{ ui('Grant access', '授予访问') }}</button>
          </PersonSelect>
        </form>
        <div v-for="grant in grants" :key="grant.id" class="management-row">
          <div><strong>{{ grant.principal.display_name }}</strong><p>{{ grant.role }} · {{ grant.revoked_at ? ui('Revoked', '已撤销') : ui('Active', '有效') }}</p></div>
          <button v-if="grant.allowed_actions.includes('update')" class="text-button" type="button" :disabled="busy" @click="editGrant(grant, grant.role === 'reader' ? 'writer' : 'reader')">{{ grant.role === 'reader' ? ui('Change to writer', '改为协作者') : ui('Change to reader', '改为只读者') }}</button>
          <button v-if="grant.allowed_actions.includes('revoke')" class="text-button" type="button" :disabled="busy" @click="revokeGrant(grant)">{{ ui('Remove direct membership', '移除直接授权') }}</button>
          <button v-if="grant.revoked_at && grant.allowed_actions.includes('regrant')" class="text-button" type="button" :disabled="busy" @click="editGrant(grant, grant.role)">{{ ui('Grant again', '重新授予') }}</button>
        </div>
        <button v-if="cursors.grants" class="secondary-button" type="button" :disabled="busy" @click="more('grants')">{{ ui('Load more grants', '加载更多授权') }}</button>
        <ScopedInvitations :project-id="projectId" :session="session" />
      </section>
      <section v-if="projectId && (can('delete') || can('restore'))" class="management-section">
        <h2>{{ ui('Project availability', '项目可用性') }}</h2>
        <button v-if="can('delete')" class="text-button" type="button" :disabled="busy" @click="confirmArchive(resource, false)">{{ ui('Archive project', '归档项目') }}</button>
        <button v-if="can('restore')" class="secondary-button" type="button" :disabled="busy" @click="confirmArchive(resource, true)">{{ ui('Restore project', '恢复项目') }}</button>
      </section>
    </template>
    <ModalDialog v-if="confirmation" :busy="busy" :title="confirmation.title" @close="confirmation = null">
      <p>{{ confirmation.message }}</p>
      <PublicJoinRestorePreview v-if="confirmation.restore?.resumed_public_projects" :projects="confirmation.restore.resumed_public_projects.projects" :language="locale" />
      <div class="form-actions"><button class="secondary-button" type="button" :disabled="busy" @click="confirmation = null">{{ t('action.cancel') }}</button><button class="primary-button" type="button" :disabled="busy" @click="confirmation.run()">{{ ui('Confirm', '确认') }}</button></div>
    </ModalDialog>
  </main>
</template>

<style scoped>
.scoped-management { max-width: 1040px; }
.management-section { padding-block: var(--space-6, 24px); border-bottom: 1px solid var(--color-border); }
.management-section > h2 { margin-top: 0; }
.management-section > h3 { margin-block: 24px 16px; }
.management-person-form { padding-block: 16px; }
.management-row { display: flex; align-items: end; gap: 16px; flex-wrap: wrap; padding-block: 12px; border-bottom: 1px solid var(--color-border); }
.management-row > div, .management-row > label:first-child { flex: 1; min-width: 220px; }
.management-row label { display: grid; gap: 8px; }
.management-row p { margin-block: 6px; overflow-wrap: anywhere; }
.management-row code { font-size: 12px; }
.management-row input, .management-row select, .management-row > button { min-height: 44px; }
@media (max-width: 600px) { .management-row button { min-height: 44px; } }
</style>
