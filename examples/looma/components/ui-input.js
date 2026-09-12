function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}
export default function controller(host) {
  const tag = host.element.getAttribute("data-component-root") || "";
  const kind = tag.includes("ui-textarea") ? "textarea" : tag.includes("ui-select") ? "select" : "input";
  let control;
  let initialized = false;
  const find = () => host.element.querySelector(kind);
  const sync = () => {
    control = find();
    if (!control) return;
    const controlled = host.state.value !== undefined;
    if (controlled) control.value = host.state.value;
    else if (!initialized && host.state.defaultValue !== undefined) control.value = host.state.defaultValue;
    if (kind !== "select") control.defaultValue = host.state.defaultValue || "";
    control.disabled = Boolean(host.state.disabled);
    if (kind === "textarea") {
      control.readOnly = Boolean(host.state.readOnly);
      control.rows = host.state.rows;
    } else if (kind === "input") control.readOnly = Boolean(host.state.readOnly);
    else control.required = Boolean(host.state.required);
    control.setAttribute("aria-invalid", host.state.invalid ? "true" : "false");
    host.element.toggleAttribute("data-invalid", Boolean(host.state.invalid));
    initialized = true;
  };
  const stop = host.effect(sync);
  const forward = (event) => {
    if (event.target !== control) return;
    const value = control.value;
    event.stopPropagation();
    host.dispatch(event.type, { value, trigger: triggerOf(event) });
    if (host.state.value !== undefined) queueMicrotask(sync);
  };
  host.element.addEventListener("input", forward);
  host.element.addEventListener("change", forward);
  const containsControl = (node) => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.(kind) || node.querySelector?.(kind));
  const observer = new MutationObserver((records) => {
    if (!control?.isConnected || records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsControl))) sync();
  });
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("input", forward); host.element.removeEventListener("change", forward); };
}
