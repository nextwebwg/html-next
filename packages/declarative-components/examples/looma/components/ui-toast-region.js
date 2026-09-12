import { createViewportSurface } from "./overlay.js";

export default function controller(host) {
  const surface = createViewportSurface(host.element);
  let wasOpen = false;
  let pendingDismiss;
  const sync = () => {
    const open = Boolean(host.state.open) &&
      host.element.querySelector("[data-ui-toast]") !== null;
    const completed = pendingDismiss && !host.element.contains(pendingDismiss.toast)
      ? pendingDismiss
      : undefined;
    host.element.toggleAttribute("data-open", open);
    if (open) surface.show();
    else surface.hide();
    if (wasOpen && !open && completed) {
      host.dispatch("close", {
        open: false,
        reason: "action",
        trigger: completed.trigger,
      });
    }
    if (completed || !host.state.open) pendingDismiss = undefined;
    wasOpen = open;
  };
  const stop = host.effect(sync);
  const click = (event) => {
    const dismiss = event.target.closest?.("[data-ui-toast-dismiss]");
    const toast = dismiss?.closest?.("[data-ui-toast]");
    if (!toast) return;
    const trigger = event.isTrusted ? "pointer" : "programmatic";
    pendingDismiss = { toast, trigger };
    host.dispatch("dismiss", { id: toast.id || "", reason: "action", trigger });
  };
  host.element.addEventListener("click", click);
  const observer = new MutationObserver(sync);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => {
    stop();
    observer.disconnect();
    host.element.removeEventListener("click", click);
    surface.destroy();
  };
}
