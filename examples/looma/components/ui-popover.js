import { createAnchoredSurface, createOverlay } from "./overlay.js";
export default function controller(host) {
  let initialized = false;
  let internal = false;
  let anchor;
  let placement;
  let surface;
  let overlay;
  const hide = () => { overlay?.destroy(); overlay = undefined; surface?.hide(); };
  const requestClose = (reason, trigger) => {
    if (!internal) return;
    if (typeof host.state.open !== "boolean") internal = false;
    if (!internal) hide();
    host.element.toggleAttribute("data-open", internal);
    host.dispatch("close", { open: false, reason, trigger });
  };
  const apply = () => {
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    const nextAnchor = host.state.for ? host.element.ownerDocument.getElementById(host.state.for) : null;
    if (!surface || anchor !== nextAnchor || placement !== host.state.placement) {
      surface?.destroy();
      anchor = nextAnchor;
      placement = host.state.placement;
      surface = createAnchoredSurface(host.element, anchor, placement);
    }
    host.element.toggleAttribute("data-open", internal);
    if (internal) {
      surface.show();
      if (!overlay) {
        overlay = createOverlay(host.element, { relatedElements: anchor ? [anchor] : [], requestClose });
        overlay.open();
      }
    } else hide();
    initialized = true;
  };
  const stop = host.effect(apply);
  return () => { stop(); hide(); surface?.destroy(); };
}
