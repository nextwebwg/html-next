function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}
let nextDisclosureId = 0;
export default function controller(host) {
  let trigger;
  let content;
  let initialized = false;
  let internal = false;
  const parts = () => {
    trigger = host.element.querySelector('[data-ui-disclosure-trigger], button, [aria-controls]');
    const controls = trigger?.getAttribute("aria-controls");
    content = controls ? host.element.ownerDocument.getElementById(controls) :
      Array.from(host.element.children).find((child) => child !== trigger);
    if (trigger && content && !content.id) content.id = "disclosure-content-" + (++nextDisclosureId);
    if (trigger && content) trigger.setAttribute("aria-controls", content.id);
  };
  const apply = () => {
    parts();
    const controlled = host.state.open !== undefined;
    if (!initialized) internal = controlled ? Boolean(host.state.open) : Boolean(host.state.defaultOpen);
    else if (controlled) internal = Boolean(host.state.open);
    if (trigger) {
      trigger.setAttribute("aria-expanded", String(internal));
      if (trigger instanceof HTMLButtonElement) trigger.disabled = Boolean(host.state.disabled);
      else trigger.setAttribute("aria-disabled", String(Boolean(host.state.disabled)));
    }
    if (content) content.hidden = !internal;
    initialized = true;
  };
  const stop = host.effect(apply);
  const toggle = (event) => {
    if (!trigger?.contains(event.target)) return;
    if (host.state.disabled) { event.preventDefault(); return; }
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    if (event.type === "keydown") event.preventDefault();
    const next = !internal;
    if (host.state.open === undefined) internal = next;
    apply();
    host.dispatch(next ? "open" : "close", { open: next, reason: "action", trigger: triggerOf(event) });
  };
  host.element.addEventListener("click", toggle);
  host.element.addEventListener("keydown", toggle);
  const observer = new MutationObserver(apply);
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("click", toggle); host.element.removeEventListener("keydown", toggle); };
}
