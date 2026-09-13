const state = globalThis[Symbol.for("nextwebwg.looma.overlays")] ||= {
  stack: [],
  documents: new WeakMap(),
};

function syncDocument(document) {
  const hasModal = state.stack.some((record) => record.document === document && record.modal);
  document.documentElement.toggleAttribute("data-ui-scroll-lock", hasModal);
  if (hasModal) document.documentElement.style.overflow = "hidden";
  else document.documentElement.style.removeProperty("overflow");
  if (state.stack.some((record) => record.document === document)) return;
  state.documents.get(document)?.abort();
  state.documents.delete(document);
}

function ensureDocument(document) {
  if (state.documents.has(document)) return;
  const abort = new AbortController();
  document.addEventListener("keydown", (event) => {
    const top = state.stack.at(-1);
    if (event.key === "Escape" && top?.document === document && top.dismissible) {
      top.requestClose("escape", "keyboard");
    }
  }, { signal: abort.signal });
  document.addEventListener("pointerdown", (event) => {
    const top = state.stack.at(-1);
    if (top?.document !== document || !top.dismissible) return;
    const boundary = [top.element, ...top.relatedElements];
    if (event.composedPath().some((node) =>
      node instanceof Node && boundary.some((element) => element.contains(node)))) return;
    top.requestClose("light-dismiss", "pointer");
  }, { capture: true, signal: abort.signal });
  state.documents.set(document, abort);
}

export function createOverlay(element, options) {
  const document = element.ownerDocument;
  const record = {
    document,
    element,
    relatedElements: options.relatedElements || [],
    modal: Boolean(options.modal),
    dismissible: options.dismissible !== false,
    requestClose: options.requestClose,
  };
  const close = () => {
    const index = state.stack.indexOf(record);
    if (index >= 0) state.stack.splice(index, 1);
    syncDocument(document);
  };
  return {
    open() { close(); state.stack.push(record); ensureDocument(document); syncDocument(document); },
    close,
    destroy: close,
  };
}

function show(surface) {
  surface.setAttribute("popover", "manual");
  surface.hidden = false;
  if (typeof surface.showPopover === "function" && !surface.matches(":popover-open")) {
    try { surface.showPopover(); } catch {}
  }
}

function hide(surface) {
  if (typeof surface.hidePopover === "function" && surface.matches(":popover-open")) {
    try { surface.hidePopover(); } catch {}
  }
  surface.hidden = true;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

export function createAnchoredSurface(surface, anchor, placement = "bottom-start") {
  const owner = surface.ownerDocument.defaultView;
  const abort = new AbortController();
  let currentAnchor = anchor;
  let point;
  let opened = false;
  let frame;
  const position = () => {
    frame = undefined;
    if (!opened) return;
    const origin = point || currentAnchor?.getBoundingClientRect();
    if (!origin) return;
    const rect = surface.getBoundingClientRect();
    const left = point ? point.x : placement.endsWith("end") ? origin.right - rect.width : origin.left;
    let top = point ? point.y + 4 : placement.startsWith("top") ? origin.top - rect.height - 4 : origin.bottom + 4;
    if (!point && top + rect.height > owner.innerHeight - 8 && origin.top >= rect.height + 12) {
      top = origin.top - rect.height - 4;
    } else if (!point && top < 8 && origin.bottom + rect.height + 12 <= owner.innerHeight) {
      top = origin.bottom + 4;
    }
    surface.style.position = "fixed";
    surface.style.left = Math.round(clamp(left, 8, owner.innerWidth - rect.width - 8)) + "px";
    surface.style.top = Math.round(clamp(top, 8, owner.innerHeight - rect.height - 8)) + "px";
    surface.style.margin = "0";
  };
  const schedule = () => {
    if (!opened || frame !== undefined) return;
    frame = owner.requestAnimationFrame(position);
  };
  owner.addEventListener("resize", schedule, { passive: true, signal: abort.signal });
  owner.addEventListener("scroll", schedule, { passive: true, capture: true, signal: abort.signal });
  return {
    setAnchor(next) { currentAnchor = next; point = undefined; schedule(); },
    show() { point = undefined; opened = true; show(surface); position(); },
    showAtPoint(next) { point = next; opened = true; show(surface); position(); },
    hide() {
      opened = false;
      point = undefined;
      if (frame !== undefined) owner.cancelAnimationFrame(frame);
      frame = undefined;
      hide(surface);
    },
    refresh: schedule,
    destroy() { abort.abort(); this.hide(); },
  };
}

export function createViewportSurface(surface) {
  return { show: () => show(surface), hide: () => hide(surface), destroy: () => hide(surface) };
}

function distance(point, rect) {
  const x = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const y = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(x, y);
}

export function createProximityCoordinator(scope, radius = 16) {
  const owner = scope.ownerDocument.defaultView;
  const abort = new AbortController();
  let anchors = [];
  let point;
  let frame;
  const measure = () => {
    anchors = Array.from(scope.querySelectorAll("[data-ui-affordance]"))
      .filter((element) => !element.disabled && element.getAttribute("aria-disabled") !== "true")
      .map((element) => ({ element, rect: element.getBoundingClientRect() }));
  };
  const update = () => {
    frame = undefined;
    let engaged = false;
    for (const anchor of anchors) {
      const near = point !== undefined && distance(point, anchor.rect) <= Math.max(0, radius);
      if (near) anchor.element.setAttribute("data-ui-proximity", "near");
      else anchor.element.removeAttribute("data-ui-proximity");
      engaged ||= near;
    }
    if (engaged) scope.setAttribute("data-ui-interaction", "engaged");
    else scope.removeAttribute("data-ui-interaction");
  };
  const schedule = () => { if (frame === undefined) frame = owner.requestAnimationFrame(update); };
  const refresh = () => { measure(); schedule(); };
  scope.addEventListener("pointermove", (event) => {
    point = event.pointerType === "touch" ? undefined : { x: event.clientX, y: event.clientY };
    schedule();
  }, { passive: true, signal: abort.signal });
  owner.addEventListener("resize", refresh, { passive: true, signal: abort.signal });
  owner.addEventListener("scroll", refresh, { passive: true, capture: true, signal: abort.signal });
  measure();
  return {
    refresh,
    destroy() {
      abort.abort();
      if (frame !== undefined) owner.cancelAnimationFrame(frame);
      for (const { element } of anchors) element.removeAttribute("data-ui-proximity");
      scope.removeAttribute("data-ui-interaction");
    },
  };
}
