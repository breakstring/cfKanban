import { toolError } from "./errors.mjs";

const reserved = new Set(["admin", "administrator", "owner", "system", "管理员", "所有者", "系统"]);

export function normalizePrincipalDisplayName(value) {
  const name = typeof value === "string" ? value.trim().normalize("NFKC") : "";
  const key = name.toLowerCase();
  const length = [...name].length;
  const keyLength = [...key].length;
  const reason = length < 1 || length > 128 || keyLength < 1 || keyLength > 128
    ? "length"
    : /\p{Default_Ignorable_Code_Point}/u.test(name) || !/^[\p{L}\p{M}\p{N}_·-]+$/u.test(name)
      ? "invalid_characters"
      : reserved.has(key) ? "reserved" : null;
  if (reason) throw toolError("VALIDATION_ERROR", "Principal display name is invalid", {
    reason: "principal_display_name_invalid", name_reason: reason,
  });
  return name;
}

// Recovery and upgrade preserve the observed identity, including pre-schema-8 names.
export function requireObservedPrincipalDisplayName(value) {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > 128) {
    throw toolError("INVALID_INPUT", "display_name must contain 1–128 Unicode code points", { field: "display_name" });
  }
  return value;
}
