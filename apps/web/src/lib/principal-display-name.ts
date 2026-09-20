export type PrincipalDisplayNameProblem = "length" | "invalid_characters" | "reserved";

const reservedNames = new Set(["admin", "administrator", "owner", "system", "管理员", "所有者", "系统"]);

export function normalizePrincipalDisplayName(value: string): string {
  return value.trim().normalize("NFKC");
}

export function principalDisplayNameProblem(value: string): PrincipalDisplayNameProblem | null {
  const name = normalizePrincipalDisplayName(value);
  if (Array.from(name).length < 1 || Array.from(name).length > 128 || Array.from(name.toLowerCase()).length > 128) return "length";
  if (!/^[\p{L}\p{M}\p{N}_·-]+$/u.test(name) || /\p{Default_Ignorable_Code_Point}/u.test(name)) return "invalid_characters";
  if (reservedNames.has(name.toLowerCase())) return "reserved";
  return null;
}
