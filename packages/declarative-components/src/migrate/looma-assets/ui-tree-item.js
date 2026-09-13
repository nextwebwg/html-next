function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}

export default function controller(host) {
  const row = host.refs.row;
  const disclosure = host.refs.disclosure;
  const drag = host.refs.drag;
  const children = host.refs.children;
  let initialized = false;
  let internal = false;
  let tabStop = false;

  const level = () => {
    let count = 1;
    let ancestor = host.element.parentElement?.closest('[data-component-root~="ui-tree-item"]');
    const tree = host.element.closest('[data-component-root~="ui-tree"]');
    while (ancestor && tree?.contains(ancestor)) {
      count += 1;
      ancestor = ancestor.parentElement?.closest('[data-component-root~="ui-tree-item"]');
    }
    return count;
  };
  const apply = () => {
    const controlled = typeof host.state.expanded === "boolean";
    if (!initialized) internal = controlled ? host.state.expanded : Boolean(host.state.defaultExpanded);
    else if (controlled) internal = host.state.expanded;
    const depth = level();
    host.element.setAttribute("aria-level", String(depth));
    host.element.setAttribute("aria-label", host.state.label || host.state.itemId || "Tree item");
    host.element.setAttribute("aria-selected", String(Boolean(host.state.selected)));
    host.element.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    if (host.state.container) host.element.setAttribute("aria-expanded", String(internal));
    else host.element.removeAttribute("aria-expanded");
    host.element.tabIndex = host.state.disabled || !tabStop ? -1 : 0;
    host.element.style.setProperty("--ui-tree-item-depth", String(depth - 1));
    host.element.style.marginInlineStart = depth > 1 ? "var(--ui-tree-indent, 16px)" : "0px";
    host.element.setAttribute("data-state", internal ? "expanded" : "collapsed");
    host.element.toggleAttribute("data-container", Boolean(host.state.container));
    host.element.toggleAttribute("data-selected", Boolean(host.state.selected));
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
    children.hidden = !host.state.container || !internal;
    disclosure.hidden = !host.state.container;
    disclosure.disabled = Boolean(host.state.disabled);
    disclosure.setAttribute("aria-expanded", String(internal));
    disclosure.setAttribute("aria-label", (internal ? "Collapse " : "Expand ") + (host.state.label || "item"));
    drag.hidden = !host.state.sortable || host.state.disabled;
    drag.draggable = Boolean(host.state.sortable && !host.state.disabled);
    drag.setAttribute("aria-label", "Drag " + (host.state.label || "item") + " to reorder");
    initialized = true;
  };
  const stop = host.effect(apply);
  const setExpanded = (next, trigger) => {
    if (!host.state.container || host.state.disabled || internal === next) return;
    if (typeof host.state.expanded !== "boolean") internal = next;
    apply();
    host.dispatch("expand", { id: host.state.itemId, expanded: next, trigger });
    host.element.dispatchEvent(new CustomEvent("ui-tree-expansion-change", { bubbles: true }));
  };
  const disclosureClick = (event) => {
    event.stopPropagation();
    setExpanded(!internal, triggerOf(event));
  };
  const rowClick = (event) => {
    if (!host.state.container || host.state.disabled) return;
    const interactive = event.composedPath().some((node) => node instanceof HTMLElement &&
      node !== row && node.matches('a, button, input, select, textarea, [role="button"], [role="link"], [slot="actions"]'));
    if (!interactive) setExpanded(!internal, triggerOf(event));
  };
  const internalEvent = (event) => {
    if (event.type === "ui-tree-auto-expand") setExpanded(true, "pointer");
    else if (event.type === "ui-tree-structure-sync") apply();
    else if (event.type === "ui-tree-roving-tab-stop") {
      tabStop = Boolean(event.detail?.active) && !host.state.disabled;
      apply();
    } else if (event.type === "ui-tree-request-expanded" && typeof event.detail?.expanded === "boolean") {
      setExpanded(event.detail.expanded, event.detail.trigger || "keyboard");
    }
  };
  disclosure.addEventListener("click", disclosureClick);
  row.addEventListener("click", rowClick);
  for (const type of ["ui-tree-auto-expand", "ui-tree-structure-sync", "ui-tree-roving-tab-stop", "ui-tree-request-expanded"]) {
    host.element.addEventListener(type, internalEvent);
  }
  return () => {
    stop();
    disclosure.removeEventListener("click", disclosureClick);
    row.removeEventListener("click", rowClick);
    for (const type of ["ui-tree-auto-expand", "ui-tree-structure-sync", "ui-tree-roving-tab-stop", "ui-tree-request-expanded"]) {
      host.element.removeEventListener(type, internalEvent);
    }
  };
}
