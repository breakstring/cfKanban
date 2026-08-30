import { computed, ref, watch } from "vue";

import type { Locale } from "../types";
import { resolveLocalePreference } from "./locale-preference";

const translations = {
  en: {
    "action.back": "Back",
    "action.cancel": "Cancel",
    "action.close": "Close",
    "action.comment": "Comment",
    "action.copy": "Copy for Agent",
    "action.delete": "Delete",
    "action.edit": "Edit issue",
    "action.logout": "Sign out",
    "action.newIssue": "New issue",
    "action.refresh": "Refresh",
    "action.restore": "Restore",
    "action.save": "Save",
    "action.usePasskey": "Use Passkey",
    "admin.access": "Access",
    "admin.audit": "Audit",
    "admin.overview": "Overview",
    "admin.title": "Instance overview",
    "admin.workspaces": "Workspaces & Projects",
    "board.empty": "No issues in this status.",
    "board.readOnly": "Read-only",
    "board.search": "Search issues…",
    "comment.add": "Add a comment",
    "comment.placeholder": "Write Markdown…",
    "complete.summary": "Completion summary",
    "complete.title": "Complete issue",
    "error.conflict": "The issue changed on the server. Your draft is still here; refresh before saving again.",
    "error.authorization": "Your current session does not allow this action. Refresh or sign in again.",
    "error.businessQuota": "This Project has reached its active quota. Release capacity or ask the Owner to change the limit.",
    "error.capability": "This one-time link is no longer available. Ask your Agent for a new link.",
    "error.generic": "This action could not be completed.",
    "error.idempotencyExpired": "The safe retry window for this write has ended. Do not submit it again yet. Refresh and read back the remote state first. For a one-time URL, review and revoke any committed invitation before explicitly starting a new action.",
    "error.notFound": "This resource is unavailable in your current scope.",
    "error.platform": "The service is temporarily unavailable. Keep the request ID and try again or contact the Owner.",
    "error.platformQuota": "Cloudflare platform capacity is unavailable. Wait for the stated reset or contact the Owner.",
    "error.rate": "Too many requests. Wait before trying again.",
    "error.session": "Your session ended. Remote project data was cleared from this page.",
    "error.validation": "Check the highlighted input and try again.",
    "home.agentInstruction": "Please read https://github.com/breakstring/cfKanban#readme and help me install or update the canonical cfKanban Skills, then deploy a new instance.",
    "home.description": "A lightweight Kanban for people and coding Agents, running on Cloudflare.",
    "home.heading": "Keep work visible. Let your Agent do the typing.",
    "home.independent": "This is an independent cfKanban instance.",
    "home.projects": "Public projects",
    "home.projectsDescription": "Join one public project to read or contribute.",
    "home.reader": "Join as Reader",
    "home.writer": "Join as Writer",
    "issue.activity": "Activity",
    "issue.assignee": "Assignee",
    "issue.body": "Description",
    "issue.labels": "Labels",
    "issue.priority": "Priority",
    "issue.status": "Status",
    "issue.unassigned": "Unassigned",
    "nav.profile": "My profile",
    "passkey.failed": "Passkey sign-in was not completed. Try again or ask your Agent for a Browser Launch.",
    "passkey.list": "Passkeys registered for your cfKanban identity",
    "profile.id": "Principal ID",
    "profile.title": "My profile",
    "project.choose": "Choose a project",
    "project.chooseHelp": "Your current session can open these projects. No aggregate issue query runs automatically.",
    "session.expires": "Session expires",
  },
  "zh-CN": {
    "action.back": "返回",
    "action.cancel": "取消",
    "action.close": "关闭",
    "action.comment": "发表评论",
    "action.copy": "复制给 Agent",
    "action.delete": "删除",
    "action.edit": "编辑 Issue",
    "action.logout": "退出登录",
    "action.newIssue": "新建 Issue",
    "action.refresh": "刷新",
    "action.restore": "恢复",
    "action.save": "保存",
    "action.usePasskey": "使用 Passkey",
    "admin.access": "访问管理",
    "admin.audit": "审计",
    "admin.overview": "概览",
    "admin.title": "实例概览",
    "admin.workspaces": "Workspace 与 Project",
    "board.empty": "此状态暂无 Issue。",
    "board.readOnly": "只读",
    "board.search": "搜索 Issue…",
    "comment.add": "添加评论",
    "comment.placeholder": "输入 Markdown…",
    "complete.summary": "完成摘要",
    "complete.title": "完成 Issue",
    "error.conflict": "服务端 Issue 已变化。你的草稿仍保留在当前页面，请刷新后再决定是否保存。",
    "error.authorization": "当前 Session 不允许此操作，请刷新或重新登录。",
    "error.businessQuota": "此 Project 已达到 active quota。请释放容量，或请 Owner 调整限制。",
    "error.capability": "此一次性链接已不可用，请让 Agent 重新创建。",
    "error.generic": "此操作未能完成。",
    "error.idempotencyExpired": "此写入的安全重试窗口已结束，请勿立即再次提交。请先刷新并核对远端事实；若涉及一次性 URL，请先检查并撤销可能已提交的 Invitation，再明确开始新操作。",
    "error.notFound": "当前权限范围内无法访问此资源。",
    "error.platform": "服务暂时不可用。请保留 request ID 后重试，或联系 Owner。",
    "error.platformQuota": "Cloudflare 平台容量暂时不可用。请等待所示重置时间，或联系 Owner。",
    "error.rate": "请求过于频繁，请稍后再试。",
    "error.session": "Session 已结束，当前页面中的远端 Project 数据已清除。",
    "error.validation": "请检查输入后重试。",
    "home.agentInstruction": "请仔细阅读 https://github.com/breakstring/cfKanban#readme，帮我安装或更新 canonical cfKanban Skills，并部署一个新实例。",
    "home.description": "为人和 Coding Agents 设计、运行在 Cloudflare 上的轻量 Kanban。",
    "home.heading": "让工作清晰可见，让 Agent 完成输入。",
    "home.independent": "这是一个独立部署的 cfKanban 实例。",
    "home.projects": "公开 Projects",
    "home.projectsDescription": "选择一个公开 Project，以只读或协作方式加入。",
    "home.reader": "以 Reader 加入",
    "home.writer": "以 Writer 加入",
    "issue.activity": "活动",
    "issue.assignee": "负责人",
    "issue.body": "描述",
    "issue.labels": "Labels",
    "issue.priority": "优先级",
    "issue.status": "状态",
    "issue.unassigned": "未分配",
    "nav.profile": "我的资料",
    "passkey.failed": "Passkey 登录未完成。请重试，或让 Agent 重新创建 Browser Launch。",
    "passkey.list": "为你的 cfKanban 身份登记的 Passkeys",
    "profile.id": "Principal ID",
    "profile.title": "我的资料",
    "project.choose": "选择 Project",
    "project.chooseHelp": "当前 Session 可以打开这些 Projects；页面不会自动执行聚合 Issue 查询。",
    "session.expires": "Session 到期时间",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;
const STORAGE_KEY = "cfkanban_locale";

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  return resolveLocalePreference(
    window.localStorage.getItem(STORAGE_KEY),
    window.navigator.languages,
  );
}

export const locale = ref<Locale>(initialLocale());
export const htmlLanguage = computed(() => locale.value);

watch(locale, (value) => {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.documentElement.lang = value;
  window.localStorage.setItem(STORAGE_KEY, value);
}, { immediate: true });

export function setLocale(value: Locale): void {
  locale.value = value;
}

export function t(key: TranslationKey): string {
  return translations[locale.value][key] ?? translations.en[key];
}
