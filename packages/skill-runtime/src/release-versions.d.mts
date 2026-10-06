export interface ParsedReleaseVersion { core: bigint[]; prerelease: string[] }
export function parseReleaseVersion(value: unknown): ParsedReleaseVersion | null;
export function compareReleaseVersions(left: unknown, right: unknown): number | null;
export function isUpgradeAnnouncementRelease(value: unknown): boolean;
