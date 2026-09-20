import type { HomepageSettings, InstanceDiscovery, Locale, WriteResult } from "../types";

interface HomepageSettingsPayload { expected_version: number; notice_en: string | null; notice_zh_cn: string | null }

export function isHomepageSettings(value: unknown): value is HomepageSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as HomepageSettings;
  return Number.isSafeInteger(settings.version) && settings.version > 0
    && (settings.notice_en === null || (typeof settings.notice_en === "string" && noticeLength(settings.notice_en) <= 500))
    && (settings.notice_zh_cn === null || (typeof settings.notice_zh_cn === "string" && noticeLength(settings.notice_zh_cn) <= 500));
}

export function isHomepageSettingsWriteResult(value: unknown, payload: HomepageSettingsPayload): value is WriteResult<HomepageSettings> {
  if (typeof value !== "object" || value === null) return false;
  const result = value as WriteResult<HomepageSettings>;
  return typeof result.event_cursor === "string" && result.event_cursor.length > 0
    && typeof result.idempotent_replay === "boolean" && isHomepageSettings(result.resource)
    && result.resource.version === payload.expected_version + 1
    && result.resource.notice_en === payload.notice_en && result.resource.notice_zh_cn === payload.notice_zh_cn;
}

export function homepageNotice(
  notice: InstanceDiscovery["homepage_notice"],
  selectedLocale: Locale,
  fallback: string,
): string {
  return notice?.[selectedLocale] ?? (selectedLocale === "zh-CN" ? notice?.en : null) ?? fallback;
}

export function noticeLength(value: string): number {
  return [...value.trim()].length;
}

export class HomepageSettingsDraft {
  english = "";
  chinese = "";
  current: HomepageSettings | null = null;
  requiresReadback = false;
  pending: HomepageSettingsPayload | null = null;

  get valid(): boolean {
    return noticeLength(this.english) <= 500 && noticeLength(this.chinese) <= 500;
  }

  get canSave(): boolean {
    return this.current !== null && !this.requiresReadback && this.pending === null && this.valid;
  }

  get canRetirePending(): boolean {
    return this.pending !== null && this.current !== null && this.current.version > this.pending.expected_version;
  }

  receive(settings: HomepageSettings, retainDraft = false): void {
    if (!isHomepageSettings(settings)) {
      throw new Error("Invalid homepage settings response");
    }
    this.current = settings;
    this.requiresReadback = false;
    if (!retainDraft) {
      this.english = settings.notice_en ?? "";
      this.chinese = settings.notice_zh_cn ?? "";
    }
  }

  reset(): void {
    this.english = "";
    this.chinese = "";
  }

  beginWrite(): HomepageSettingsPayload {
    if (this.pending === null) this.pending = this.payload();
    return { ...this.pending };
  }

  retirePending(): void {
    if (!this.canRetirePending) throw new Error("The uncertain write can still commit; retry the original request");
    this.pending = null;
  }

  finishWrite(settings: HomepageSettings): boolean {
    const draftSaved = (this.english.trim() || null) === settings.notice_en
      && (this.chinese.trim() || null) === settings.notice_zh_cn;
    this.receive(settings, !draftSaved);
    this.pending = null;
    return draftSaved;
  }

  payload(): HomepageSettingsPayload {
    if (!this.canSave || this.current === null) throw new Error("Homepage settings require review");
    return {
      expected_version: this.current.version,
      notice_en: this.english.trim() || null,
      notice_zh_cn: this.chinese.trim() || null,
    };
  }
}
