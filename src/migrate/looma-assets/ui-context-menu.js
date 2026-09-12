import { createAnchoredSurface, createOverlay } from "./overlay.js";

function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}

function menuItems(surface) {
  return Array.from(surface.querySelectorAll('[role="menuitem"]'))
    .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
}

export default function controller(host) {
  const surfaceElement = host.refs.surface;
  let initialized = false;
  let internal = false;
  let target;
  let targetAbort;
  const surface = createAnchoredSurface(surfaceElement, null);
  let overlay;

  const hide = () => {
    overlay?.destroy();
    overlay = undefined;
    surface.hide();
  };
  const requestClose = (reason, trigger) => {
    if (!internal) return;
    if (typeof host.state.open !== "boolean") internal = false;
    if (!internal) hide();
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    host.dispatch("close", { open: false, reason, trigger });
  };
  const show = (point) => {
    if (point) surface.showAtPoint(point);
    else {
      surface.setAnchor(target);
      surface.show();
    }
    overlay?.destroy();
    overlay = createOverlay(surfaceElement, {
      relatedElements: target ? [target] : [],
      requestClose,
    });
    overlay.open();
  };
  const openFrom = (event) => {
    event.preventDefault();
    if (typeof host.state.open !== "boolean") internal = true;
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    if (internal) show(event.type === "contextmenu" ? { x: event.clientX, y: event.clientY } : undefined);
    host.dispatch("open", { open: true, reason: "action", trigger: event.type === "contextmenu" ? "pointer" : triggerOf(event) });
    requestAnimationFrame(() => menuItems(surfaceElement)[0]?.focus());
  };
  const bindTarget = () => {
    const next = host.state.for
      ? host.element.ownerDocument.getElementById(host.state.for)
      : host.element.querySelector('[slot="trigger"]');
    if (next === target) return;
    targetAbort?.abort();
    targetAbort = new AbortController();
    target = next;
    if (!target) return;
    target.setAttribute("aria-haspopup", "menu");
    target.addEventListener("contextmenu", openFrom, { signal: targetAbort.signal });
  };
  const apply = () => {
    bindTarget();
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    if (internal && !overlay) show(); else if (!internal) hide();
    initialized = true;
  };
  const stop = host.effect(apply);
  const click = (event) => {
    const item = event.target.closest?.('[role="menuitem"]');
    if (!item || !surfaceElement.contains(item) || item.disabled || item.getAttribute("aria-disabled") === "true") return;
    const trigger = triggerOf(event);
    const value = item.value ?? item.getAttribute("data-value") ?? "";
    host.dispatch("select", { value, trigger });
    requestClose("action", trigger);
  };
  const keydown = (event) => {
    const items = menuItems(surfaceElement);
    if (items.length === 0) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (event.key === "Home" || event.key === "End") {
      items[event.key === "Home" ? 0 : items.length - 1].focus();
      return;
    }
    const at = items.indexOf(event.target.closest?.('[role="menuitem"]'));
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(Math.max(at, 0) + step + items.length) % items.length].focus();
  };
  host.element.addEventListener("click", click);
  host.element.addEventListener("keydown", keydown);
  const observer = new MutationObserver(bindTarget);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => {
    stop();
    observer.disconnect();
    targetAbort?.abort();
    hide();
    surface.destroy();
    host.element.removeEventListener("click", click);
    host.element.removeEventListener("keydown", keydown);
  };
}
