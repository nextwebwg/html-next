function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}
export default function controller(host) {
  const control = host.refs.control;
  let initialized = false;
  let internal = false;
  const sync = () => {
    const controlled = host.state.checked !== undefined;
    if (!initialized) internal = controlled ? Boolean(host.state.checked) : Boolean(host.state.defaultChecked);
    else if (controlled) internal = Boolean(host.state.checked);
    control.checked = internal;
    control.disabled = Boolean(host.state.disabled);
    control.required = Boolean(host.state.required);
    control.value = host.state.value;
    host.element.setAttribute("aria-checked", String(internal));
    host.element.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    host.element.tabIndex = host.state.disabled ? -1 : 0;
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
    initialized = true;
  };
  const stop = host.effect(sync);
  const changed = (event) => {
    if (event.target !== control) return;
    const checked = control.checked;
    if (host.state.checked === undefined) internal = checked;
    event.stopPropagation();
    sync();
    host.dispatch("change", { checked, value: host.state.value, trigger: triggerOf(event) });
  };
  const keydown = (event) => {
    if (event.key !== " " || host.state.disabled) return;
    event.preventDefault();
    control.click();
  };
  host.element.addEventListener("change", changed);
  host.element.addEventListener("keydown", keydown);
  return () => { stop(); host.element.removeEventListener("change", changed); host.element.removeEventListener("keydown", keydown); };
}
