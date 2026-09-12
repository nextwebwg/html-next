function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}
export default function controller(host) {
  let initialized = false;
  let internal = "";
  const tabs = () => Array.from(host.element.querySelectorAll('[role="tab"]'));
  const apply = () => {
    const items = tabs();
    const controlled = host.state.value !== undefined;
    if (!initialized) internal = controlled ? host.state.value : host.state.defaultValue;
    else if (controlled) internal = host.state.value;
    if (!internal && items.length > 0) internal = items[0].id || items[0].getAttribute("aria-controls") || "";
    items.forEach((tab) => {
      const value = tab.id || tab.getAttribute("aria-controls") || "";
      const selected = value === internal;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const controls = tab.getAttribute("aria-controls");
      const panel = controls && (host.element.querySelector("#" + CSS.escape(controls)) || host.element.ownerDocument.getElementById(controls));
      if (panel) panel.hidden = !selected;
    });
    host.element.setAttribute("aria-orientation", host.state.orientation);
    initialized = true;
  };
  const stop = host.effect(apply);
  const choose = (tab, trigger) => {
    const value = tab.id || tab.getAttribute("aria-controls") || "";
    if (!value) return;
    const previousValue = internal;
    if (host.state.value === undefined) internal = value;
    apply();
    host.dispatch("select", { value, ...(previousValue ? { previousValue } : {}), trigger });
  };
  const click = (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tab && host.element.contains(tab)) choose(tab, triggerOf(event));
  };
  const keydown = (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !host.element.contains(tab)) return;
    const items = tabs();
    const vertical = host.state.orientation === "vertical";
    const previous = vertical ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const next = vertical ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!previous && !next) return;
    event.preventDefault();
    const at = items.indexOf(tab);
    const index = previous ? (at - 1 + items.length) % items.length : (at + 1) % items.length;
    choose(items[index], "keyboard");
    items[index].focus();
  };
  host.element.addEventListener("click", click);
  host.element.addEventListener("keydown", keydown);
  const observer = new MutationObserver(apply);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("click", click); host.element.removeEventListener("keydown", keydown); };
}
