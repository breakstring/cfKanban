export function parseReleaseVersion(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(BigInt), prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some(part => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core, prerelease };
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const first = a.prerelease[index], second = b.prerelease[index];
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1;
    if (first === second) continue;
    const firstNumeric = /^[0-9]+$/.test(first), secondNumeric = /^[0-9]+$/.test(second);
    if (firstNumeric && secondNumeric) return BigInt(first) < BigInt(second) ? -1 : 1;
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    return first < second ? -1 : 1;
  }
  return 0;
}

export function isUpgradeAnnouncementRelease(value) {
  const version = parseReleaseVersion(value);
  return Boolean(version && (!version.prerelease.length || version.prerelease.length === 2 && version.prerelease[0] === "rc" && /^[0-9]+$/.test(version.prerelease[1])));
}
