import { createAnchoredSurface, createOverlay } from "./overlay.js";

function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}

function itemsWithin(element) {
  return Array.from(element.querySelectorAll('[role="menuitem"]'))
    .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
}

export default function controller(host) {
  let initialized = false;
  let internal = false;
  let anchor;
  let placement;
  let surface;
  let overlay;

  const hide = () => {
    overlay?.destroy();
    overlay = undefined;
    surface?.hide();
  };
  const syncAnchor = () => {
    if (!anchor) return;
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", String(internal));
  };
  const requestClose = (reason, trigger) => {
    if (!internal) return;
    if (typeof host.state.open !== "boolean") internal = false;
    if (!internal) hide();
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    syncAnchor();
    host.dispatch("close", { open: false, reason, trigger });
  };
  const show = () => {
    surface.show();
    if (!overlay) {
      overlay = createOverlay(host.element, {
        relatedElements: anchor ? [anchor] : [],
        requestClose,
      });
      overlay.open();
    }
  };
  const apply = () => {
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    const nextAnchor = host.state.for ? host.element.ownerDocument.getElementById(host.state.for) : null;
    if (!surface || anchor !== nextAnchor || placement !== host.state.placement) {
      hide();
      surface?.destroy();
      anchor = nextAnchor;
      placement = host.state.placement;
      surface = createAnchoredSurface(host.element, anchor, placement);
    }
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    syncAnchor();
    if (internal) show(); else hide();
    initialized = true;
  };
  const stop = host.effect(apply);
  const click = (event) => {
    const item = event.target.closest?.('[role="menuitem"]');
    if (item && host.element.contains(item) && !item.disabled && item.getAttribute("aria-disabled") !== "true") {
      const value = item.value ?? item.getAttribute("data-value") ?? "";
      host.dispatch("select", { value, trigger: triggerOf(event) });
      requestClose("action", triggerOf(event));
      return;
    }
    if (!anchor?.contains(event.target)) return;
    const next = !internal;
    if (typeof host.state.open !== "boolean") internal = next;
    apply();
    host.dispatch(next ? "open" : "close", {
      open: next,
      reason: "action",
      trigger: triggerOf(event),
    });
  };
  const keydown = (event) => {
    const items = itemsWithin(host.element);
    if (items.length === 0) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1].focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = items.indexOf(event.target.closest?.('[role="menuitem"]'));
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(Math.max(at, 0) + step + items.length) % items.length].focus();
  };
  host.element.addEventListener("click", click);
  host.element.addEventListener("keydown", keydown);
  anchor?.addEventListener("click", click);
  return () => {
    stop();
    hide();
    surface?.destroy();
    host.element.removeEventListener("click", click);
    host.element.removeEventListener("keydown", keydown);
    anchor?.removeEventListener("click", click);
  };
}
