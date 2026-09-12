import { createAnchoredSurface, createOverlay } from "./overlay.js";

export default function controller(host) {
  let initialized = false;
  let internal = false;
  let trigger;
  let surface;
  let overlay;
  let showTimer;
  let hideTimer;
  let focused = false;
  let pinned = false;

  const clearTimers = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = undefined;
    hideTimer = undefined;
  };
  const render = () => {
    host.element.hidden = !internal;
    host.element.setAttribute("data-state", internal ? "open" : "closed");
    if (!internal) {
      overlay?.destroy();
      overlay = undefined;
      surface?.hide();
      return;
    }
    surface?.show();
    if (overlay) return;
    overlay = createOverlay(host.element, {
      relatedElements: trigger ? [trigger] : [],
      requestClose(reason, eventTrigger) {
        if (reason !== "escape" && !(reason === "light-dismiss" && host.state.toggleOnClick)) return;
        pinned = false;
        clearTimers();
        if (typeof host.state.open !== "boolean") internal = false;
        render();
        host.dispatch("close", { open: false, reason, trigger: eventTrigger });
      },
    });
    overlay.open();
  };
  const setOpen = (next, eventTrigger) => {
    if (next === internal) return;
    if (typeof host.state.open !== "boolean") internal = next;
    render();
    host.dispatch(next ? "open" : "close", { open: next, reason: "action", trigger: eventTrigger });
  };
  const pointerEnter = (event) => {
    if (event.pointerType === "touch") return;
    clearTimeout(hideTimer);
    hideTimer = undefined;
    if (internal || showTimer !== undefined) return;
    showTimer = setTimeout(() => {
      showTimer = undefined;
      setOpen(true, "pointer");
    }, Math.max(0, host.state.showDelay));
  };
  const pointerLeave = () => {
    clearTimeout(showTimer);
    showTimer = undefined;
    if (focused || pinned || !internal || hideTimer !== undefined) return;
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      setOpen(false, "pointer");
    }, Math.max(0, host.state.hideDelay));
  };
  const focusIn = () => {
    focused = true;
    clearTimers();
    setOpen(true, "keyboard");
  };
  const focusOut = (event) => {
    if (event.relatedTarget && host.element.contains(event.relatedTarget)) return;
    focused = false;
    pinned = false;
    clearTimers();
    setOpen(false, "keyboard");
  };
  const click = (event) => {
    if (!host.state.toggleOnClick) return;
    clearTimers();
    pinned = !pinned;
    setOpen(pinned, event.detail === 0 ? "keyboard" : "pointer");
  };
  const detach = () => {
    if (!trigger) return;
    const ids = (trigger.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== host.element.id);
    if (ids.length) trigger.setAttribute("aria-describedby", ids.join(" "));
    else trigger.removeAttribute("aria-describedby");
    trigger.removeEventListener("pointerenter", pointerEnter);
    trigger.removeEventListener("pointerleave", pointerLeave);
    trigger.removeEventListener("focusin", focusIn);
    trigger.removeEventListener("focusout", focusOut);
    trigger.removeEventListener("click", click);
  };
  const apply = () => {
    const controlled = typeof host.state.open === "boolean";
    if (!initialized) internal = controlled ? host.state.open : Boolean(host.state.defaultOpen);
    else if (controlled) internal = host.state.open;
    const nextTrigger = host.state.for
      ? host.element.ownerDocument.getElementById(host.state.for)
      : host.element.previousElementSibling;
    if (nextTrigger !== trigger) {
      detach();
      trigger = nextTrigger;
      if (!host.element.id) {
        host.element.id = "tooltip-" + Math.random().toString(36).slice(2);
      }
      if (trigger) {
        const ids = new Set(
          (trigger.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean),
        );
        ids.add(host.element.id);
        trigger.setAttribute("aria-describedby", [...ids].join(" "));
        trigger.addEventListener("pointerenter", pointerEnter);
        trigger.addEventListener("pointerleave", pointerLeave);
        trigger.addEventListener("focusin", focusIn);
        trigger.addEventListener("focusout", focusOut);
        trigger.addEventListener("click", click);
      }
      surface?.destroy();
      surface = createAnchoredSurface(host.element, trigger, host.state.placement);
    }
    render();
    initialized = true;
  };
  const stop = host.effect(apply);
  host.element.addEventListener("pointerleave", pointerLeave);
  return () => {
    stop();
    clearTimers();
    detach();
    host.element.removeEventListener("pointerleave", pointerLeave);
    overlay?.destroy();
    surface?.destroy();
  };
}
