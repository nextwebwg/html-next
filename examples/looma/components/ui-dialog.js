import { createOverlay } from "./overlay.js";
export default function controller(host) {
  const dialog = host.refs.dialog;
  let initialized = false;
  let internal = false;
  let shown = false;
  let mode;
  let overlay;
  let closing = false;
  const label = () => {
    const heading = host.element.querySelector('[slot="heading"], [data-ui-dialog-title], h1, h2, h3, h4, h5, h6');
    return host.state.label?.trim() || heading?.textContent?.trim() || "Dialog";
  };
  const hide = () => {
    overlay?.destroy();
    overlay = undefined;
    if (dialog.open) {
      closing = true;
      dialog.close();
      closing = false;
    }
    shown = false;
  };
  const requestClose = (reason, trigger) => {
    if (!internal || !host.state.dismissible) return;
    if (typeof host.state.open !== "boolean") internal = false;
    if (!internal) hide();
    host.element.toggleAttribute("data-open", internal);
    host.dispatch("close", { open: false, reason, trigger });
  };
  const apply = () => {
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    dialog.setAttribute("aria-label", label());
    host.element.toggleAttribute("data-open", internal);
    const nextMode = host.state.modal ? "modal" : "modeless";
    if (shown && mode !== nextMode) hide();
    if (internal && !shown) {
      mode = nextMode;
      if (host.state.modal) dialog.showModal(); else dialog.show();
      shown = true;
      overlay = createOverlay(host.element, {
        modal: host.state.modal,
        dismissible: host.state.dismissible,
        requestClose,
      });
      overlay.open();
    } else if (!internal && shown) hide();
    initialized = true;
  };
  const stop = host.effect(apply);
  const cancel = (event) => { event.preventDefault(); requestClose("escape", "keyboard"); };
  const nativeClose = () => {
    if (closing || !shown) return;
    shown = false;
    overlay?.destroy();
    overlay = undefined;
    if (typeof host.state.open !== "boolean") internal = false;
    host.dispatch("close", { open: false, reason: "programmatic", trigger: "programmatic" });
  };
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener("close", nativeClose);
  const observer = new MutationObserver(() => dialog.setAttribute("aria-label", label()));
  observer.observe(host.element, { childList: true, subtree: true, characterData: true });
  return () => { stop(); observer.disconnect(); dialog.removeEventListener("cancel", cancel); dialog.removeEventListener("close", nativeClose); hide(); };
}
