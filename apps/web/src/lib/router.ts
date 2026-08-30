import { ref } from "vue";

export const currentPath = ref(`${window.location.pathname}${window.location.search}`);

window.addEventListener("popstate", () => {
  currentPath.value = `${window.location.pathname}${window.location.search}`;
});

export function navigate(path: string, replace = false): void {
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  currentPath.value = `${window.location.pathname}${window.location.search}`;
  window.scrollTo({ top: 0, behavior: "instant" });
}

export function routePath(): string {
  return currentPath.value.split("?", 1)[0] ?? "/";
}
