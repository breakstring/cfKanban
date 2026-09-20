import { ref } from "vue";

export const currentPath = ref(`${window.location.pathname}${window.location.search}`);
const guards = new Set<() => boolean>();

export function registerNavigationGuard(guard: () => boolean): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

function canLeave(): boolean { return [...guards].every(guard => guard()); }

window.addEventListener("popstate", () => {
  if (!canLeave()) {
    window.history.pushState({}, "", currentPath.value);
    return;
  }
  currentPath.value = `${window.location.pathname}${window.location.search}`;
});

export function navigate(path: string, replace = false): boolean {
  if (path !== currentPath.value && !canLeave()) return false;
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  currentPath.value = `${window.location.pathname}${window.location.search}`;
  window.scrollTo({ top: 0, behavior: "instant" });
  return true;
}

export function routePath(): string {
  return currentPath.value.split("?", 1)[0] ?? "/";
}
