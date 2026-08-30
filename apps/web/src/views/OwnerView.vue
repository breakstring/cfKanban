<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import { apiRequest, errorText } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { navigate } from "../lib/router";
import type {
  ContainerResource,
  CredentialResource,
  EventResource,
  GrantResource,
  InvitationResource,
  ListResult,
  MetaResource,
  PrincipalDetail,
  PrincipalResource,
  ProjectStatusResource,
  RateLimitSettings,
  WebSessionView,
  WriteResult,
} from "../types";

type OwnerSection = "overview" | "workspaces" | "access" | "audit";

const props = defineProps<{ section: OwnerSection; session: WebSessionView }>();
const emit = defineEmits<{ context: [value: { label: string; role: string }] }>();

interface ProjectEntry extends ContainerResource { workspaceKey: string }
interface PolicyResource {
  active_usage: { comments: number; issues: number; principals: number };
  allowed_actions: string[];
  enabled: boolean;
  policy_version: number | null;
  project: { display_name: string; id: string; key: string; version: number; workspace_key: string };
  public_summary: string | null;
  resource_limits: { comments: number | null; issues: number | null; principals: number | null };
}

const loading = ref(true);
const busy = ref(false);
const error = ref("");
const treeTruncated = ref(false);
const meta = ref<MetaResource | null>(null);
const rateSettings = ref<RateLimitSettings | null>(null);
const workspaces = ref<ContainerResource[]>([]);
const projects = ref<ProjectEntry[]>([]);
const deletedWorkspaces = ref<ContainerResource[]>([]);
const deletedProjects = ref<ProjectEntry[]>([]);
const principals = ref<PrincipalResource[]>([]);
const invitations = ref<InvitationResource[]>([]);
const audit = ref<EventResource[]>([]);
const showWorkspace = ref(false);
const showProject = ref(false);
const showInvite = ref(false);
const showPolicy = ref(false);
const showContainerEdit = ref(false);
const showProjectSettings = ref(false);
const showRestore = ref(false);
const showPrincipal = ref(false);
const showGrant = ref(false);
const oneTimeInvite = ref("");
const selectedWorkspace = ref("");
const selectedProject = ref<ProjectEntry | null>(null);
const workspaceForm = ref({ display_name: "", key: "" });
const projectForm = ref({ context: "", display_name: "", key: "" });
const inviteForm = ref({ project_id: "", role: "writer" as "reader" | "writer" });
const policy = ref<PolicyResource | null>(null);
const policyForm = ref({ comments: 500, issues: 50, principals: 50, public_summary: "" });
const containerEdit = ref<{ display_name: string; kind: "workspace" | "project"; item: ContainerResource; workspace_key?: string } | null>(null);
const projectSettingsForm = ref({ context: "", display_name: "" });
const projectStatuses = ref<ProjectStatusResource[]>([]);
const statusDrafts = ref<Record<string, string>>({});
const restoreTarget = ref<{ kind: "workspace" | "project"; item: ContainerResource; workspace_key?: string } | null>(null);
const selectedPrincipal = ref<PrincipalDetail | null>(null);
const selectedGrantProject = ref<ProjectEntry | null>(null);
const projectGrants = ref<GrantResource[]>([]);
const grantForm = ref({ principal_id: "", role: "writer" as "reader" | "writer" });
const recoveryForm = ref({ mode: "rotation" as "rotation" | "full_recovery", principal_id: "" });

function ui(english: string, chinese: string): string {
  return locale.value === "zh-CN" ? chinese : english;
}

async function copyText(value: string): Promise<void> {
  try {
    await window.navigator.clipboard.writeText(value);
  } catch {
    error.value = locale.value === "zh-CN"
      ? "浏览器未允许复制，请手动选择文本。"
      : "Copy was not allowed; select the text manually.";
  }
}

function openInviteDialog(): void {
  oneTimeInvite.value = "";
  showInvite.value = true;
}

function closeInviteDialog(): void {
  oneTimeInvite.value = "";
  showInvite.value = false;
}

const tabs = computed(() => [
  { key: "overview" as const, label: t("admin.overview") },
  { key: "workspaces" as const, label: t("admin.workspaces") },
  { key: "access" as const, label: t("admin.access") },
  { key: "audit" as const, label: t("admin.audit") },
]);

function sectionPath(section: OwnerSection): string {
  return section === "overview" ? "/app/admin" : `/app/admin?section=${section}`;
}

async function loadWorkspaceTree(includeDeleted = props.section === "workspaces"): Promise<void> {
  treeTruncated.value = false;
  const [result, deletedResult] = await Promise.all([
    apiRequest<ListResult<ContainerResource>>("/api/v1/workspaces?limit=20"),
    includeDeleted
      ? apiRequest<ListResult<ContainerResource>>("/api/v1/workspaces?deleted=only&limit=20")
      : Promise.resolve<ListResult<ContainerResource>>({ has_more: false, items: [], next_cursor: null }),
  ]);
  workspaces.value = result.items;
  deletedWorkspaces.value = deletedResult.items;
  const groups = await Promise.all(result.items.map(async (workspace) => {
    const [projectResult, deletedProjectResult] = await Promise.all([
      apiRequest<ListResult<ContainerResource>>(
        `/api/v1/workspaces/${encodeURIComponent(workspace.key)}/projects?limit=20`,
      ),
      includeDeleted
        ? apiRequest<ListResult<ContainerResource>>(
          `/api/v1/workspaces/${encodeURIComponent(workspace.key)}/projects?deleted=only&limit=20`,
        )
        : Promise.resolve<ListResult<ContainerResource>>({ has_more: false, items: [], next_cursor: null }),
    ]);
    return {
      active: projectResult.items.map((item) => ({ ...item, workspaceKey: workspace.key })),
      deleted: deletedProjectResult.items.map((item) => ({ ...item, workspaceKey: workspace.key })),
      truncated: projectResult.has_more || deletedProjectResult.has_more,
    };
  }));
  projects.value = groups.flatMap((group) => group.active);
  deletedProjects.value = groups.flatMap((group) => group.deleted);
  treeTruncated.value = result.has_more || deletedResult.has_more || groups.some((group) => group.truncated);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    if (props.section === "overview") {
      const [metaResult, rateResult, workspaceResult, principalResult] = await Promise.all([
        apiRequest<MetaResource>("/api/v1/meta"),
        apiRequest<RateLimitSettings>("/api/v1/admin/rate-limit-settings"),
        apiRequest<ListResult<ContainerResource>>("/api/v1/workspaces?limit=100"),
        apiRequest<ListResult<PrincipalResource>>("/api/v1/admin/principals?limit=100"),
      ]);
      meta.value = metaResult;
      rateSettings.value = rateResult;
      workspaces.value = workspaceResult.items;
      principals.value = principalResult.items;
    } else if (props.section === "workspaces") {
      await loadWorkspaceTree(true);
    } else if (props.section === "access") {
      await loadWorkspaceTree(false);
      const [principalResult, inviteResult] = await Promise.all([
        apiRequest<ListResult<PrincipalResource>>("/api/v1/admin/principals?limit=100"),
        apiRequest<ListResult<InvitationResource>>("/api/v1/admin/invitations?limit=100"),
      ]);
      principals.value = principalResult.items;
      invitations.value = inviteResult.items;
    } else {
      const auditResult = await apiRequest<ListResult<EventResource>>("/api/v1/admin/audit-events?limit=100");
      audit.value = auditResult.items;
    }
    emit("context", { label: t("admin.title"), role: "owner" });
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    loading.value = false;
  }
}

async function createWorkspace(): Promise<void> {
  busy.value = true;
  try {
    await apiRequest("/api/v1/workspaces", { body: workspaceForm.value, method: "POST" });
    showWorkspace.value = false;
    workspaceForm.value = { display_name: "", key: "" };
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function createProject(): Promise<void> {
  if (!selectedWorkspace.value) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/workspaces/${encodeURIComponent(selectedWorkspace.value)}/projects`, {
      body: { ...projectForm.value, context: projectForm.value.context || null }, method: "POST",
    });
    showProject.value = false;
    projectForm.value = { context: "", display_name: "", key: "" };
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function deleteContainer(kind: "workspace" | "project", item: ContainerResource, workspaceKey?: string): Promise<void> {
  if (!window.confirm(`${t("action.delete")}: ${item.display_name}?`)) return;
  busy.value = true;
  try {
    const path = kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(item.key)}`
      : `/api/v1/workspaces/${encodeURIComponent(workspaceKey ?? "")}/projects/${encodeURIComponent(item.key)}`;
    await apiRequest(`${path}?expected_version=${item.version}`, { method: "DELETE" });
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

function openContainerEdit(kind: "workspace" | "project", item: ContainerResource, workspaceKey?: string): void {
  containerEdit.value = {
    display_name: item.display_name,
    item,
    kind,
    ...(workspaceKey === undefined ? {} : { workspace_key: workspaceKey }),
  };
  showContainerEdit.value = true;
}

async function saveContainerEdit(): Promise<void> {
  const target = containerEdit.value;
  if (target === null || !target.display_name.trim()) return;
  busy.value = true;
  try {
    const path = target.kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(target.item.key)}`
      : `/api/v1/workspaces/${encodeURIComponent(target.workspace_key ?? "")}/projects/${encodeURIComponent(target.item.key)}`;
    await apiRequest(path, {
      body: { display_name: target.display_name.trim(), expected_version: target.item.version },
      method: "PATCH",
    });
    showContainerEdit.value = false;
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function openProjectSettings(item: ProjectEntry): Promise<void> {
  selectedProject.value = item;
  projectSettingsForm.value = { context: item.context ?? "", display_name: item.display_name };
  showProjectSettings.value = true;
  busy.value = true;
  try {
    const result = await apiRequest<ListResult<ProjectStatusResource>>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}/statuses`,
    );
    projectStatuses.value = result.items;
    statusDrafts.value = Object.fromEntries(result.items.map((status) => [status.key, status.display_name]));
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function saveProjectSettings(): Promise<void> {
  const item = selectedProject.value;
  if (item === null || !projectSettingsForm.value.display_name.trim()) return;
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<ContainerResource>>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}`,
      {
        body: {
          context: projectSettingsForm.value.context || null,
          display_name: projectSettingsForm.value.display_name.trim(),
          expected_version: item.version,
        },
        method: "PATCH",
      },
    );
    const updated = { ...result.resource, workspaceKey: item.workspaceKey };
    selectedProject.value = updated;
    projectStatuses.value = projectStatuses.value.map((status) => ({ ...status, version: updated.version }));
    projectSettingsForm.value = { context: updated.context ?? "", display_name: updated.display_name };
    await loadWorkspaceTree(true);
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function saveStatusName(status: ProjectStatusResource): Promise<void> {
  const item = selectedProject.value;
  const displayName = statusDrafts.value[status.key]?.trim();
  if (item === null || !displayName || displayName === status.display_name) return;
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<ProjectStatusResource>>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}/statuses/${status.key}`,
      { body: { display_name: displayName, expected_version: status.version }, method: "PATCH" },
    );
    projectStatuses.value = projectStatuses.value.map((entry) => (
      entry.key === status.key
        ? result.resource
        : { ...entry, version: result.resource.version }
    ));
    statusDrafts.value = { ...statusDrafts.value, [status.key]: result.resource.display_name };
    if (selectedProject.value !== null) selectedProject.value.version = result.resource.version;
    projects.value = projects.value.map((entry) => entry.id === item.id ? { ...entry, version: result.resource.version } : entry);
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function openRestore(kind: "workspace" | "project", item: ContainerResource, workspaceKey?: string): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const path = kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(item.key)}?deleted=only`
      : `/api/v1/workspaces/${encodeURIComponent(workspaceKey ?? "")}/projects/${encodeURIComponent(item.key)}?deleted=only`;
    const current = await apiRequest<ContainerResource>(path);
    restoreTarget.value = {
      item: current,
      kind,
      ...(workspaceKey === undefined ? {} : { workspace_key: workspaceKey }),
    };
    showRestore.value = true;
  } catch (caught) {
    error.value = errorText(caught);
  } finally {
    busy.value = false;
  }
}

async function restoreContainer(): Promise<void> {
  const target = restoreTarget.value;
  if (target === null) return;
  busy.value = true;
  try {
    const path = target.kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(target.item.key)}/commands/restore`
      : `/api/v1/workspaces/${encodeURIComponent(target.workspace_key ?? "")}/projects/${encodeURIComponent(target.item.key)}/commands/restore`;
    await apiRequest(path, { body: { expected_version: target.item.version }, method: "POST" });
    showRestore.value = false;
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function openPrincipal(principal: PrincipalResource): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    oneTimeInvite.value = "";
    selectedPrincipal.value = await apiRequest<PrincipalDetail>(`/api/v1/admin/principals/${principal.id}`);
    recoveryForm.value = { mode: "rotation", principal_id: principal.id };
    showPrincipal.value = true;
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

function closePrincipal(): void {
  oneTimeInvite.value = "";
  selectedPrincipal.value = null;
  showPrincipal.value = false;
}

async function revokeCredential(credential: CredentialResource): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/credentials/${credential.id}?expected_version=${credential.version}`, { method: "DELETE" });
    if (selectedPrincipal.value !== null) await openPrincipal(selectedPrincipal.value);
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function createRecoveryInvite(): Promise<void> {
  if (!recoveryForm.value.principal_id) return;
  busy.value = true;
  oneTimeInvite.value = "";
  try {
    const result = await apiRequest<WriteResult<{ copy_text?: string; invite_url?: string }>>(
      "/api/v1/admin/invitations",
      {
        body: {
          kind: "principal_recovery",
          principal_id: recoveryForm.value.principal_id,
          recovery_mode: recoveryForm.value.mode,
        },
        method: "POST",
      },
    );
    oneTimeInvite.value = result.resource.copy_text ?? result.resource.invite_url ?? "";
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function openProjectGrants(item: ProjectEntry): Promise<void> {
  selectedGrantProject.value = item;
  grantForm.value = { principal_id: "", role: "writer" };
  busy.value = true;
  try {
    const result = await apiRequest<ListResult<GrantResource>>(`/api/v1/admin/projects/${item.id}/grants?limit=100`);
    projectGrants.value = result.items;
    showGrant.value = true;
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function createGrant(): Promise<void> {
  const item = selectedGrantProject.value;
  if (item === null || !grantForm.value.principal_id.trim()) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/projects/${item.id}/grants`, {
      body: { principal_id: grantForm.value.principal_id.trim(), role: grantForm.value.role },
      method: "POST",
    });
    await openProjectGrants(item);
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function setGrantRole(grant: GrantResource, role: "reader" | "writer"): Promise<void> {
  busy.value = true;
  try {
    if (grant.revoked_at === null) {
      await apiRequest(`/api/v1/admin/grants/${grant.id}`, {
        body: { expected_version: grant.version, role }, method: "PATCH",
      });
    } else {
      const item = selectedGrantProject.value;
      if (item === null) return;
      await apiRequest(`/api/v1/admin/projects/${item.id}/grants`, {
        body: { principal_id: grant.principal_id, role }, method: "POST",
      });
    }
    if (selectedGrantProject.value !== null) await openProjectGrants(selectedGrantProject.value);
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function revokeGrant(grant: GrantResource): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/grants/${grant.id}?expected_version=${grant.version}`, { method: "DELETE" });
    if (selectedGrantProject.value !== null) await openProjectGrants(selectedGrantProject.value);
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function createInvite(): Promise<void> {
  if (!inviteForm.value.project_id) return;
  busy.value = true;
  oneTimeInvite.value = "";
  try {
    const result = await apiRequest<WriteResult<{ copy_text?: string; invite_url?: string }>>("/api/v1/admin/invitations", {
      body: { kind: "project_grant", grants: [inviteForm.value] }, method: "POST",
    });
    oneTimeInvite.value = result.resource.copy_text ?? result.resource.invite_url ?? "";
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function revokeInvite(invitation: InvitationResource): Promise<void> {
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/invitations/${invitation.id}?expected_version=${invitation.version}`, { method: "DELETE" });
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function openPolicy(item: ProjectEntry): Promise<void> {
  selectedProject.value = item;
  showPolicy.value = true;
  busy.value = true;
  try {
    const result = await apiRequest<PolicyResource>(`/api/v1/admin/projects/${item.id}/public-join`);
    policy.value = result;
    policyForm.value = {
      comments: result.resource_limits.comments ?? 500,
      issues: result.resource_limits.issues ?? 50,
      principals: result.resource_limits.principals ?? 50,
      public_summary: result.public_summary ?? "",
    };
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function savePolicy(): Promise<void> {
  const item = selectedProject.value;
  if (item === null) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/projects/${item.id}/public-join`, {
      body: {
        comment_limit: policyForm.value.comments,
        expected_version: policy.value?.project.version ?? item.version,
        issue_limit: policyForm.value.issues,
        principal_limit: policyForm.value.principals,
        public_summary: policyForm.value.public_summary,
      }, method: "PUT",
    });
    showPolicy.value = false;
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

async function disablePolicy(): Promise<void> {
  const item = selectedProject.value;
  if (item === null || policy.value === null) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/projects/${item.id}/public-join?expected_version=${policy.value.project.version}`, { method: "DELETE" });
    showPolicy.value = false;
    await load();
  } catch (caught) { error.value = errorText(caught); } finally { busy.value = false; }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

watch(() => props.section, load);
onMounted(load);
</script>

<template>
  <main class="owner-page page-shell">
    <header class="owner-heading">
      <div><p class="eyebrow">Deployment Owner</p><h1>{{ t("admin.title") }}</h1></div>
      <nav class="owner-tabs" :aria-label="ui('Owner sections', 'Owner 分区')"><button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: section === tab.key }" @click="navigate(sectionPath(tab.key))">{{ tab.label }}</button></nav>
    </header>
    <p v-if="error" class="inline-alert" role="alert">{{ error }}</p>
    <PageState :loading="loading" :error="loading ? '' : ''" />

    <template v-if="!loading && section === 'overview'">
      <section class="overview-strip">
        <article><span>Service</span><strong>{{ meta?.service_version ?? "—" }}</strong><small>schema {{ meta?.schema_version ?? "—" }}</small></article>
        <article><span>Workspaces</span><strong>{{ workspaces.length }}</strong><small>{{ meta?.visible_scope.project_count ?? 0 }} Projects</small></article>
        <article><span>Principals</span><strong>{{ principals.length }}</strong><small>{{ ui("visible now", "当前可见") }}</small></article>
        <article><span>{{ ui("Recent 429", "近期 429") }}</span><strong>{{ rateSettings?.recent_429_summary.total ?? 0 }}</strong><small>{{ rateSettings?.recent_429_summary.window_seconds ?? 300 }}s {{ ui("window", "窗口") }}</small></article>
      </section>
      <section class="owner-section">
        <div class="section-heading-row"><div><h2>{{ ui("Origin & instance", "Origin 与实例") }}</h2><p>{{ meta?.instance_id }}</p></div><button class="secondary-button" type="button" @click="copyText(locale === 'zh-CN' ? '请使用 cfkanban-admin 检查并按明确计划修改 preferred API origin。' : 'Use cfkanban-admin to inspect and update the preferred API origin with an explicit plan.')">{{ t("action.copy") }}</button></div>
        <dl class="settings-list"><div><dt>{{ ui("Observed", "本次访问") }}</dt><dd>{{ meta?.observed_origin }}</dd></div><div><dt>{{ ui("Preferred", "推荐") }}</dt><dd>{{ meta?.preferred_api_origin }}</dd></div><div><dt>{{ ui("Origin version", "Origin 版本") }}</dt><dd>{{ meta?.origin_version }}</dd></div></dl>
      </section>
      <section class="owner-section">
        <div class="section-heading-row"><div><h2>{{ ui("Request gates", "请求门控") }}</h2><p>{{ locale === "zh-CN" ? "由 Worker 配置发布；此处只读。" : "Published through Worker configuration; read-only here." }}</p></div><span class="role-badge">{{ rateSettings?.configuration_source }}</span></div>
        <div class="rate-grid"><article v-for="(value, key) in rateSettings?.policies" :key="key"><span>{{ key }}</span><strong>{{ value.limit }} / {{ value.period_seconds }}s</strong><small>{{ rateSettings?.recent_429_summary.by_scope[key] ?? 0 }} {{ ui("recent", "近期") }}</small></article></div>
      </section>
    </template>

    <template v-if="!loading && section === 'workspaces'">
      <div class="section-action-bar"><p>{{ locale === "zh-CN" ? "容器操作是单项原子写入；删除为可恢复暂停。" : "Container actions are atomic; delete is a recoverable pause." }}</p><div><button class="secondary-button" type="button" @click="showWorkspace = true">+ Workspace</button><button class="primary-button" type="button" @click="showProject = true">+ Project</button></div></div>
      <p v-if="treeTruncated" class="warning-panel">{{ ui("This bounded Web view shows the first 20 Workspaces and first 20 Projects in each Workspace. Use cfkanban-admin with an explicit cursor to manage omitted containers.", "此有界 Web 视图只显示前 20 个 Workspace，以及每个 Workspace 的前 20 个 Project；管理未显示的容器请让 cfkanban-admin 使用显式 cursor。") }}</p>
      <section v-for="workspace in workspaces" :key="workspace.id" class="workspace-block">
        <header><div><small>{{ workspace.key }}</small><h2>{{ workspace.display_name }}</h2></div><div><button class="text-button" type="button" @click="openContainerEdit('workspace', workspace)">{{ ui("Rename", "改名") }}</button><button class="danger-text-button" type="button" @click="deleteContainer('workspace', workspace)">{{ t("action.delete") }}</button></div></header>
        <div class="project-table"><div v-for="item in projects.filter((project) => project.workspaceKey === workspace.key)" :key="item.id" class="project-table-row"><button class="project-link" type="button" @click="navigate(`/app/w/${workspace.key}/p/${item.key}`)"><code>{{ item.key }}</code><strong>{{ item.display_name }}</strong></button><span>{{ item.context ? `${item.context.slice(0, 60)}${item.context.length > 60 ? '…' : ''}` : '—' }}</span><div><button class="text-button" type="button" @click="openProjectSettings(item)">{{ ui("Settings", "设置") }}</button><button class="text-button" type="button" @click="openPolicy(item)">Public Join</button><button class="danger-text-button" type="button" @click="deleteContainer('project', item, workspace.key)">{{ t("action.delete") }}</button></div></div><p v-if="!projects.some((project) => project.workspaceKey === workspace.key)" class="empty-copy">{{ ui("No Projects", "暂无 Project") }}</p></div>
      </section>
      <section v-if="deletedProjects.length || deletedWorkspaces.length" class="owner-section"><h2>{{ ui("Paused containers", "已暂停容器") }}</h2><p class="muted-copy">{{ ui("Restore one container at a time. Review Public Join policies before confirming.", "逐个恢复容器；确认前先核对会重新公开的 Public Join Policy。") }}</p><div class="data-list"><div v-for="item in deletedProjects" :key="item.id" class="data-row"><span><strong>{{ item.workspaceKey }}/{{ item.key }}</strong><small>{{ item.display_name }}</small></span><span>Project · v{{ item.version }}</span><button class="secondary-button" type="button" @click="openRestore('project', item, item.workspaceKey)">{{ t("action.restore") }}</button></div><div v-for="workspace in deletedWorkspaces" :key="workspace.id" class="data-row"><span><strong>{{ workspace.key }}</strong><small>{{ workspace.display_name }}</small></span><span>Workspace · v{{ workspace.version }}</span><button class="secondary-button" type="button" @click="openRestore('workspace', workspace)">{{ t("action.restore") }}</button></div></div></section>
    </template>

    <template v-if="!loading && section === 'access'">
      <div class="section-action-bar"><p>{{ locale === "zh-CN" ? "按稳定 Principal ID 与显式 Project role 管理访问。" : "Manage access by stable Principal ID and explicit Project role." }}</p><button class="primary-button" type="button" @click="openInviteDialog">+ Invite</button></div>
      <p v-if="treeTruncated" class="warning-panel">{{ ui("Project access controls are limited to the first 20 Workspaces and first 20 Projects in each. Use cfkanban-admin with an explicit cursor for omitted Projects.", "Project 访问管理只显示前 20 个 Workspace，以及每个 Workspace 的前 20 个 Project；未显示的 Project 请让 cfkanban-admin 使用显式 cursor。") }}</p>
      <section class="owner-section"><h2>Principals</h2><div class="data-list"><button v-for="principal in principals" :key="principal.id" class="data-row data-row-button" type="button" @click="openPrincipal(principal)"><span><strong>{{ principal.display_name }}</strong><code>{{ principal.id }}</code></span><span>{{ principal.is_owner ? 'Owner' : ui('Participant', '参与者') }}</span><span>{{ principal.active_credential_count ?? 0 }} Credentials · {{ principal.active_grant_count ?? 0 }} Grants</span></button></div></section>
      <section class="owner-section"><h2>Project Grants</h2><div class="data-list"><button v-for="item in projects" :key="item.id" class="data-row data-row-button" type="button" @click="openProjectGrants(item)"><span><strong>{{ item.workspaceKey }}/{{ item.key }}</strong><small>{{ item.display_name }}</small></span><span>{{ ui("Manage explicit roles", "管理显式角色") }}</span></button></div></section>
      <section class="owner-section"><h2>{{ ui("Invitations", "邀请") }}</h2><div class="data-list"><div v-for="invitation in invitations" :key="invitation.id" class="data-row"><span><strong>{{ invitation.kind }}</strong><code>{{ invitation.code_fingerprint }}</code></span><span>{{ invitation.status }} · {{ formatTime(invitation.expires_at) }}</span><button v-if="invitation.allowed_actions.includes('revoke')" class="danger-text-button" type="button" @click="revokeInvite(invitation)">{{ ui("Revoke", "撤销") }}</button></div></div></section>
    </template>

    <template v-if="!loading && section === 'audit'">
      <section class="audit-list"><article v-for="event in audit" :key="event.id"><div><code>{{ event.type }}</code><strong>{{ event.subject.type }} · {{ event.subject.id }}</strong></div><p>{{ event.actor?.display_name ?? ui('system', '系统') }} · {{ formatTime(event.created_at) }}</p><pre>{{ JSON.stringify(event.payload, null, 2) }}</pre></article><p v-if="audit.length === 0" class="empty-copy">{{ ui("No audit events", "暂无审计事件") }}</p></section>
    </template>

    <ModalDialog v-if="showWorkspace" :busy="busy" :title="ui('Create Workspace', '创建 Workspace')" @close="showWorkspace = false"><form class="form-stack" @submit.prevent="createWorkspace"><label>Key<input v-model="workspaceForm.key" required pattern="[a-z][a-z0-9-]{1,31}" /></label><label>{{ ui("Display name", "显示名称") }}<input v-model="workspaceForm.display_name" required maxlength="128" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showWorkspace = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit">{{ t("action.save") }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showProject" :busy="busy" :title="ui('Create Project', '创建 Project')" @close="showProject = false"><form class="form-stack" @submit.prevent="createProject"><label>Workspace<select v-model="selectedWorkspace" required><option value="" disabled>{{ ui("Choose…", "请选择…") }}</option><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.key">{{ workspace.display_name }}</option></select></label><label>Key<input v-model="projectForm.key" required pattern="[A-Z][A-Z0-9-]{1,15}" /></label><label>{{ ui("Display name", "显示名称") }}<input v-model="projectForm.display_name" required maxlength="128" /></label><label>Context<textarea v-model="projectForm.context" rows="5" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showProject = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit">{{ t("action.save") }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showContainerEdit && containerEdit" :busy="busy" :title="ui('Rename container', '容器改名')" @close="showContainerEdit = false"><form class="form-stack" @submit.prevent="saveContainerEdit"><p><code>{{ containerEdit.item.key }}</code></p><label>{{ ui("Display name", "显示名称") }}<input v-model="containerEdit.display_name" required maxlength="128" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showContainerEdit = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit">{{ t("action.save") }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showProjectSettings && selectedProject" :busy="busy" :title="ui('Project settings', 'Project 设置')" @close="showProjectSettings = false"><form class="form-stack" @submit.prevent="saveProjectSettings"><p><code>{{ selectedProject.workspaceKey }}/{{ selectedProject.key }}</code> · v{{ selectedProject.version }}</p><label>{{ ui("Display name", "显示名称") }}<input v-model="projectSettingsForm.display_name" required maxlength="128" /></label><label>Context<textarea v-model="projectSettingsForm.context" rows="6" /></label><button class="primary-button" type="submit" :disabled="busy">{{ t("action.save") }}</button></form><section class="recovery-section"><h3>{{ ui("Workflow display names", "工作流显示名称") }}</h3><p class="muted-copy">{{ ui("Stable keys, order, and terminal semantics do not change.", "稳定 key、顺序和 terminal 语义不会改变。") }}</p><form v-for="status in projectStatuses" :key="status.key" class="compact-inline-form" @submit.prevent="saveStatusName(status)"><code>{{ status.key }}</code><input v-model="statusDrafts[status.key]" required maxlength="128" /><button class="text-button" type="submit" :disabled="busy || statusDrafts[status.key] === status.display_name">{{ t("action.save") }}</button></form></section></ModalDialog>
    <ModalDialog v-if="showRestore && restoreTarget" :busy="busy" :title="ui('Restore container?', '恢复容器？')" @close="showRestore = false"><p><code>{{ restoreTarget.item.key }}</code> · {{ restoreTarget.item.display_name }}</p><p class="warning-panel">{{ ui("Restoring reactivates every still-enabled Public Join policy shown below. Existing Grants remain unchanged.", "恢复会重新启用下列仍 enabled 的 Public Join Policy；既有 Grants 不会改变。") }}</p><p v-if="restoreTarget.item.resumed_public_projects?.has_more" class="inline-alert" role="alert">{{ ui("More than 100 Public Join Projects will resume. Only the first 100 are listed here; confirming still republishes every enabled policy in this container.", "将恢复超过 100 个 Public Join Project。此处只列出前 100 个；确认后仍会重新公开该容器内全部 enabled Policy。") }}</p><div class="data-list"><div v-for="publicProject in restoreTarget.item.resumed_public_projects?.projects ?? []" :key="publicProject.id" class="data-row"><span><strong>{{ publicProject.workspace_key ? `${publicProject.workspace_key}/` : '' }}{{ publicProject.key }}</strong><small>{{ publicProject.display_name ?? publicProject.id }}</small></span><span v-if="publicProject.resource_limits">{{ publicProject.role_choices?.join(' | ') }} · {{ publicProject.resource_limits.issues }}/{{ publicProject.resource_limits.comments }}/{{ publicProject.resource_limits.principals }}</span></div><p v-if="!(restoreTarget.item.resumed_public_projects?.projects.length)" class="empty-copy">{{ ui("No enabled Public Join policy will resume.", "没有 enabled Public Join Policy 会重新公开。") }}</p></div><div class="form-actions"><button class="secondary-button" type="button" @click="showRestore = false">{{ t("action.cancel") }}</button><button class="primary-button" type="button" :disabled="busy" @click="restoreContainer">{{ t("action.restore") }}</button></div></ModalDialog>
    <ModalDialog v-if="showInvite" :busy="busy" :title="ui('Create Project Invite', '创建 Project Invite')" @close="closeInviteDialog"><form class="form-stack" @submit.prevent="createInvite"><label>Project<select v-model="inviteForm.project_id" required><option value="" disabled>{{ ui("Choose…", "请选择…") }}</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.workspaceKey }}/{{ item.key }} · {{ item.display_name }}</option></select></label><label>{{ ui("Role", "角色") }}<select v-model="inviteForm.role"><option value="reader">reader</option><option value="writer">writer</option></select></label><p class="muted-copy">{{ locale === "zh-CN" ? "完整 URL 只在创建响应中出现一次；页面不会保存它。" : "The full URL appears only in the create response; this page does not store it." }}</p><textarea v-if="oneTimeInvite" :value="oneTimeInvite" readonly rows="5" /><div class="form-actions"><button v-if="oneTimeInvite" class="secondary-button" type="button" @click="copyText(oneTimeInvite)">{{ t("action.copy") }}</button><button class="primary-button" type="submit" :disabled="busy">{{ oneTimeInvite ? (locale === 'zh-CN' ? '再创建一个' : 'Create another') : t('action.save') }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showPrincipal && selectedPrincipal" :busy="busy" :title="ui('Principal access', 'Principal 访问')" @close="closePrincipal"><header class="modal-summary"><strong>{{ selectedPrincipal.display_name }}</strong><code>{{ selectedPrincipal.id }}</code><span>{{ selectedPrincipal.is_owner ? 'Owner' : ui('Participant', '参与者') }}</span></header><section class="recovery-section"><h3>Credentials</h3><div class="data-list"><div v-for="credential in selectedPrincipal.credentials" :key="credential.id" class="data-row"><span><strong>{{ credential.fingerprint }}</strong><small>{{ credential.last_used_at ? formatTime(credential.last_used_at) : ui('never used', '尚未使用') }}</small></span><button v-if="credential.allowed_actions.includes('revoke')" class="danger-text-button" type="button" @click="revokeCredential(credential)">{{ ui('Revoke', '撤销') }}</button></div></div></section><section class="recovery-section"><h3>Grants</h3><div class="data-list"><div v-for="grant in selectedPrincipal.grants" :key="grant.id" class="data-row"><span><strong>{{ grant.project.workspace_key }}/{{ grant.project.key }}</strong><small>{{ grant.role }} · {{ grant.revoked_at ? ui('revoked', '已撤销') : ui('active', 'active') }}</small></span></div></div></section><form v-if="!selectedPrincipal.is_owner" class="form-stack warning-panel" @submit.prevent="createRecoveryInvite"><h3>{{ ui('Principal recovery invite', 'Principal 恢复邀请') }}</h3><label>{{ ui('Recovery mode', '恢复模式') }}<select v-model="recoveryForm.mode"><option value="rotation">rotation · {{ ui('revoke the credential used to redeem', '仅撤销本次兑换所用旧 Credential') }}</option><option value="full_recovery">full_recovery · {{ ui('revoke all prior credentials', '撤销全部 prior Credentials') }}</option></select></label><button class="primary-button" type="submit" :disabled="busy">{{ ui('Create one-time recovery URL', '创建一次性恢复 URL') }}</button><textarea v-if="oneTimeInvite" :value="oneTimeInvite" readonly rows="5" /><button v-if="oneTimeInvite" class="secondary-button" type="button" @click="copyText(oneTimeInvite)">{{ t("action.copy") }}</button></form></ModalDialog>
    <ModalDialog v-if="showGrant && selectedGrantProject" :busy="busy" :title="ui('Project Grants', 'Project Grants')" @close="showGrant = false"><p><code>{{ selectedGrantProject.workspaceKey }}/{{ selectedGrantProject.key }}</code> · {{ selectedGrantProject.display_name }}</p><form class="compact-inline-form" @submit.prevent="createGrant"><input v-model="grantForm.principal_id" required placeholder="Principal ID" /><select v-model="grantForm.role"><option value="reader">reader</option><option value="writer">writer</option></select><button class="primary-button" type="submit" :disabled="busy">{{ ui('Grant', '授予') }}</button></form><div class="data-list"><div v-for="grant in projectGrants" :key="grant.id" class="data-row"><span><strong>{{ grant.principal.display_name }}</strong><code>{{ grant.principal_id }}</code></span><select :value="grant.role" :disabled="busy || grant.revoked_at !== null" @change="setGrantRole(grant, ($event.target as HTMLSelectElement).value as 'reader' | 'writer')"><option value="reader">reader</option><option value="writer">writer</option></select><div><button v-if="grant.revoked_at === null" class="danger-text-button" type="button" @click="revokeGrant(grant)">{{ ui('Revoke', '撤销') }}</button><button v-else class="secondary-button" type="button" @click="setGrantRole(grant, grant.role)">{{ ui('Regrant', '重新授予') }}</button></div></div></div></ModalDialog>
    <ModalDialog v-if="showPolicy" :busy="busy" title="Public Join" @close="showPolicy = false"><form class="form-stack" @submit.prevent="savePolicy"><p class="warning-panel">{{ locale === "zh-CN" ? "公开 writer 可修改、完成和软删除 Project 内容。三项 quota 只在此 Project 公开期间约束新增计数；关闭不会撤销既有 Grants。" : "Public writers can modify, complete, and soft-delete Project content. These quotas gate growth only while this Project is public; disabling does not revoke existing Grants." }}</p><label>{{ ui("Public summary", "公开摘要") }}<textarea v-model="policyForm.public_summary" rows="4" required /></label><div class="form-grid"><label>Issues<input v-model.number="policyForm.issues" type="number" min="1" required /></label><label>Comments<input v-model.number="policyForm.comments" type="number" min="1" required /></label><label>Principals<input v-model.number="policyForm.principals" type="number" min="1" required /></label></div><p v-if="policy" class="muted-copy">{{ ui("Active", "当前 active") }}: {{ policy.active_usage.issues }} issues · {{ policy.active_usage.comments }} comments · {{ policy.active_usage.principals }} principals</p><div class="form-actions"><button v-if="policy?.enabled" class="danger-button" type="button" :disabled="busy" @click="disablePolicy">{{ ui("Disable", "关闭") }}</button><button class="primary-button" type="submit" :disabled="busy">{{ policy?.enabled ? ui('Update policy', '更新 Policy') : ui('Enable Public Join', '开启 Public Join') }}</button></div></form></ModalDialog>
  </main>
</template>
