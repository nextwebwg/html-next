export default function controller(host) {
  let current = host.state.value || "";
  let lastControlledValue = current;
  const radios = () => Array.from(host.element.querySelectorAll('[data-component-root~="ui-radio"]'));
  const native = (radio) => radio.querySelector('input[type="radio"]');
  const apply = () => {
    const items = radios();
    const selected = items.findIndex((radio) => radio.value === current);
    items.forEach((radio, index) => {
      radio.checked = radio.value === current;
      radio.name = host.state.name || host.element.id || "ui-radio-group";
      radio.disabled = Boolean(host.state.disabled);
      radio.required = Boolean(host.state.required);
      const input = native(radio);
      if (input) input.tabIndex = index === (selected < 0 ? 0 : selected) ? 0 : -1;
    });
    host.element.setAttribute("aria-orientation", host.state.orientation);
    host.element.toggleAttribute("data-disabled", Boolean(host.state.disabled));
  };
  const stop = host.effect(() => {
    const controlledValue = host.state.value || "";
    if (controlledValue !== lastControlledValue) {
      current = controlledValue;
      lastControlledValue = controlledValue;
    }
    apply();
  });
  const select = (value, trigger) => {
    if (!value || value === current || host.state.disabled) return;
    const previousValue = current;
    current = value;
    apply();
    host.dispatch("select", { value, previousValue, trigger });
    host.dispatch("change", { checked: true, value, trigger });
  };
  const change = (event) => {
    const radio = event.target.closest?.('[data-component-root~="ui-radio"]');
    if (!radio || !host.element.contains(radio) || event.detail?.checked !== true) return;
    event.stopPropagation();
    select(radio.value, event.detail.trigger || "programmatic");
  };
  const keydown = (event) => {
    const items = radios().filter((radio) => !radio.disabled);
    if (items.length === 0) return;
    const vertical = host.state.orientation === "vertical";
    const previous = vertical ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const next = vertical ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!previous && !next) return;
    event.preventDefault();
    const at = Math.max(0, items.findIndex((radio) => radio.value === current));
    const index = previous ? (at - 1 + items.length) % items.length : (at + 1) % items.length;
    select(items[index].value, "keyboard");
    native(items[index])?.focus();
  };
  host.element.addEventListener("change", change);
  host.element.addEventListener("keydown", keydown);
  const containsRadio = (node) => node.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.('[data-component-root~="ui-radio"]') || node.querySelector?.('[data-component-root~="ui-radio"]'));
  const observer = new MutationObserver((records) => {
    if (records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsRadio))) apply();
  });
  observer.observe(host.element, { childList: true, subtree: true });
  return () => { stop(); observer.disconnect(); host.element.removeEventListener("change", change); host.element.removeEventListener("keydown", keydown); };
}
