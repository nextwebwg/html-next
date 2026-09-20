function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}
let nextDisclosureId = 0;
export default function controller({ dispatch, effect, element, state }) {
  let trigger;
  let content;
  let initialized = false;
  let internal = false;
  const parts = () => {
    trigger = element.querySelector('[data-ui-disclosure-trigger], button, [aria-controls]');
    const controls = trigger?.getAttribute("aria-controls");
    content = controls ? element.ownerDocument.getElementById(controls) :
      Array.from(element.children).find((child) => child !== trigger);
    if (trigger && content && !content.id) content.id = "disclosure-content-" + (++nextDisclosureId);
    if (trigger && content) trigger.setAttribute("aria-controls", content.id);
  };
  const apply = () => {
    parts();
    const controlled = state.open !== undefined;
    if (!initialized) internal = controlled ? Boolean(state.open) : Boolean(state.defaultOpen);
    else if (controlled) internal = Boolean(state.open);
    if (trigger) {
      trigger.setAttribute("aria-expanded", String(internal));
      if (trigger instanceof HTMLButtonElement) trigger.disabled = Boolean(state.disabled);
      else trigger.setAttribute("aria-disabled", String(Boolean(state.disabled)));
    }
    if (content) content.hidden = !internal;
    initialized = true;
  };
  const stop = effect(apply);
  const toggle = (event) => {
    if (!trigger?.contains(event.target)) return;
    if (state.disabled) { event.preventDefault(); return; }
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    if (event.type === "keydown") event.preventDefault();
    const next = !internal;
    if (state.open === undefined) internal = next;
    apply();
    dispatch(next ? "open" : "close", { open: next, reason: "action", trigger: triggerOf(event) });
  };
  element.addEventListener("click", toggle);
  element.addEventListener("keydown", toggle);
  const observer = new MutationObserver(apply);
  observer.observe(element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); element.removeEventListener("click", toggle); element.removeEventListener("keydown", toggle); };
}
