const ITEM = '[data-component-root~="ui-tree-item"]';

export default function controller(host) {
  let tabStop;
  let source;
  let target;
  let position;
  let hoverTimer;

  const items = () => Array.from(host.element.querySelectorAll(ITEM));
  const parentItem = (item) => item.parentElement?.closest(ITEM);
  const visibleItems = () => items().filter((item) => {
    if (item.disabled || item.getAttribute("aria-disabled") === "true") return false;
    let parent = parentItem(item);
    while (parent && host.element.contains(parent)) {
      if (parent.getAttribute("aria-expanded") === "false") return false;
      parent = parentItem(parent);
    }
    return true;
  });
  const syncTabStop = (preferred) => {
    const visible = visibleItems();
    const next = preferred && visible.includes(preferred) ? preferred
      : tabStop && visible.includes(tabStop) ? tabStop : visible[0];
    tabStop = next;
    for (const item of visible) item.dispatchEvent(new CustomEvent("ui-tree-roving-tab-stop", {
      detail: { active: item === next },
    }));
  };
  const sync = () => {
    host.element.setAttribute("aria-label", host.state.label || "Tree");
    for (const item of items()) item.dispatchEvent(new CustomEvent("ui-tree-structure-sync"));
    syncTabStop();
  };
  const stop = host.effect(sync);
  queueMicrotask(sync);
  const itemFrom = (event) => event.composedPath().find((node) =>
    node instanceof HTMLElement && node.matches(ITEM) && host.element.contains(node));
  const interactive = (event) => {
    for (const node of event.composedPath()) {
      if (node instanceof HTMLElement && node.matches(ITEM)) break;
      if (node instanceof HTMLElement && node.matches('a, button, input, select, textarea, [role="button"], [role="link"]')) return true;
    }
    return false;
  };
  const requestExpanded = (item, expanded) => item.dispatchEvent(new CustomEvent("ui-tree-request-expanded", {
    detail: { expanded, trigger: "keyboard" },
  }));
  const focus = (item) => { syncTabStop(item); item.focus(); };
  const keydown = (event) => {
    if (interactive(event)) return;
    const current = itemFrom(event);
    if (!current) return;
    const visible = visibleItems();
    const at = visible.indexOf(current);
    const next = event.key === "ArrowDown" ? visible[at + 1]
      : event.key === "ArrowUp" ? visible[at - 1]
      : event.key === "Home" ? visible[0]
      : event.key === "End" ? visible.at(-1) : undefined;
    if (next) { event.preventDefault(); focus(next); return; }
    if (event.key === "ArrowLeft") {
      if (current.getAttribute("aria-expanded") === "true") {
        event.preventDefault(); requestExpanded(current, false);
      } else {
        const parent = parentItem(current);
        if (parent) { event.preventDefault(); focus(parent); }
      }
    } else if (event.key === "ArrowRight") {
      if (current.getAttribute("aria-expanded") === "false") {
        event.preventDefault(); requestExpanded(current, true);
      } else if (current.getAttribute("aria-expanded") === "true") {
        const child = visible.find((candidate) => parentItem(candidate) === current);
        if (child) { event.preventDefault(); focus(child); }
      }
    }
  };
  const metadata = (item) => ({
    id: item.itemId || item.getAttribute("data-item-id") || "",
    type: item.dragType || item.getAttribute("data-drag-type") || "item",
    scope: item.dropScope || item.getAttribute("data-drop-scope") || "",
    accepts: (item.accepts || item.getAttribute("data-accepts") || "").split(",").map((value) => value.trim()).filter(Boolean),
  });
  const clearDrag = () => {
    clearTimeout(hoverTimer);
    source?.removeAttribute("data-dragging");
    target?.removeAttribute("data-drop-position");
    source = target = position = undefined;
  };
  const dragstart = (event) => {
    const item = itemFrom(event);
    if (!item || !item.sortable || item.disabled || !event.composedPath().some((node) => node instanceof HTMLElement && node.classList.contains("tree-item__drag"))) {
      event.preventDefault(); return;
    }
    source = item;
    item.setAttribute("data-dragging", "true");
    event.dataTransfer?.setData("text/plain", metadata(item).id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };
  const dragover = (event) => {
    const item = itemFrom(event);
    if (!source || !item || item === source) return;
    const rect = item.querySelector(".tree-item__row")?.getBoundingClientRect() || item.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    const nextPosition = item.container && ratio >= 0.25 && ratio <= 0.75 ? "inside" : ratio < 0.5 ? "before" : "after";
    const sourceMeta = metadata(source);
    const targetMeta = metadata(item);
    const descendant = source.contains(item);
    const incompatible = nextPosition === "inside"
      ? !item.container || (targetMeta.accepts.length > 0 && !targetMeta.accepts.includes(sourceMeta.type))
      : sourceMeta.type !== targetMeta.type;
    if (descendant || incompatible) return;
    event.preventDefault();
    target?.removeAttribute("data-drop-position");
    target = item;
    position = nextPosition;
    target.setAttribute("data-drop-position", position);
    clearTimeout(hoverTimer);
    if (position === "inside" && target.getAttribute("aria-expanded") === "false") {
      hoverTimer = setTimeout(() => target?.dispatchEvent(new CustomEvent("ui-tree-auto-expand")), Math.max(0, host.state.hoverExpandDelay));
    }
  };
  const drop = (event) => {
    if (!source || !target || !position) return;
    event.preventDefault();
    const from = metadata(source);
    const to = metadata(target);
    host.dispatch("reorder", {
      sourceId: from.id, targetId: to.id, position,
      sourceType: from.type, targetType: to.type,
      sourceScope: from.scope, targetScope: to.scope, trigger: "pointer",
    });
    if (position === "inside") target.dispatchEvent(new CustomEvent("ui-tree-auto-expand"));
    clearDrag();
  };
  const focusin = (event) => { if (!interactive(event)) { const item = itemFrom(event); if (item) syncTabStop(item); } };
  const expansion = () => requestAnimationFrame(() => syncTabStop());
  host.element.addEventListener("keydown", keydown);
  host.element.addEventListener("focusin", focusin);
  host.element.addEventListener("ui-tree-expansion-change", expansion);
  host.element.addEventListener("dragstart", dragstart);
  host.element.addEventListener("dragover", dragover);
  host.element.addEventListener("drop", drop);
  host.element.addEventListener("dragend", clearDrag);
  const observer = new MutationObserver(sync);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => {
    stop(); observer.disconnect(); clearDrag();
    host.element.removeEventListener("keydown", keydown);
    host.element.removeEventListener("focusin", focusin);
    host.element.removeEventListener("ui-tree-expansion-change", expansion);
    host.element.removeEventListener("dragstart", dragstart);
    host.element.removeEventListener("dragover", dragover);
    host.element.removeEventListener("drop", drop);
    host.element.removeEventListener("dragend", clearDrag);
  };
}
