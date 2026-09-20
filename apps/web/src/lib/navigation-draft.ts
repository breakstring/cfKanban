import { onUnmounted } from "vue";
import { locale } from "./i18n";
import { registerNavigationGuard } from "./router";

export function protectNavigationDraft(hasDraft: () => boolean): void {
  const remove = registerNavigationGuard(() => !hasDraft() || window.confirm(locale.value === "zh-CN"
    ? "有尚未保存的内容。放弃这些内容并离开？"
    : "You have unsaved changes. Discard them and leave?"));
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (hasDraft()) { event.preventDefault(); event.returnValue = ""; }
  };
  window.addEventListener("beforeunload", beforeUnload);
  onUnmounted(() => { remove(); window.removeEventListener("beforeunload", beforeUnload); });
}
