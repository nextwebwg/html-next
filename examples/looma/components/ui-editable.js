function triggerOf(event) {
  if (!event.isTrusted) return "programmatic";
  return event instanceof KeyboardEvent ? "keyboard" : "pointer";
}

export default function controller(host) {
  const preview = host.refs.preview;
  const editor = host.refs.editor;
  let initialized = false;
  let internal = false;
  let trigger;

  const focusEditor = () => {
    const candidate = editor.querySelector('input, textarea, select, button, [tabindex], [data-component-root~="ui-combobox"], [data-component-root~="ui-multi-combobox"]');
    if (typeof candidate?.focusInput === "function") candidate.focusInput();
    else candidate?.focus();
  };
  const apply = () => {
    const controlled = typeof host.state.edit === "boolean";
    if (!initialized) internal = controlled ? host.state.edit : Boolean(host.state.defaultEdit);
    else if (controlled) internal = host.state.edit;
    preview.hidden = internal;
    editor.hidden = !internal;
    host.element.setAttribute("data-state", internal ? "edit" : "preview");
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
    initialized = true;
  };
  const stop = host.effect(apply);
  const request = (next, reason, eventTrigger) => {
    if (host.state.disabled || internal === next) return;
    if (typeof host.state.edit !== "boolean") internal = next;
    apply();
    host.dispatch("edit-change", { edit: next, reason, trigger: eventTrigger });
    requestAnimationFrame(() => next ? focusEditor() : trigger?.focus());
  };
  const editableTrigger = (event) => event.composedPath().find((node) =>
    node instanceof HTMLElement && node.hasAttribute("data-ui-editable-trigger"));
  const click = (event) => {
    if (internal) return;
    const candidate = editableTrigger(event);
    if (!candidate) return;
    trigger = candidate;
    request(true, "activate", triggerOf(event));
  };
  const keydown = (event) => {
    if (internal && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      request(false, "escape", "keyboard");
      return;
    }
    if (internal || (event.key !== "Enter" && event.key !== " ")) return;
    const candidate = editableTrigger(event);
    if (!candidate) return;
    event.preventDefault();
    trigger = candidate;
    request(true, "activate", "keyboard");
  };
  const pointerdown = (event) => {
    if (internal && !event.composedPath().includes(host.element)) request(false, "light-dismiss", "pointer");
  };
  host.element.addEventListener("click", click);
  host.element.addEventListener("keydown", keydown);
  host.element.ownerDocument.addEventListener("pointerdown", pointerdown, true);
  return () => {
    stop();
    host.element.removeEventListener("click", click);
    host.element.removeEventListener("keydown", keydown);
    host.element.ownerDocument.removeEventListener("pointerdown", pointerdown, true);
  };
}
