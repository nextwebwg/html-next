function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}
export default function controller(host) {
  const isRadio = (host.element.getAttribute("data-component-root") || "").includes("ui-radio");
  const selector = isRadio ? 'input[type="radio"]' : 'input[type="checkbox"]';
  let control;
  let initialized = false;
  let internal = false;
  const find = () => host.element.querySelector(selector);
  const sync = () => {
    control = find();
    if (!control) return;
    const controlled = host.state.checked !== undefined;
    if (!initialized) internal = controlled ? Boolean(host.state.checked) : Boolean(host.state.defaultChecked);
    else if (controlled) internal = Boolean(host.state.checked);
    control.checked = internal;
    control.disabled = Boolean(host.state.disabled);
    control.required = Boolean(host.state.required);
    control.value = host.state.value;
    if (isRadio) control.name = host.state.name;
    else control.indeterminate = Boolean(host.state.indeterminate);
    host.element.setAttribute("aria-checked", !isRadio && host.state.indeterminate ? "mixed" : String(internal));
    host.element.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
    initialized = true;
  };
  const stop = host.effect(sync);
  const changed = (event) => {
    if (event.target !== control || (isRadio && !control.checked)) return;
    const checked = control.checked;
    if (host.state.checked === undefined) internal = checked;
    event.stopPropagation();
    sync();
    host.dispatch("change", { checked, value: host.state.value, trigger: triggerOf(event) });
  };
  host.element.addEventListener("change", changed);
  const containsControl = (node) => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.(selector) || node.querySelector?.(selector));
  const observer = new MutationObserver((records) => {
    if (!control?.isConnected || records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsControl))) sync();
  });
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("change", changed); };
}
