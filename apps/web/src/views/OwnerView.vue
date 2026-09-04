<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import CasConflictNotice from "../components/CasConflictNotice.vue";
import ModalDialog from "../components/ModalDialog.vue";
import PageState from "../components/PageState.vue";
import { ApiProblem, apiRequest, clearPendingRequestIntents } from "../lib/api";
import {
  type CasConflictState,
  captureCasConflict,
  markCasReadbackComplete,
  markCasReadbackFailed,
} from "../lib/cas-recovery";
import { locale, t } from "../lib/i18n";
import { localizedText, type LocalizedText, useLocalizedError } from "../lib/localized-error";
import {
  canConfirmInvitationReview,
  type InvitationCreateWriteResult,
  InvitationRecoveryBlockedError,
  InvitationRecoveryCoordinator,
  InvitationRecoveryExpiredError,
  type InvitationRecoveryExclusiveLock,
  type InvitationRecoveryRecord,
  invitationOutcomeRequiresReview,
  invitationRecoveryCanRetry,
  type InvitationRequestBody,
  isInvitationCreateWriteResult,
} from "../lib/invitation-recovery";
import { continuationCursor, cursorRequiresRestart, mergePageById } from "../lib/pagination";
import { publicJoinRiskNotice } from "../lib/public-join-risk";
import { navigate } from "../lib/router";
import { WriteFence } from "../lib/write-fence";
import type {
  ContainerResource,
  CredentialResource,
  EventResource,
  GrantResource,
  InvitationResource,
  ListResult,
  MetaResource,
  PrincipalPasskey,
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
const {
  appendError,
  clearError,
  error,
  setError,
  setErrorKey,
  setLocalizedError,
} = useLocalizedError();
const casConflict = ref<CasConflictState | null>(null);
const treeTruncated = ref(false);
const meta = ref<MetaResource | null>(null);
const rateSettings = ref<RateLimitSettings | null>(null);
const workspaces = ref<ContainerResource[]>([]);
const projects = ref<ProjectEntry[]>([]);
const deletedWorkspaces = ref<ContainerResource[]>([]);
const deletedProjects = ref<ProjectEntry[]>([]);
const principals = ref<PrincipalResource[]>([]);
const principalsHasMore = ref(false);
const principalsNextCursor = ref<string | null>(null);
const principalsLoadingMore = ref(false);
const principalQuery = ref("");
const principalProjectId = ref("");
const invitations = ref<InvitationResource[]>([]);
const audit = ref<EventResource[]>([]);
const auditNextCursor = ref<string | null>(null);
const auditLoadingMore = ref(false);
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
const inviteNeedsReview = ref(true);
const inviteReviewReady = ref(false);
const inviteReviewStartedAt = ref<number | null>(null);
const invitationsHasMore = ref(false);
const invitationsNextCursor = ref<string | null>(null);
const {
  clearError: clearInviteRecoveryNotice,
  error: inviteRecoveryNotice,
  setLocalizedTextError: setInviteRecoveryNotice,
} = useLocalizedError();
const invitationCoordinationReady = ref(false);
const invitationRecoveryRecord = ref<InvitationRecoveryRecord | null>(null);
const invitationReviewRecord = ref<InvitationRecoveryRecord | null>(null);
const presentedInvitationRecord = ref<InvitationRecoveryRecord | null>(null);
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
const principalCredentialsNextCursor = ref<string | null>(null);
const principalCredentialsLoadingMore = ref(false);
const selectedGrantProject = ref<ProjectEntry | null>(null);
const projectGrants = ref<GrantResource[]>([]);
const projectGrantsNextCursor = ref<string | null>(null);
const projectGrantsLoadingMore = ref(false);
const grantForm = ref({ principal_id: "", role: "writer" as "reader" | "writer" });
const recoveryForm = ref({ mode: "rotation" as "rotation" | "full_recovery", principal_id: "" });
const recoveryConfirmed = ref(false);
const policyRiskConfirmed = ref(false);
let projectSettingsRequestId = 0;
let policyRequestId = 0;
let invitationReviewGeneration = 0;
let invitationRecoveryCoordinator: InvitationRecoveryCoordinator | null = null;
let ownerViewMounted = false;
const writeFence = new WriteFence();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let casRecoveryGeneration = 0;
let casReadback: (() => Promise<void>) | null = null;
let casReadbackInFlight = false;

function ui(english: string, chinese: string): string {
  return locale.value === "zh-CN" ? chinese : english;
}

function roleLabel(role: string): string {
  if (locale.value !== "zh-CN") return role;
  if (role === "owner") return "所有者";
  if (role === "writer") return "协作者";
  if (role === "reader") return "只读者";
  return role;
}

function invitationKindLabel(kind: string): string {
  if (locale.value !== "zh-CN") return kind;
  return kind === "project_grant" ? "项目授权邀请" : kind === "principal_recovery" ? "身份恢复邀请" : kind;
}

function invitationStatusLabel(status: string): string {
  if (locale.value !== "zh-CN") return status;
  return ({ active: "有效", expired: "已过期", redeemed: "已兑换", revoked: "已撤销" } as Record<string, string>)[status] ?? status;
}

function rateScopeLabel(scope: string): string {
  if (locale.value !== "zh-CN") return scope;
  return ({ instance: "实例", principal: "单一身份", unauthenticated_sensitive: "未认证敏感操作" } as Record<string, string>)[scope] ?? scope;
}

function handleCursorError(caught: unknown, retire: () => void): void {
  if (cursorRequiresRestart(caught)) {
    retire();
    setLocalizedError(
      "The list scope or Owner visibility changed, so the old cursor was retired. Start a fresh read before continuing.",
      "列表范围或所有者可见权限已变化，原分页位置已失效。请重新读取后再继续。",
    );
    return;
  }
  setError(caught);
}

async function recoverCasConflict(
  caught: unknown,
  resource: string | LocalizedText,
  draft: unknown,
  readback: () => Promise<void>,
): Promise<boolean> {
  const conflict = captureCasConflict(caught, resource, draft);
  if (conflict === null) return false;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  casReadback = readback;
  casConflict.value = conflict;
  setErrorKey("error.conflict");
  try {
    await readback();
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(conflict);
  } catch {
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(conflict);
  }
  return true;
}

function dismissCasConflict(): void {
  casRecoveryGeneration += 1;
  casConflict.value = null;
  casReadback = null;
}

async function refreshCasFacts(): Promise<void> {
  const conflict = casConflict.value;
  const readback = casReadback;
  if (conflict === null || readback === null || casReadbackInFlight) return;
  const recoveryGeneration = casRecoveryGeneration + 1;
  casRecoveryGeneration = recoveryGeneration;
  const pending = { ...conflict, readbackState: "pending" as const };
  casConflict.value = pending;
  casReadbackInFlight = true;
  try {
    await readback();
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackComplete(pending);
  } catch {
    if (casRecoveryGeneration === recoveryGeneration) casConflict.value = markCasReadbackFailed(pending);
  } finally {
    casReadbackInFlight = false;
  }
}

async function loadPrincipals(reset = true): Promise<void> {
  if (!reset && principalsNextCursor.value === null) return;
  principalsLoadingMore.value = true;
  try {
    const query = principalQuery.value.trim();
    if (reset && UUID_PATTERN.test(query) && principalProjectId.value === "") {
      const exact = await apiRequest<PrincipalResource>(`/api/v1/admin/principals/${encodeURIComponent(query)}`);
      principals.value = [exact];
      principalsHasMore.value = false;
      principalsNextCursor.value = null;
      return;
    }
    const params = new URLSearchParams({ limit: "100" });
    if (query) params.set("q", query);
    if (principalProjectId.value) params.set("project_id", principalProjectId.value);
    if (!reset && principalsNextCursor.value !== null) params.set("cursor", principalsNextCursor.value);
    const result = await apiRequest<ListResult<PrincipalResource>>(`/api/v1/admin/principals?${params}`);
    principals.value = mergePageById(principals.value, result.items, reset);
    principalsHasMore.value = result.has_more;
    principalsNextCursor.value = continuationCursor(result);
  } catch (caught) {
    if (!reset) handleCursorError(caught, () => {
      principalsHasMore.value = false;
      principalsNextCursor.value = null;
    });
    else setError(caught);
    if (reset) {
      principals.value = [];
      principalsHasMore.value = false;
      principalsNextCursor.value = null;
    }
  } finally {
    principalsLoadingMore.value = false;
  }
}

async function copyText(value: string): Promise<void> {
  try {
    await window.navigator.clipboard.writeText(value);
  } catch {
    setLocalizedError(
      "Copy was not allowed; select the text manually.",
      "浏览器未允许复制，请手动选择文本。",
    );
  }
}

function openInviteDialog(): void {
  if (inviteNeedsReview.value) return;
  oneTimeInvite.value = "";
  showInvite.value = true;
}

function closeInviteDialog(): void {
  oneTimeInvite.value = "";
  showInvite.value = false;
}

function closeProjectSettings(): void {
  projectSettingsRequestId += 1;
  projectStatuses.value = [];
  statusDrafts.value = {};
  selectedProject.value = null;
  showProjectSettings.value = false;
  busy.value = false;
}

function closePolicy(): void {
  policyRequestId += 1;
  policy.value = null;
  selectedProject.value = null;
  policyRiskConfirmed.value = false;
  showPolicy.value = false;
  busy.value = false;
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

function invalidateInvitationReview(): void {
  invitationReviewGeneration += 1;
  inviteReviewReady.value = false;
  inviteReviewStartedAt.value = null;
  invitationReviewRecord.value = null;
  invitations.value = [];
  invitationsHasMore.value = false;
  invitationsNextCursor.value = null;
}

async function readInvitationsForReview(reset = true): Promise<void> {
  if (reset) {
    invalidateInvitationReview();
    const coordinator = invitationRecoveryCoordinator;
    const current = coordinator?.read() ?? null;
    if (current === null) {
      inviteReviewStartedAt.value = Date.now();
    } else if (!invitationRecoveryCanRetry(current)) {
      // Acquire the request-lifetime Web Lock before starting the first page.
      // The persisted revision returned here is the only recovery generation
      // that this complete cursor walk may later settle.
      const prepared = await coordinator?.prepareReview(current);
      if (prepared === undefined) throw new Error("Shared Invitation recovery is unavailable.");
      invalidateInvitationReview();
      invitationRecoveryRecord.value = prepared;
      invitationReviewRecord.value = prepared;
      if (presentedInvitationRecord.value?.marker === prepared.marker) {
        presentedInvitationRecord.value = prepared;
      }
      inviteReviewStartedAt.value = Date.now();
    } else {
      invitationRecoveryRecord.value = current;
    }
  } else {
    inviteReviewReady.value = false;
  }
  const generation = invitationReviewGeneration;
  const params = new URLSearchParams({ limit: "100" });
  if (!reset && invitationsNextCursor.value !== null) params.set("cursor", invitationsNextCursor.value);
  const result = await apiRequest<ListResult<InvitationResource>>(`/api/v1/admin/invitations?${params}`);
  if (generation !== invitationReviewGeneration) return;
  const merged = reset ? result.items : [...invitations.value, ...result.items];
  invitations.value = [...new Map(merged.map((invitation) => [invitation.id, invitation])).values()];
  invitationsHasMore.value = result.has_more;
  invitationsNextCursor.value = continuationCursor(result);
  inviteReviewReady.value = true;
}

function lockInvitationCreation(message: LocalizedText): void {
  inviteNeedsReview.value = true;
  invalidateInvitationReview();
  setInviteRecoveryNotice(message);
}

function committedInvitationResolved(): boolean {
  const record = invitationRecoveryRecord.value;
  if (record?.state !== "committed_unavailable") return false;
  const invitation = invitations.value.find((item) => item.id === record.invitation_id);
  return invitation !== undefined && invitation.status !== "active";
}

async function confirmInvitationReview(): Promise<void> {
  if (!invitationCoordinationReady.value || !canConfirmInvitationReview(
    inviteReviewReady.value,
    invitationsHasMore.value,
    invitationRecoveryRecord.value,
    inviteReviewStartedAt.value,
    Date.now(),
    committedInvitationResolved(),
  )) return;
  const record = invitationRecoveryRecord.value;
  if (record !== null) {
    const reviewed = invitationReviewRecord.value;
    if (reviewed === null || !await settleInvitationRecovery(reviewed)) return;
  }
  clearPendingRequestIntents("POST", "/api/v1/admin/invitations");
  inviteNeedsReview.value = false;
  clearInviteRecoveryNotice();
}

async function refreshInvitationReview(): Promise<void> {
  busy.value = true;
  clearError();
  try {
    await readInvitationsForReview(true);
  } catch (caught) {
    setError(caught);
  } finally {
    busy.value = false;
  }
}

async function continueInvitationReview(): Promise<void> {
  if (invitationsNextCursor.value === null) return;
  busy.value = true;
  clearError();
  try {
    await readInvitationsForReview(false);
  } catch (caught) {
    handleCursorError(caught, invalidateInvitationReview);
  } finally {
    busy.value = false;
  }
}

function sharedInvitationRecoveryMessage(): LocalizedText {
  return localizedText(
    "Another tab or an earlier request has an Invitation operation whose result is not yet proven. Recover that exact operation before creating another capability.",
    "另一个标签页或先前请求仍有一项结果尚未确定的邀请操作。请先恢复该同一操作，再创建新的一次性权限。",
  );
}

function applySharedInvitationRecovery(record: InvitationRecoveryRecord): void {
  invitationRecoveryRecord.value = record;
  lockInvitationCreation(sharedInvitationRecoveryMessage());
}

function onInvitationRecoveryStorage(event: StorageEvent): void {
  const coordinator = invitationRecoveryCoordinator;
  if (coordinator === null || event.key !== coordinator.storageKey) return;
  if (event.newValue === null) {
    invitationRecoveryRecord.value = null;
    lockInvitationCreation(localizedText(
      "The other tab proved the operation ended. Refresh and review the complete Invitation list before unlocking this tab.",
      "另一个标签页已证明该操作结束。请刷新并检查完整邀请列表，再解锁本标签页。",
    ));
    return;
  }
  const record = coordinator.readStorageValue(event.newValue);
  if (record === null) {
    invitationCoordinationReady.value = false;
    lockInvitationCreation(localizedText(
      "The shared recovery state is invalid. Keep creation locked and use cfkanban-admin to inspect Invitations.",
      "共享恢复状态无效。请保持创建锁定，并使用 cfkanban-admin 检查邀请。",
    ));
    return;
  }
  applySharedInvitationRecovery(record);
}

function initializeInvitationRecovery(): void {
  try {
    if (window.navigator.locks === undefined) {
      throw new Error("Web Locks are unavailable.");
    }
    const probeKey = `cfkanban.invitation-recovery.probe.${crypto.randomUUID()}`;
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    const runExclusive: InvitationRecoveryExclusiveLock = (name, callback) => (
      window.navigator.locks.request(name, { mode: "exclusive" }, callback)
    );
    invitationRecoveryCoordinator = new InvitationRecoveryCoordinator(
      props.session.principal.id,
      window.localStorage,
      runExclusive,
    );
    invitationCoordinationReady.value = true;
    window.addEventListener("storage", onInvitationRecoveryStorage);
    const record = invitationRecoveryCoordinator.read();
    if (record !== null) applySharedInvitationRecovery(record);
  } catch {
    invitationRecoveryCoordinator = null;
    invitationCoordinationReady.value = false;
    lockInvitationCreation(localizedText(
      "This browser cannot maintain the non-secret shared recovery lock. Invitation creation stays disabled; use cfkanban-admin instead.",
      "此浏览器无法维护非秘密的共享恢复锁。邀请创建将保持禁用；请改用 cfkanban-admin。",
    ));
  }
}

async function settleInvitationRecovery(record: InvitationRecoveryRecord): Promise<boolean> {
  const coordinator = invitationRecoveryCoordinator;
  if (coordinator === null) return false;
  try {
    const settled = await coordinator.settle(record);
    if (!settled) {
      const current = coordinator.read();
      if (current !== null) {
        applySharedInvitationRecovery(current);
        return false;
      }
      invalidateInvitationReview();
    }
    invitationRecoveryRecord.value = null;
    if (settled) invalidateInvitationReview();
    return true;
  } catch {
    invitationCoordinationReady.value = false;
    lockInvitationCreation(localizedText(
      "The shared recovery lock could not be safely cleared. Keep creation disabled and use cfkanban-admin.",
      "共享恢复锁无法安全清除。请保持创建禁用，并使用 cfkanban-admin。",
    ));
    return false;
  }
}

async function handleInvitationCreateFailure(
  caught: unknown,
  kind: "Invite" | "recovery URL",
  recoveryAttempt = false,
  operationRecord: InvitationRecoveryRecord | null = null,
): Promise<void> {
  if (caught instanceof InvitationRecoveryExpiredError) setErrorKey("error.idempotencyExpired");
  else setError(caught);
  if (caught instanceof InvitationRecoveryBlockedError) {
    applySharedInvitationRecovery(caught.record);
  }
  const failure = caught instanceof ApiProblem
    ? { code: caught.body.code, status: caught.status }
    : null;
  if (!recoveryAttempt && !invitationOutcomeRequiresReview(failure)) {
    // Settle only the marker/state captured by this request. A storage event
    // may already have advanced the shared record in another tab.
    if (operationRecord !== null && await settleInvitationRecovery(operationRecord)) {
      try {
        await readInvitationsForReview(true);
      } catch (readbackFailure) {
        appendError(readbackFailure);
      }
    }
    return;
  }
  lockInvitationCreation(localizedText(
    `The ${kind} result is uncertain and its bearer URL cannot be reconstructed. Retry the exact stored operation with the same Idempotency-Key; an immediate list snapshot cannot prove the original POST has ended.`,
    `${kind === "Invite" ? "邀请" : "恢复网址"}的提交结果不确定，一次性访问网址也无法重建。请使用相同的幂等键（Idempotency-Key）恢复已保存的同一操作；即时列表快照不能证明原创建请求已结束。`,
  ));
  try {
    await readInvitationsForReview(true);
  } catch (readbackFailure) {
    appendError(readbackFailure);
  }
}

async function finishInvitationOperation(
  result: InvitationCreateWriteResult,
  committed: InvitationRecoveryRecord,
  recovered: boolean,
): Promise<void> {
  // A successful HTTP response proves the operation committed, but it does not
  // prove that a still-mounted page presented the one-time secret to the Owner.
  // Keep the non-secret shared record until the visible page explicitly
  // acknowledges that the URL was saved. An unmounted view must never clear it.
  if (!ownerViewMounted) return;
  invitationRecoveryRecord.value = committed;
  invalidateInvitationReview();
  if (!result.resource.secret_available) {
    invitationRecoveryRecord.value = committed;
    lockInvitationCreation(localizedText(
      `The committed Invitation ${result.resource.id} cannot reproduce its bearer URL. Revoke that exact capability (or wait until it is no longer active), load the complete list, then confirm before creating another one.`,
      `已提交的邀请 ${result.resource.id} 无法重建一次性访问网址。请撤销这项权限（或等待其不再有效）、读完完整列表并确认后，再创建下一项。`,
    ));
  } else {
    oneTimeInvite.value = result.resource.copy_text;
    presentedInvitationRecord.value = committed;
    lockInvitationCreation(localizedText(
      recovered
        ? "The exact operation was recovered and its one-time URL is shown below. Save it and explicitly confirm before this shared recovery lock is cleared."
        : "The Invitation committed and its one-time URL is shown below. Save it and explicitly confirm before this shared recovery lock is cleared.",
      recovered
        ? "同一操作已恢复，一次性网址显示如下。请保存并显式确认后，才会清除共享恢复锁。"
        : "邀请已提交，一次性网址显示如下。请保存并显式确认后，才会清除共享恢复锁。",
    ));
  }
  try {
    await readInvitationsForReview(true);
  } catch (caught) {
    setError(caught);
  }
}

async function executeNewInvitationOperation(
  body: InvitationRequestBody,
  onRecord: (record: InvitationRecoveryRecord) => void,
): Promise<{ committed: InvitationRecoveryRecord; result: InvitationCreateWriteResult }> {
  let committedRecord: InvitationRecoveryRecord | null = null;
  const result = await apiRequest<InvitationCreateWriteResult>("/api/v1/admin/invitations", {
    body,
    coordinateIdempotencyIntent: async (acquireIntent, execute) => {
      const coordinator = invitationRecoveryCoordinator;
      if (coordinator === null) throw new Error("Shared Invitation recovery is unavailable.");
      return coordinator.runNewOperation(acquireIntent, body, async (lease, intent) => {
        invitationRecoveryRecord.value = lease.record;
        onRecord(lease.record);
        invalidateInvitationReview();
        try {
          const response = await execute(intent);
          const committed = lease.markCommittedUnavailable(response.resource.id);
          if (committed === null) {
            throw new Error("The committed Invitation could not be bound to the shared recovery lock.");
          }
          committedRecord = committed;
          return response;
        } catch (caught) {
          const failure = caught instanceof ApiProblem
            ? { code: caught.body.code, status: caught.status }
            : null;
          if (!invitationOutcomeRequiresReview(failure)) {
            lease.settle();
          } else {
            // Fence every list review that began while this POST was still in
            // flight. A queued confirmation may run only after the lock is
            // released, so marker/state alone cannot distinguish its stale
            // snapshot from a post-failure readback.
            const retained = lease.retainPendingAfterUncertainResult();
            if (retained !== null) {
              invitationRecoveryRecord.value = retained;
              onRecord(retained);
              invalidateInvitationReview();
            }
          }
          throw caught;
        }
      });
    },
    method: "POST",
    validateResponse: (value) => isInvitationCreateWriteResult(value, body),
  });
  if (committedRecord === null) {
    throw new Error("The Invitation recovery record was not committed.");
  }
  return { committed: committedRecord, result };
}

async function acknowledgePresentedInvitation(): Promise<void> {
  const record = presentedInvitationRecord.value;
  if (record === null || oneTimeInvite.value === "") return;
  if (!await settleInvitationRecovery(record)) return;
  clearPendingRequestIntents("POST", "/api/v1/admin/invitations");
  presentedInvitationRecord.value = null;
  inviteNeedsReview.value = false;
  clearInviteRecoveryNotice();
}

async function recoverInvitationOperation(): Promise<void> {
  if (busy.value) return;
  const record = invitationRecoveryRecord.value;
  if (record === null || !invitationRecoveryCanRetry(record)) return;
  const coordinator = invitationRecoveryCoordinator;
  if (coordinator === null) return;
  busy.value = true;
  clearError();
  try {
    let committedRecord: InvitationRecoveryRecord | null = null;
    const result = await coordinator.runExistingOperation(record, async (lease) => {
      try {
        const response = await apiRequest<InvitationCreateWriteResult>("/api/v1/admin/invitations", {
          body: record.body,
          idempotencyKey: record.idempotency_key,
          method: "POST",
          validateResponse: (value) => isInvitationCreateWriteResult(value, record.body),
        });
        const committed = lease.markCommittedUnavailable(response.resource.id);
        if (committed === null) {
          throw new Error("The recovered Invitation could not be bound to the shared recovery lock.");
        }
        committedRecord = committed;
        return response;
      } catch (caught) {
        const retained = lease.retainPendingAfterUncertainResult();
        if (retained !== null) {
          invitationRecoveryRecord.value = retained;
          invalidateInvitationReview();
        }
        throw caught;
      }
    });
    if (committedRecord === null) throw new Error("The recovered Invitation record was not committed.");
    await finishInvitationOperation(result, committedRecord, true);
  } catch (caught) {
    await handleInvitationCreateFailure(caught, record.body.kind === "project_grant" ? "Invite" : "recovery URL", true);
  } finally {
    busy.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  clearError();
  try {
    if (props.section === "overview") {
      const [metaResult, rateResult, workspaceResult] = await Promise.all([
        apiRequest<MetaResource>("/api/v1/meta"),
        apiRequest<RateLimitSettings>("/api/v1/admin/rate-limit-settings"),
        apiRequest<ListResult<ContainerResource>>("/api/v1/workspaces?limit=100"),
        loadPrincipals(true),
      ]);
      meta.value = metaResult;
      rateSettings.value = rateResult;
      workspaces.value = workspaceResult.items;
    } else if (props.section === "workspaces") {
      await loadWorkspaceTree(true);
    } else if (props.section === "access") {
      await loadWorkspaceTree(false);
      await Promise.all([
        loadPrincipals(true),
        readInvitationsForReview(),
      ]);
    } else {
      await loadAudit(true);
    }
    emit("context", { label: t("admin.title"), role: "owner" });
  } catch (caught) {
    setError(caught);
  } finally {
    loading.value = false;
  }
}

async function loadAudit(reset = false): Promise<void> {
  if (!reset && auditNextCursor.value === null) return;
  auditLoadingMore.value = !reset;
  try {
    const params = new URLSearchParams({ limit: "100" });
    if (!reset && auditNextCursor.value !== null) params.set("after", auditNextCursor.value);
    const result = await apiRequest<ListResult<EventResource>>(`/api/v1/admin/audit-events?${params}`);
    audit.value = mergePageById(audit.value, result.items, reset);
    auditNextCursor.value = continuationCursor(result);
  } catch (caught) {
    if (!reset) handleCursorError(caught, () => { auditNextCursor.value = null; });
    else setError(caught);
  } finally {
    auditLoadingMore.value = false;
  }
}

async function createWorkspace(): Promise<void> {
  const fenceKey = "workspace-create";
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest("/api/v1/workspaces", { body: workspaceForm.value, method: "POST" });
    showWorkspace.value = false;
    workspaceForm.value = { display_name: "", key: "" };
    await load();
  } catch (caught) { setError(caught); } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function createProject(): Promise<void> {
  if (!selectedWorkspace.value) return;
  const fenceKey = `project-create:${selectedWorkspace.value}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/workspaces/${encodeURIComponent(selectedWorkspace.value)}/projects`, {
      body: { ...projectForm.value, context: projectForm.value.context || null }, method: "POST",
    });
    showProject.value = false;
    projectForm.value = { context: "", display_name: "", key: "" };
    await load();
  } catch (caught) { setError(caught); } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function deleteContainer(kind: "workspace" | "project", item: ContainerResource, workspaceKey?: string): Promise<void> {
  if (!window.confirm(`${t("action.delete")}: ${item.display_name}?`)) return;
  const fenceKey = `container-delete:${item.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    const path = kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(item.key)}`
      : `/api/v1/workspaces/${encodeURIComponent(workspaceKey ?? "")}/projects/${encodeURIComponent(item.key)}`;
    await apiRequest(`${path}?expected_version=${item.version}`, { method: "DELETE" });
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `${kind === "workspace" ? "Workspace" : "Project"} ${item.key}`,
      `${kind === "workspace" ? "工作区" : "项目"} ${item.key}`,
    ), { action: "delete" }, () => loadWorkspaceTree(true))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
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

async function refreshContainerEditFacts(
  target: { display_name: string; kind: "workspace" | "project"; item: ContainerResource; workspace_key?: string },
): Promise<void> {
  await loadWorkspaceTree(true);
  const current = target.kind === "workspace"
    ? workspaces.value.find((entry) => entry.id === target.item.id)
    : projects.value.find((entry) => entry.id === target.item.id);
  if (current !== undefined && containerEdit.value?.item.id === target.item.id) {
    containerEdit.value = { ...target, item: current };
  }
}

async function saveContainerEdit(): Promise<void> {
  const target = containerEdit.value;
  if (target === null || !target.display_name.trim()) return;
  const fenceKey = `container-update:${target.item.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    const path = target.kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(target.item.key)}`
      : `/api/v1/workspaces/${encodeURIComponent(target.workspace_key ?? "")}/projects/${encodeURIComponent(target.item.key)}`;
    await apiRequest(path, {
      body: { display_name: target.display_name.trim(), expected_version: target.item.version },
      method: "PATCH",
    });
    dismissCasConflict();
    showContainerEdit.value = false;
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `${target.kind === "workspace" ? "Workspace" : "Project"} ${target.item.key}`,
      `${target.kind === "workspace" ? "工作区" : "项目"} ${target.item.key}`,
    ), {
      display_name: target.display_name,
    }, () => refreshContainerEditFacts(target))) setError(caught);
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function openProjectSettings(item: ProjectEntry): Promise<void> {
  const requestId = projectSettingsRequestId + 1;
  projectSettingsRequestId = requestId;
  selectedProject.value = item;
  projectStatuses.value = [];
  statusDrafts.value = {};
  projectSettingsForm.value = { context: item.context ?? "", display_name: item.display_name };
  showProjectSettings.value = true;
  busy.value = true;
  try {
    const result = await apiRequest<ListResult<ProjectStatusResource>>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}/statuses`,
    );
    if (requestId !== projectSettingsRequestId || selectedProject.value?.id !== item.id) return;
    projectStatuses.value = result.items;
    statusDrafts.value = Object.fromEntries(result.items.map((status) => [status.key, status.display_name]));
  } catch (caught) {
    if (requestId === projectSettingsRequestId) {
      setError(caught);
      closeProjectSettings();
    }
  } finally { if (requestId === projectSettingsRequestId) busy.value = false; }
}

async function refreshProjectSettingsFacts(item: ProjectEntry): Promise<void> {
  const [projectResult, statusResult] = await Promise.all([
    apiRequest<ContainerResource>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}`,
    ),
    apiRequest<ListResult<ProjectStatusResource>>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}/statuses`,
    ),
  ]);
  if (selectedProject.value?.id !== item.id) return;
  selectedProject.value = { ...projectResult, workspaceKey: item.workspaceKey };
  projectStatuses.value = statusResult.items;
}

async function saveProjectSettings(): Promise<void> {
  const item = selectedProject.value;
  if (item === null || !projectSettingsForm.value.display_name.trim()) return;
  const fenceKey = `project-settings:${item.id}`;
  if (!writeFence.enter(fenceKey)) return;
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
    dismissCasConflict();
    const updated = { ...result.resource, workspaceKey: item.workspaceKey };
    selectedProject.value = updated;
    projectStatuses.value = projectStatuses.value.map((status) => ({ ...status, version: updated.version }));
    projectSettingsForm.value = { context: updated.context ?? "", display_name: updated.display_name };
    await loadWorkspaceTree(true);
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `Project ${item.workspaceKey}/${item.key}`,
      `项目 ${item.workspaceKey}/${item.key}`,
    ), projectSettingsForm.value, () => refreshProjectSettingsFacts(item))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function saveStatusName(status: ProjectStatusResource): Promise<void> {
  const item = selectedProject.value;
  const displayName = statusDrafts.value[status.key]?.trim();
  if (item === null || !displayName || displayName === status.display_name) return;
  const fenceKey = `project-status:${item.id}:${status.key}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    const result = await apiRequest<WriteResult<ProjectStatusResource>>(
      `/api/v1/workspaces/${encodeURIComponent(item.workspaceKey)}/projects/${encodeURIComponent(item.key)}/statuses/${status.key}`,
      { body: { display_name: displayName, expected_version: status.version }, method: "PATCH" },
    );
    dismissCasConflict();
    projectStatuses.value = projectStatuses.value.map((entry) => (
      entry.key === status.key
        ? result.resource
        : { ...entry, version: result.resource.version }
    ));
    statusDrafts.value = { ...statusDrafts.value, [status.key]: result.resource.display_name };
    if (selectedProject.value !== null) selectedProject.value.version = result.resource.version;
    projects.value = projects.value.map((entry) => entry.id === item.id ? { ...entry, version: result.resource.version } : entry);
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `Project status ${status.key}`,
      `项目状态 ${status.key}`,
    ), { display_name: displayName }, () => refreshProjectSettingsFacts(item))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function openRestore(kind: "workspace" | "project", item: ContainerResource, workspaceKey?: string): Promise<void> {
  busy.value = true;
  clearError();
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
    setError(caught);
  } finally {
    busy.value = false;
  }
}

async function refreshRestoreTargetFacts(
  target: { kind: "workspace" | "project"; item: ContainerResource; workspace_key?: string },
): Promise<void> {
  await loadWorkspaceTree(true);
  const path = target.kind === "workspace"
    ? `/api/v1/workspaces/${encodeURIComponent(target.item.key)}?deleted=only`
    : `/api/v1/workspaces/${encodeURIComponent(target.workspace_key ?? "")}/projects/${encodeURIComponent(target.item.key)}?deleted=only`;
  const current = await apiRequest<ContainerResource>(path);
  if (restoreTarget.value?.item.id === target.item.id) restoreTarget.value = { ...target, item: current };
}

async function restoreContainer(): Promise<void> {
  const target = restoreTarget.value;
  if (target === null) return;
  const fenceKey = `container-restore:${target.item.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    const path = target.kind === "workspace"
      ? `/api/v1/workspaces/${encodeURIComponent(target.item.key)}/commands/restore`
      : `/api/v1/workspaces/${encodeURIComponent(target.workspace_key ?? "")}/projects/${encodeURIComponent(target.item.key)}/commands/restore`;
    await apiRequest(path, { body: { expected_version: target.item.version }, method: "POST" });
    showRestore.value = false;
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `${target.kind === "workspace" ? "Workspace" : "Project"} ${target.item.key}`,
      `${target.kind === "workspace" ? "工作区" : "项目"} ${target.item.key}`,
    ), { action: "restore" }, () => refreshRestoreTargetFacts(target))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function openPrincipal(principal: PrincipalResource): Promise<void> {
  busy.value = true;
  clearError();
  try {
    oneTimeInvite.value = "";
    await refreshPrincipalFacts(principal, false);
    recoveryForm.value = { mode: "rotation", principal_id: principal.id };
    recoveryConfirmed.value = false;
    showPrincipal.value = true;
  } catch (caught) { setError(caught); } finally { busy.value = false; }
}

async function refreshPrincipalFacts(principal: PrincipalResource, requireOpen = true): Promise<void> {
  const [detail, credentialResult] = await Promise.all([
    apiRequest<PrincipalDetail>(`/api/v1/admin/principals/${principal.id}`),
    apiRequest<ListResult<CredentialResource>>(`/api/v1/admin/principals/${principal.id}/credentials?limit=100`),
  ]);
  if (requireOpen && selectedPrincipal.value?.id !== principal.id) return;
  selectedPrincipal.value = {
    ...detail,
    credentials: credentialResult.items,
    credentials_has_more: credentialResult.has_more,
  };
  principalCredentialsNextCursor.value = continuationCursor(credentialResult);
}

async function loadMorePrincipalCredentials(): Promise<void> {
  const principal = selectedPrincipal.value;
  if (principal === null || principalCredentialsNextCursor.value === null || principalCredentialsLoadingMore.value) return;
  principalCredentialsLoadingMore.value = true;
  try {
    const result = await apiRequest<ListResult<CredentialResource>>(
      `/api/v1/admin/principals/${principal.id}/credentials?limit=100&cursor=${encodeURIComponent(principalCredentialsNextCursor.value)}`,
    );
    if (selectedPrincipal.value?.id !== principal.id) return;
    selectedPrincipal.value = {
      ...selectedPrincipal.value,
      credentials: mergePageById(selectedPrincipal.value.credentials, result.items),
      credentials_has_more: result.has_more,
    };
    principalCredentialsNextCursor.value = continuationCursor(result);
  } catch (caught) {
    handleCursorError(caught, () => {
      principalCredentialsNextCursor.value = null;
      if (selectedPrincipal.value !== null) selectedPrincipal.value.credentials_has_more = false;
    });
  } finally {
    principalCredentialsLoadingMore.value = false;
  }
}

function closePrincipal(): void {
  oneTimeInvite.value = "";
  selectedPrincipal.value = null;
  principalCredentialsNextCursor.value = null;
  recoveryConfirmed.value = false;
  showPrincipal.value = false;
}

async function revokeCredential(credential: CredentialResource): Promise<void> {
  const fenceKey = `credential-revoke:${credential.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/credentials/${credential.id}?expected_version=${credential.version}`, { method: "DELETE" });
    if (selectedPrincipal.value !== null) await refreshPrincipalFacts(selectedPrincipal.value);
    await load();
  } catch (caught) {
    const principal = selectedPrincipal.value;
    if (!await recoverCasConflict(caught, localizedText(
      `Credential ${credential.fingerprint}`,
      `凭据 ${credential.fingerprint}`,
    ), { action: "revoke" }, async () => {
      if (principal !== null) await refreshPrincipalFacts(principal);
    })) setError(caught);
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function revokePrincipalPasskey(passkey: PrincipalPasskey): Promise<void> {
  const principal = selectedPrincipal.value;
  if (principal === null || !passkey.allowed_actions.includes("revoke")) return;
  const fenceKey = `passkey-revoke:${passkey.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/passkeys/${passkey.id}?expected_version=${passkey.version}`, { method: "DELETE" });
    await refreshPrincipalFacts(principal);
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Passkey ${passkey.id}`, `通行密钥 ${passkey.id}`), { action: "revoke" }, () => refreshPrincipalFacts(principal))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function createRecoveryInvite(): Promise<void> {
  if (!recoveryForm.value.principal_id
    || !recoveryConfirmed.value
    || inviteNeedsReview.value
    || !invitationCoordinationReady.value
    || busy.value) return;
  busy.value = true;
  oneTimeInvite.value = "";
  const body: InvitationRequestBody = {
    kind: "principal_recovery",
    principal_id: recoveryForm.value.principal_id,
    recovery_mode: recoveryForm.value.mode,
  };
  let operationRecord: InvitationRecoveryRecord | null = null;
  try {
    const operation = await executeNewInvitationOperation(body, (record) => { operationRecord = record; });
    await finishInvitationOperation(operation.result, operation.committed, false);
  } catch (caught) {
    await handleInvitationCreateFailure(caught, "recovery URL", false, operationRecord);
  } finally { busy.value = false; }
}

async function openProjectGrants(item: ProjectEntry): Promise<void> {
  selectedGrantProject.value = item;
  projectGrants.value = [];
  projectGrantsNextCursor.value = null;
  grantForm.value = { principal_id: "", role: "writer" };
  busy.value = true;
  try {
    await loadProjectGrants(item, true);
    showGrant.value = true;
  } catch (caught) { setError(caught); } finally { busy.value = false; }
}

function closeProjectGrants(): void {
  selectedGrantProject.value = null;
  projectGrants.value = [];
  projectGrantsNextCursor.value = null;
  showGrant.value = false;
}

async function loadProjectGrants(item: ProjectEntry, reset: boolean): Promise<void> {
  if (!reset && projectGrantsNextCursor.value === null) return;
  const params = new URLSearchParams({ limit: "100" });
  if (!reset && projectGrantsNextCursor.value !== null) params.set("cursor", projectGrantsNextCursor.value);
  const result = await apiRequest<ListResult<GrantResource>>(`/api/v1/admin/projects/${item.id}/grants?${params}`);
  if (selectedGrantProject.value?.id !== item.id) return;
  projectGrants.value = mergePageById(projectGrants.value, result.items, reset);
  projectGrantsNextCursor.value = continuationCursor(result);
}

async function loadMoreProjectGrants(): Promise<void> {
  const item = selectedGrantProject.value;
  if (item === null || projectGrantsNextCursor.value === null || projectGrantsLoadingMore.value) return;
  projectGrantsLoadingMore.value = true;
  try {
    await loadProjectGrants(item, false);
  } catch (caught) {
    handleCursorError(caught, () => { projectGrantsNextCursor.value = null; });
  } finally {
    projectGrantsLoadingMore.value = false;
  }
}

async function createGrant(): Promise<void> {
  const item = selectedGrantProject.value;
  if (item === null || !grantForm.value.principal_id.trim()) return;
  const fenceKey = `grant-create:${item.id}:${grantForm.value.principal_id.trim()}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/projects/${item.id}/grants`, {
      body: { principal_id: grantForm.value.principal_id.trim(), role: grantForm.value.role },
      method: "POST",
    });
    grantForm.value = { principal_id: "", role: "writer" };
    await loadProjectGrants(item, true);
  } catch (caught) { setError(caught); } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function setGrantRole(grant: GrantResource, role: "reader" | "writer"): Promise<void> {
  const fenceKey = `grant-role:${grant.id}`;
  if (!writeFence.enter(fenceKey)) return;
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
    if (selectedGrantProject.value !== null) await loadProjectGrants(selectedGrantProject.value, true);
  } catch (caught) {
    const item = selectedGrantProject.value;
    if (!await recoverCasConflict(caught, localizedText(`Grant ${grant.id}`, `授权 ${grant.id}`), { role }, async () => {
      if (item !== null) await loadProjectGrants(item, true);
    })) setError(caught);
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function revokeGrant(grant: GrantResource): Promise<void> {
  const fenceKey = `grant-revoke:${grant.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/grants/${grant.id}?expected_version=${grant.version}`, { method: "DELETE" });
    if (selectedGrantProject.value !== null) await loadProjectGrants(selectedGrantProject.value, true);
  } catch (caught) {
    const item = selectedGrantProject.value;
    if (!await recoverCasConflict(caught, localizedText(`Grant ${grant.id}`, `授权 ${grant.id}`), { action: "revoke" }, async () => {
      if (item !== null) await loadProjectGrants(item, true);
    })) setError(caught);
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function createInvite(): Promise<void> {
  if (!inviteForm.value.project_id || inviteNeedsReview.value || !invitationCoordinationReady.value || busy.value) return;
  busy.value = true;
  oneTimeInvite.value = "";
  const body: InvitationRequestBody = {
    grants: [{ project_id: inviteForm.value.project_id, role: inviteForm.value.role }],
    kind: "project_grant",
  };
  let operationRecord: InvitationRecoveryRecord | null = null;
  try {
    const operation = await executeNewInvitationOperation(body, (record) => { operationRecord = record; });
    await finishInvitationOperation(operation.result, operation.committed, false);
  } catch (caught) {
    await handleInvitationCreateFailure(caught, "Invite", false, operationRecord);
  } finally { busy.value = false; }
}

async function revokeInvite(invitation: InvitationResource): Promise<void> {
  const fenceKey = `invite-revoke:${invitation.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/invitations/${invitation.id}?expected_version=${invitation.version}`, { method: "DELETE" });
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(`Invitation ${invitation.id}`, `邀请 ${invitation.id}`), { action: "revoke" }, () => readInvitationsForReview(true))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function openPolicy(item: ProjectEntry): Promise<void> {
  const requestId = policyRequestId + 1;
  policyRequestId = requestId;
  selectedProject.value = item;
  policy.value = null;
  policyRiskConfirmed.value = false;
  showPolicy.value = true;
  busy.value = true;
  try {
    const result = await apiRequest<PolicyResource>(`/api/v1/admin/projects/${item.id}/public-join`);
    if (requestId !== policyRequestId || selectedProject.value?.id !== item.id) return;
    policy.value = result;
    policyForm.value = {
      comments: result.resource_limits.comments ?? 500,
      issues: result.resource_limits.issues ?? 50,
      principals: result.resource_limits.principals ?? 50,
      public_summary: result.public_summary ?? "",
    };
  } catch (caught) {
    if (requestId === policyRequestId) {
      setError(caught);
      closePolicy();
    }
  } finally { if (requestId === policyRequestId) busy.value = false; }
}

async function refreshPolicyFacts(item: ProjectEntry): Promise<void> {
  const result = await apiRequest<PolicyResource>(`/api/v1/admin/projects/${item.id}/public-join`);
  if (selectedProject.value?.id === item.id) policy.value = result;
}

async function savePolicy(): Promise<void> {
  const item = selectedProject.value;
  if (item === null || policy.value === null || !policyRiskConfirmed.value) return;
  const fenceKey = `policy-save:${item.id}`;
  if (!writeFence.enter(fenceKey)) return;
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
    dismissCasConflict();
    showPolicy.value = false;
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `Public Join ${item.workspaceKey}/${item.key}`,
      `公开加入 ${item.workspaceKey}/${item.key}`,
    ), policyForm.value, () => refreshPolicyFacts(item))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

async function disablePolicy(): Promise<void> {
  const item = selectedProject.value;
  if (item === null || policy.value === null) return;
  const fenceKey = `policy-disable:${item.id}`;
  if (!writeFence.enter(fenceKey)) return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/admin/projects/${item.id}/public-join?expected_version=${policy.value.project.version}`, { method: "DELETE" });
    showPolicy.value = false;
    await load();
  } catch (caught) {
    if (!await recoverCasConflict(caught, localizedText(
      `Public Join ${item.workspaceKey}/${item.key}`,
      `公开加入 ${item.workspaceKey}/${item.key}`,
    ), { action: "disable" }, () => refreshPolicyFacts(item))) {
      setError(caught);
    }
  } finally { writeFence.leave(fenceKey); busy.value = false; }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

watch(() => props.section, load);
onMounted(() => {
  ownerViewMounted = true;
  initializeInvitationRecovery();
  void load();
});
onUnmounted(() => {
  ownerViewMounted = false;
  window.removeEventListener("storage", onInvitationRecoveryStorage);
});
</script>

<template>
  <main class="owner-page page-shell">
    <header class="owner-heading">
      <div><p class="eyebrow">{{ ui("Deployment Owner", "部署实例所有者") }}</p><h1>{{ t("admin.title") }}</h1></div>
      <nav class="owner-tabs" :aria-label="ui('Owner sections', '所有者分区')"><button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: section === tab.key }" @click="navigate(sectionPath(tab.key))">{{ tab.label }}</button></nav>
    </header>
    <p v-if="error" class="inline-alert" role="alert">{{ error }}</p>
    <CasConflictNotice v-if="casConflict" :busy="busy || casReadbackInFlight" :conflict="casConflict" @dismiss="dismissCasConflict" @refresh="refreshCasFacts" />
    <PageState :loading="loading" :error="loading ? '' : ''" />

    <template v-if="!loading && section === 'overview'">
      <section class="overview-strip">
        <article><span>{{ ui("Service", "服务") }}</span><strong>{{ meta?.service_version ?? "—" }}</strong><small>{{ ui("schema", "数据架构") }} {{ meta?.schema_version ?? "—" }}</small></article>
        <article><span>{{ ui("Workspaces", "工作区") }}</span><strong>{{ workspaces.length }}</strong><small>{{ meta?.visible_scope.project_count ?? 0 }} {{ ui("Projects", "个项目") }}</small></article>
        <article><span>{{ ui("Principals", "身份") }}</span><strong>{{ principals.length }}{{ principalsHasMore ? "+" : "" }}</strong><small>{{ ui("visible now", "当前可见") }}</small></article>
        <article><span>{{ ui("Recent 429", "近期限流") }}</span><strong>{{ rateSettings?.recent_429_summary.total ?? 0 }}</strong><small>{{ rateSettings?.recent_429_summary.window_seconds ?? 300 }} {{ ui("second window", "秒窗口") }}</small></article>
      </section>
      <section class="owner-section">
        <div class="section-heading-row"><div><h2>{{ ui("Origin & instance", "访问地址与实例") }}</h2><p>{{ meta?.instance_id }}</p></div><button class="secondary-button" type="button" @click="copyText(locale === 'zh-CN' ? '请使用 cfkanban-admin 检查首选 API 地址，并按明确计划修改。' : 'Use cfkanban-admin to inspect and update the preferred API origin with an explicit plan.')">{{ t("action.copy") }}</button></div>
        <dl class="settings-list"><div><dt>{{ ui("Observed", "本次访问") }}</dt><dd>{{ meta?.observed_origin }}</dd></div><div><dt>{{ ui("Preferred", "首选地址") }}</dt><dd>{{ meta?.preferred_api_origin }}</dd></div><div><dt>{{ ui("Origin version", "地址版本") }}</dt><dd>{{ meta?.origin_version }}</dd></div></dl>
      </section>
      <section class="owner-section">
        <div class="section-heading-row"><div><h2>{{ ui("Request gates", "请求门控") }}</h2><p>{{ locale === "zh-CN" ? "由部署配置发布；此处只读。" : "Published through Worker configuration; read-only here." }}</p></div><span class="role-badge">{{ rateSettings?.configuration_source }}</span></div>
        <div class="rate-grid"><article v-for="(value, key) in rateSettings?.policies" :key="key"><span>{{ rateScopeLabel(key) }}</span><strong>{{ value.limit }} / {{ value.period_seconds }}{{ ui("s", "秒") }}</strong><small>{{ rateSettings?.recent_429_summary.by_scope[key] ?? 0 }} {{ ui("recent", "次近期记录") }}</small></article></div>
      </section>
    </template>

    <template v-if="!loading && section === 'workspaces'">
      <div class="section-action-bar"><p>{{ locale === "zh-CN" ? "容器操作是单项原子写入；删除为可恢复暂停。" : "Container actions are atomic; delete is a recoverable pause." }}</p><div><button class="secondary-button" type="button" @click="showWorkspace = true">+ {{ ui("Workspace", "工作区") }}</button><button class="primary-button" type="button" @click="showProject = true">+ {{ ui("Project", "项目") }}</button></div></div>
      <p v-if="treeTruncated" class="warning-panel">{{ ui("This bounded Web view shows the first 20 Workspaces and first 20 Projects in each Workspace. Use cfkanban-admin with an explicit cursor to manage omitted containers.", "此有界网页只显示前 20 个工作区，以及每个工作区的前 20 个项目；管理未显示的容器请让 cfkanban-admin 使用明确的分页位置。") }}</p>
      <section v-for="workspace in workspaces" :key="workspace.id" class="workspace-block">
        <header><div><small>{{ workspace.key }}</small><h2>{{ workspace.display_name }}</h2></div><div><button class="text-button" type="button" @click="openContainerEdit('workspace', workspace)">{{ ui("Rename", "改名") }}</button><button class="danger-text-button" type="button" @click="deleteContainer('workspace', workspace)">{{ t("action.delete") }}</button></div></header>
        <div class="project-table"><div v-for="item in projects.filter((project) => project.workspaceKey === workspace.key)" :key="item.id" class="project-table-row"><button class="project-link" type="button" @click="navigate(`/app/w/${workspace.key}/p/${item.key}`)"><code>{{ item.key }}</code><strong>{{ item.display_name }}</strong></button><span>{{ item.context ? `${item.context.slice(0, 60)}${item.context.length > 60 ? '…' : ''}` : '—' }}</span><div><button class="text-button" type="button" @click="openProjectSettings(item)">{{ ui("Settings", "设置") }}</button><button class="text-button" type="button" @click="openPolicy(item)">{{ ui("Public Join", "公开加入") }}</button><button class="danger-text-button" type="button" @click="deleteContainer('project', item, workspace.key)">{{ t("action.delete") }}</button></div></div><p v-if="!projects.some((project) => project.workspaceKey === workspace.key)" class="empty-copy">{{ ui("No Projects", "暂无项目") }}</p></div>
      </section>
      <section v-if="deletedProjects.length || deletedWorkspaces.length" class="owner-section"><h2>{{ ui("Paused containers", "已暂停容器") }}</h2><p class="muted-copy">{{ ui("Restore one container at a time. Review Public Join policies before confirming.", "逐个恢复容器；确认前先核对会重新公开的公开加入策略。") }}</p><div class="data-list"><div v-for="item in deletedProjects" :key="item.id" class="data-row"><span><strong>{{ item.workspaceKey }}/{{ item.key }}</strong><small>{{ item.display_name }}</small></span><span>{{ ui("Project", "项目") }} · v{{ item.version }}</span><button class="secondary-button" type="button" @click="openRestore('project', item, item.workspaceKey)">{{ t("action.restore") }}</button></div><div v-for="workspace in deletedWorkspaces" :key="workspace.id" class="data-row"><span><strong>{{ workspace.key }}</strong><small>{{ workspace.display_name }}</small></span><span>{{ ui("Workspace", "工作区") }} · v{{ workspace.version }}</span><button class="secondary-button" type="button" @click="openRestore('workspace', workspace)">{{ t("action.restore") }}</button></div></div></section>
    </template>

    <template v-if="!loading && section === 'access'">
      <div class="section-action-bar"><p>{{ locale === "zh-CN" ? "按稳定身份 ID 与明确的项目角色管理访问。" : "Manage access by stable Principal ID and explicit Project role." }}</p><button class="primary-button" type="button" :disabled="busy || inviteNeedsReview" @click="openInviteDialog">+ {{ ui("Invite", "邀请") }}</button></div>
      <div v-if="inviteNeedsReview" class="warning-panel">
        <p><strong>{{ ui("Invitation safety review required", "需要完成邀请安全复核") }}</strong></p>
        <p>{{ ui("One-time bearer URLs are never stored. While a shared recovery record is within its fixed 24-hour window, only an exact retry with the stored body and Idempotency-Key can prove the original POST ended. A list snapshot alone cannot unlock creation.", "一次性访问网址永不持久化。共享恢复记录仍处于固定 24 小时窗口内时，只有使用已保存请求内容与幂等键（Idempotency-Key）精确重试同一操作，才能证明原创建请求已结束；仅靠列表快照不能解锁创建。") }}</p>
        <p v-if="inviteRecoveryNotice" class="inline-alert" role="alert">{{ inviteRecoveryNotice }}</p>
        <textarea v-if="oneTimeInvite" :value="oneTimeInvite" readonly rows="5" />
        <p v-if="invitationRecoveryRecord && invitationRecoveryCanRetry(invitationRecoveryRecord)" class="muted-copy">{{ ui("The original operation is still inside its safe replay window. Changing Project, role, recovery mode, tab, or page cannot start a new capability.", "原操作仍处于安全重放窗口内。更改项目、角色、恢复模式、标签页或页面，都不能开始新的一次性权限。") }}</p>
        <p v-else-if="invitationRecoveryRecord" class="muted-copy">{{ ui("The fixed recovery window ended. Refresh every Invitation page, revoke any matching active capability, and explicitly confirm before abandoning the old key.", "固定恢复窗口已结束。请刷新并读完全部邀请页面，撤销任何匹配的有效一次性权限，再显式确认放弃旧幂等键。") }}</p>
        <p v-if="invitationsHasMore" class="inline-alert" role="alert">{{ ui("More Invitation history remains. Load every page before confirmation; this Web view will not treat the first 100 rows as complete.", "还有更多邀请历史。确认前必须读完每一页；此网页不会把前 100 行当作完整结果。") }}</p>
        <div class="form-actions">
          <button class="secondary-button" type="button" :disabled="busy" @click="refreshInvitationReview">{{ ui("Refresh Invitation list", "刷新邀请列表") }}</button>
          <button v-if="invitationsHasMore && invitationsNextCursor" class="secondary-button" type="button" :disabled="busy" @click="continueInvitationReview">{{ ui("Load next review page", "加载下一复核页") }}</button>
          <button v-if="invitationRecoveryRecord && invitationRecoveryCanRetry(invitationRecoveryRecord)" class="primary-button" type="button" :disabled="busy" @click="recoverInvitationOperation">{{ ui("Recover exact operation", "恢复同一操作") }}</button>
          <button v-if="oneTimeInvite" class="secondary-button" type="button" @click="copyText(oneTimeInvite)">{{ t("action.copy") }}</button>
          <button v-if="oneTimeInvite && presentedInvitationRecord" class="primary-button" type="button" :disabled="busy" @click="acknowledgePresentedInvitation">{{ ui("I saved this one-time URL", "我已保存这个一次性网址") }}</button>
          <button class="primary-button" type="button" :disabled="busy || !invitationCoordinationReady || !canConfirmInvitationReview(inviteReviewReady, invitationsHasMore, invitationRecoveryRecord, inviteReviewStartedAt, Date.now(), committedInvitationResolved())" @click="confirmInvitationReview">{{ ui("I reviewed the complete list", "我已检查完整列表") }}</button>
        </div>
      </div>
      <p v-if="treeTruncated" class="warning-panel">{{ ui("Project access controls are limited to the first 20 Workspaces and first 20 Projects in each. Use cfkanban-admin with an explicit cursor for omitted Projects.", "项目访问管理只显示前 20 个工作区，以及每个工作区的前 20 个项目；未显示的项目请让 cfkanban-admin 使用明确的分页位置。") }}</p>
      <section class="owner-section"><div class="section-heading-row"><div><h2>{{ ui("Principals", "身份") }}</h2><p>{{ ui("Search by exact stable ID or name text, optionally restricted to one visible Project.", "可按准确稳定 ID 或名称文本查找，也可限制到一个当前可见项目。") }}</p></div></div><form class="principal-search" role="search" @submit.prevent="loadPrincipals(true)"><input v-model="principalQuery" type="search" :placeholder="ui('Principal ID or display name', '身份 ID 或显示名称')" /><select v-model="principalProjectId"><option value="">{{ ui("Every visible Project", "全部可见项目") }}</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.workspaceKey }}/{{ item.key }}</option></select><button class="secondary-button" type="submit" :disabled="principalsLoadingMore">{{ ui("Search", "查找") }}</button></form><div class="data-list"><button v-for="principal in principals" :key="principal.id" class="data-row data-row-button" type="button" @click="openPrincipal(principal)"><span><strong>{{ principal.display_name }}</strong><code>{{ principal.id }}</code></span><span>{{ principal.is_owner ? ui('Owner', '所有者') : ui('Participant', '参与者') }}</span><span>{{ principal.active_credential_count ?? 0 }} {{ ui("Credentials", "份凭据") }} · {{ principal.active_grant_count ?? 0 }} {{ ui("Grants", "项授权") }}</span></button><p v-if="principals.length === 0" class="empty-copy">{{ ui("No matching Principals", "没有匹配的身份") }}</p></div><p v-if="principalsHasMore" class="warning-panel">{{ ui("More Principals match this exact query scope. Continue with the bound cursor; changing the query or Project starts a fresh search.", "此准确查询范围还有更多身份。请使用绑定的分页位置继续；修改查询或项目会开始一次新查找。") }}</p><button v-if="principalsNextCursor" class="load-more" type="button" :disabled="principalsLoadingMore" @click="loadPrincipals(false)">{{ principalsLoadingMore ? "…" : ui("Load more Principals", "加载更多身份") }}</button></section>
      <section class="owner-section"><h2>{{ ui("Project Grants", "项目授权") }}</h2><div class="data-list"><button v-for="item in projects" :key="item.id" class="data-row data-row-button" type="button" @click="openProjectGrants(item)"><span><strong>{{ item.workspaceKey }}/{{ item.key }}</strong><small>{{ item.display_name }}</small></span><span>{{ ui("Manage explicit roles", "管理明确角色") }}</span></button></div></section>
      <section class="owner-section"><h2>{{ ui("Invitations", "邀请") }}</h2><div class="data-list"><div v-for="invitation in invitations" :key="invitation.id" class="data-row"><span><strong>{{ invitationKindLabel(invitation.kind) }}</strong><code>{{ invitation.code_fingerprint }}</code><small>{{ ui("Created", "创建于") }} {{ formatTime(invitation.created_at) }}</small></span><span><template v-if="invitation.kind === 'project_grant'">{{ invitation.grants.map((grant) => `${grant.workspace_key}/${grant.project_key}:${roleLabel(grant.role)}`).join(" · ") }}</template><template v-else>{{ invitation.bound_principal?.display_name ?? invitation.bound_principal?.principal_id }} · {{ invitation.recovery_mode }}</template><small>{{ invitationStatusLabel(invitation.status) }} · {{ ui("expires", "到期") }} {{ formatTime(invitation.expires_at) }}</small></span><button v-if="invitation.allowed_actions.includes('revoke')" class="danger-text-button" type="button" @click="revokeInvite(invitation)">{{ ui("Revoke", "撤销") }}</button></div></div></section>
    </template>

    <template v-if="!loading && section === 'audit'">
      <p v-if="auditNextCursor" class="warning-panel">{{ ui("More Audit events are available. Load the next page to continue the sequence; this view never silently treats the first 100 as complete.", "还有更多审计事件。请继续加载后续记录；此页面不会把前 100 条静默当成完整结果。") }}</p>
      <section class="audit-list"><article v-for="event in audit" :key="event.id"><div><code>{{ event.type }}</code><strong>{{ event.subject.type }} · {{ event.subject.id }}</strong></div><p>{{ event.actor?.display_name ?? ui('system', '系统') }} · {{ formatTime(event.created_at) }}</p><pre>{{ JSON.stringify(event.payload, null, 2) }}</pre></article><p v-if="audit.length === 0" class="empty-copy">{{ ui("No audit events", "暂无审计事件") }}</p></section>
      <button v-if="auditNextCursor" class="load-more" type="button" :disabled="auditLoadingMore" @click="loadAudit(false)">{{ auditLoadingMore ? "…" : ui("Load more Audit events", "加载更多审计事件") }}</button>
    </template>

    <ModalDialog v-if="showWorkspace" :busy="busy" :title="ui('Create Workspace', '创建工作区')" @close="showWorkspace = false"><form class="form-stack" @submit.prevent="createWorkspace"><label>{{ ui("Key", "不可变标识") }}<input v-model="workspaceForm.key" required pattern="[a-z][a-z0-9-]{1,31}" /></label><label>{{ ui("Display name", "显示名称") }}<input v-model="workspaceForm.display_name" required maxlength="128" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showWorkspace = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit">{{ t("action.save") }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showProject" :busy="busy" :title="ui('Create Project', '创建项目')" @close="showProject = false"><form class="form-stack" @submit.prevent="createProject"><label>{{ ui("Workspace", "工作区") }}<select v-model="selectedWorkspace" required><option value="" disabled>{{ ui("Choose…", "请选择…") }}</option><option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.key">{{ workspace.display_name }}</option></select></label><label>{{ ui("Key", "不可变标识") }}<input v-model="projectForm.key" required pattern="[A-Z][A-Z0-9-]{1,15}" /></label><label>{{ ui("Display name", "显示名称") }}<input v-model="projectForm.display_name" required maxlength="128" /></label><label>{{ ui("Context", "项目上下文") }}<textarea v-model="projectForm.context" rows="5" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showProject = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit">{{ t("action.save") }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showContainerEdit && containerEdit" :busy="busy" :title="ui('Rename container', '容器改名')" @close="showContainerEdit = false"><form class="form-stack" @submit.prevent="saveContainerEdit"><p><code>{{ containerEdit.item.key }}</code></p><label>{{ ui("Display name", "显示名称") }}<input v-model="containerEdit.display_name" required maxlength="128" /></label><div class="form-actions"><button class="secondary-button" type="button" @click="showContainerEdit = false">{{ t("action.cancel") }}</button><button class="primary-button" type="submit">{{ t("action.save") }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showProjectSettings && selectedProject" :busy="busy" :title="ui('Project settings', '项目设置')" @close="closeProjectSettings"><form class="form-stack" @submit.prevent="saveProjectSettings"><p><code>{{ selectedProject.workspaceKey }}/{{ selectedProject.key }}</code> · v{{ selectedProject.version }}</p><label>{{ ui("Display name", "显示名称") }}<input v-model="projectSettingsForm.display_name" required maxlength="128" /></label><label>{{ ui("Context", "项目上下文") }}<textarea v-model="projectSettingsForm.context" rows="6" /></label><button class="primary-button" type="submit" :disabled="busy">{{ t("action.save") }}</button></form><section class="recovery-section"><h3>{{ ui("Workflow display names", "工作流显示名称") }}</h3><p class="muted-copy">{{ ui("Stable keys, order, and terminal semantics do not change.", "稳定键、顺序和终态语义不会改变。") }}</p><form v-for="status in projectStatuses" :key="status.key" class="compact-inline-form" @submit.prevent="saveStatusName(status)"><code>{{ status.key }}</code><input v-model="statusDrafts[status.key]" required maxlength="128" /><button class="text-button" type="submit" :disabled="busy || statusDrafts[status.key] === status.display_name">{{ t("action.save") }}</button></form></section></ModalDialog>
    <ModalDialog v-if="showRestore && restoreTarget" :busy="busy" :title="ui('Restore container?', '恢复容器？')" @close="showRestore = false"><p><code>{{ restoreTarget.item.key }}</code> · {{ restoreTarget.item.display_name }}</p><p class="warning-panel">{{ ui("Restoring reactivates every still-enabled Public Join policy shown below. Existing Grants remain unchanged.", "恢复会重新启用下列仍然开启的公开加入策略；既有授权不会改变。") }}</p><p v-if="restoreTarget.item.resumed_public_projects?.has_more" class="inline-alert" role="alert">{{ ui("More than 100 Public Join Projects will resume. Only the first 100 are listed here; confirming still republishes every enabled policy in this container.", "将恢复超过 100 个公开加入项目。此处只列出前 100 个；确认后仍会重新公开该容器内全部已开启策略。") }}</p><div class="data-list"><div v-for="publicProject in restoreTarget.item.resumed_public_projects?.projects ?? []" :key="publicProject.id" class="data-row"><span><strong>{{ publicProject.workspace_key ? `${publicProject.workspace_key}/` : '' }}{{ publicProject.key }}</strong><small>{{ publicProject.display_name ?? publicProject.id }}</small></span><span v-if="publicProject.resource_limits">{{ publicProject.role_choices?.map(roleLabel).join(' | ') }} · {{ publicProject.resource_limits.issues }}/{{ publicProject.resource_limits.comments }}/{{ publicProject.resource_limits.principals }}</span></div><p v-if="!(restoreTarget.item.resumed_public_projects?.projects.length)" class="empty-copy">{{ ui("No enabled Public Join policy will resume.", "没有已开启的公开加入策略会重新公开。") }}</p></div><div class="form-actions"><button class="secondary-button" type="button" @click="showRestore = false">{{ t("action.cancel") }}</button><button class="primary-button" type="button" :disabled="busy" @click="restoreContainer">{{ t("action.restore") }}</button></div></ModalDialog>
    <ModalDialog v-if="showInvite" :busy="busy" :title="ui('Create Project Invite', '创建项目邀请')" @close="closeInviteDialog"><form class="form-stack" @submit.prevent="createInvite"><label>{{ ui("Project", "项目") }}<select v-model="inviteForm.project_id" required><option value="" disabled>{{ ui("Choose…", "请选择…") }}</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.workspaceKey }}/{{ item.key }} · {{ item.display_name }}</option></select></label><label>{{ ui("Role", "角色") }}<select v-model="inviteForm.role"><option value="reader">{{ roleLabel('reader') }}</option><option value="writer">{{ roleLabel('writer') }}</option></select></label><p class="muted-copy">{{ locale === "zh-CN" ? "完整网址只在创建响应中出现一次；页面不会保存它。" : "The full URL appears only in the create response; this page does not store it." }}</p><p v-if="inviteRecoveryNotice" class="inline-alert" role="alert">{{ inviteRecoveryNotice }}</p><textarea v-if="oneTimeInvite" :value="oneTimeInvite" readonly rows="5" /><div class="form-actions"><button v-if="oneTimeInvite" class="secondary-button" type="button" @click="copyText(oneTimeInvite)">{{ t("action.copy") }}</button><button v-if="oneTimeInvite && presentedInvitationRecord" class="primary-button" type="button" :disabled="busy" @click="acknowledgePresentedInvitation">{{ ui("I saved this one-time URL", "我已保存这个一次性网址") }}</button><button class="primary-button" type="submit" :disabled="busy || inviteNeedsReview">{{ oneTimeInvite ? (locale === 'zh-CN' ? '再创建一个' : 'Create another') : t('action.save') }}</button></div></form></ModalDialog>
    <ModalDialog v-if="showPrincipal && selectedPrincipal" :busy="busy" :title="ui('Principal access', '身份访问')" @close="closePrincipal">
      <header class="modal-summary">
        <strong>{{ selectedPrincipal.display_name }}</strong>
        <code>{{ selectedPrincipal.id }}</code>
        <span>{{ selectedPrincipal.is_owner ? ui('Owner', '所有者') : ui('Participant', '参与者') }}</span>
        <small>{{ ui('Created', '创建于') }} {{ selectedPrincipal.created_at ? formatTime(selectedPrincipal.created_at) : '—' }} · {{ selectedPrincipal.active_credential_count ?? 0 }} {{ ui('Credentials', '份凭据') }} · {{ selectedPrincipal.active_grant_count ?? 0 }} {{ ui('Grants', '项授权') }} · {{ selectedPrincipal.assignee_count ?? 0 }} {{ ui('Assignees', '项指派') }}</small>
      </header>
      <section class="recovery-section">
        <h3>{{ ui('Credentials', '凭据') }}</h3>
        <div class="data-list"><div v-for="credential in selectedPrincipal.credentials" :key="credential.id" class="data-row"><span><strong>{{ credential.fingerprint }}</strong><small>{{ credential.last_used_at ? formatTime(credential.last_used_at) : ui('never used', '尚未使用') }}</small></span><button v-if="credential.allowed_actions.includes('revoke')" class="danger-text-button" type="button" @click="revokeCredential(credential)">{{ ui('Revoke', '撤销') }}</button></div></div>
        <p v-if="selectedPrincipal.credentials_has_more" class="warning-panel">{{ ui('More Credentials exist. Continue with the bound cursor; no secret value is returned.', '还有更多凭据。请使用绑定的分页位置继续；列表不会返回秘密值。') }}</p>
        <button v-if="principalCredentialsNextCursor" class="load-more" type="button" :disabled="principalCredentialsLoadingMore" @click="loadMorePrincipalCredentials">{{ principalCredentialsLoadingMore ? '…' : ui('Load more Credentials', '加载更多凭据') }}</button>
      </section>
      <section class="recovery-section">
        <h3>{{ ui('Passkeys', '通行密钥') }}</h3>
        <div class="data-list"><div v-for="passkey in selectedPrincipal.passkeys" :key="passkey.id" class="data-row"><span><strong>{{ passkey.algorithm === -7 ? 'ES256' : 'RS256' }}</strong><small>{{ passkey.rp_id }} · {{ passkey.last_used_at ? formatTime(passkey.last_used_at) : ui('never used', '尚未使用') }}</small></span><button v-if="passkey.allowed_actions.includes('revoke')" class="danger-text-button" type="button" @click="revokePrincipalPasskey(passkey)">{{ ui('Revoke', '撤销') }}</button></div></div>
        <p v-if="selectedPrincipal.passkeys_has_more" class="warning-panel">{{ ui('More Passkeys exist; this bounded projection has no continuation endpoint, so use cfkanban-admin for the complete list.', '还有更多通行密钥；此有界详情没有继续读取接口，请使用 cfkanban-admin 查看完整列表。') }}</p>
      </section>
      <section class="recovery-section">
        <h3>{{ ui('Grants', '授权') }}</h3>
        <div class="data-list"><div v-for="grant in selectedPrincipal.grants" :key="grant.id" class="data-row"><span><strong>{{ grant.project.workspace_key }}/{{ grant.project.key }}</strong><small>{{ roleLabel(grant.role) }} · {{ grant.revoked_at ? ui('revoked', '已撤销') : ui('active', '有效') }}</small></span></div></div>
        <p v-if="selectedPrincipal.grants_has_more" class="warning-panel">{{ ui('More Grants exist; this Principal detail projection has no continuation endpoint. Search by Project or use cfkanban-admin.', '还有更多授权；身份详情没有继续读取接口。请按项目查找或使用 cfkanban-admin。') }}</p>
      </section>
      <form v-if="!selectedPrincipal.is_owner" class="form-stack warning-panel" @submit.prevent="createRecoveryInvite">
        <h3>{{ ui('Principal recovery invite', '身份恢复邀请') }}</h3>
        <p><strong>{{ ui('Identity takeover warning:', '身份接管警告：') }}</strong> {{ ui('the redeemer becomes this same stable Principal and inherits every existing Grant, assignee relationship, and historical attribution.', '兑换者会成为这个相同的稳定身份，并继承其全部既有授权、指派关系和历史归属。') }}</p>
        <label>{{ ui('Recovery mode', '恢复模式') }}<select v-model="recoveryForm.mode"><option value="rotation">rotation · {{ ui('revoke the credential used to redeem', '仅撤销本次兑换所用旧凭据') }}</option><option value="full_recovery">full_recovery · {{ ui('revoke all prior credentials', '撤销此前全部凭据') }}</option></select></label>
        <p>{{ recoveryForm.mode === 'rotation' ? ui('Rotation preserves every other existing Credential and Passkey.', '轮换会保留其他既有凭据与通行密钥。') : ui('Full recovery revokes all prior Credentials; existing Grants, assignments, history, and Passkeys remain tied to this Principal.', '完全恢复会撤销此前全部凭据；既有授权、指派、历史和通行密钥仍绑定此身份。') }}</p>
        <label class="confirmation-check"><input v-model="recoveryConfirmed" type="checkbox" />{{ ui('I verified the immutable Principal ID and understand the complete inheritance and revocation scope.', '我已核对不可变身份 ID，并理解完整继承范围与撤销范围。') }}</label>
        <p v-if="inviteNeedsReview" class="inline-alert" role="alert">{{ inviteRecoveryNotice || ui('Close this dialog and complete the Invitation safety review first.', '请先关闭此弹窗并完成邀请安全复核。') }}</p>
        <button class="primary-button" type="submit" :disabled="busy || !recoveryConfirmed || inviteNeedsReview">{{ ui('Create one-time recovery URL', '创建一次性恢复网址') }}</button>
        <textarea v-if="oneTimeInvite" :value="oneTimeInvite" readonly rows="5" />
        <button v-if="oneTimeInvite" class="secondary-button" type="button" @click="copyText(oneTimeInvite)">{{ t("action.copy") }}</button>
        <button v-if="oneTimeInvite && presentedInvitationRecord" class="primary-button" type="button" :disabled="busy" @click="acknowledgePresentedInvitation">{{ ui("I saved this one-time URL", "我已保存这个一次性网址") }}</button>
      </form>
    </ModalDialog>
    <ModalDialog v-if="showGrant && selectedGrantProject" :busy="busy" :title="ui('Project Grants', '项目授权')" @close="closeProjectGrants">
      <p><code>{{ selectedGrantProject.workspaceKey }}/{{ selectedGrantProject.key }}</code> · {{ selectedGrantProject.display_name }}</p>
      <form class="compact-inline-form" @submit.prevent="createGrant"><input v-model="grantForm.principal_id" required :placeholder="ui('Principal ID', '身份 ID')" /><select v-model="grantForm.role"><option value="reader">{{ roleLabel('reader') }}</option><option value="writer">{{ roleLabel('writer') }}</option></select><button class="primary-button" type="submit" :disabled="busy">{{ ui('Grant', '授予') }}</button></form>
      <div class="data-list"><div v-for="grant in projectGrants" :key="grant.id" class="data-row"><span><strong>{{ grant.principal.display_name }}</strong><code>{{ grant.principal_id }}</code></span><select :value="grant.role" :disabled="busy || grant.revoked_at !== null" @change="setGrantRole(grant, ($event.target as HTMLSelectElement).value as 'reader' | 'writer')"><option value="reader">{{ roleLabel('reader') }}</option><option value="writer">{{ roleLabel('writer') }}</option></select><div><button v-if="grant.revoked_at === null" class="danger-text-button" type="button" @click="revokeGrant(grant)">{{ ui('Revoke', '撤销') }}</button><button v-else class="secondary-button" type="button" @click="setGrantRole(grant, grant.role)">{{ ui('Regrant', '重新授予') }}</button></div></div></div>
      <button v-if="projectGrantsNextCursor" class="load-more" type="button" :disabled="projectGrantsLoadingMore" @click="loadMoreProjectGrants">{{ projectGrantsLoadingMore ? '…' : ui('Load more Grants', '加载更多授权') }}</button>
    </ModalDialog>
    <ModalDialog v-if="showPolicy" :busy="busy" :title="ui('Public Join', '公开加入')" @close="closePolicy">
      <form class="form-stack" @submit.prevent="savePolicy">
        <div class="warning-panel"><p v-for="paragraph in publicJoinRiskNotice(locale)" :key="paragraph">{{ paragraph }}</p></div>
        <label>{{ ui("Public summary", "公开摘要") }}<textarea v-model="policyForm.public_summary" rows="4" required /></label>
        <div class="form-grid"><label>{{ ui("Issues", "事项上限") }}<input v-model.number="policyForm.issues" type="number" min="1" required /></label><label>{{ ui("Comments", "评论上限") }}<input v-model.number="policyForm.comments" type="number" min="1" required /></label><label>{{ ui("Principals", "身份上限") }}<input v-model.number="policyForm.principals" type="number" min="1" required /></label></div>
        <p v-if="policy" class="muted-copy">{{ ui("Active", "当前用量") }}: {{ policy.active_usage.issues }} {{ ui("issues", "个事项") }} · {{ policy.active_usage.comments }} {{ ui("comments", "条评论") }} · {{ policy.active_usage.principals }} {{ ui("principals", "个身份") }}</p>
        <label class="confirmation-check"><input v-model="policyRiskConfirmed" type="checkbox" />{{ ui('I understand the public writer, quota, recovery, and D1 storage consequences.', '我理解公开协作者、限额、恢复与 D1 存储的后果。') }}</label>
        <div class="form-actions"><button v-if="policy?.enabled" class="danger-button" type="button" :disabled="busy" @click="disablePolicy">{{ ui("Disable", "关闭") }}</button><button class="primary-button" type="submit" :disabled="busy || policy === null || !policyRiskConfirmed">{{ policy?.enabled ? ui('Update policy', '更新策略') : ui('Enable Public Join', '开启公开加入') }}</button></div>
      </form>
    </ModalDialog>
  </main>
</template>
