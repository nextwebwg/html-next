/** The `on:` modifiers that filter which events reach a handler, shared by live and compiled output. */

/** Whether an event passes a binding's `self`, mouse-button, system-key, `exact` and key modifiers. */
export function eventPasses(event: Event, element: Element, modifiers: readonly string[]): boolean {
  if (modifiers.includes("self") && event.target !== element) return false;
  if (event instanceof MouseEvent) {
    const buttonFilters = modifiers.filter((modifier) => ["left", "middle", "right"].includes(modifier));
    const buttons: Record<string, number> = { left: 0, middle: 1, right: 2 };
    if (buttonFilters.length > 0 && !buttonFilters.some((filter) => event.button === buttons[filter])) return false;
  }
  const systemKeys = ["ctrl", "shift", "alt", "meta"] as const;
  for (const key of systemKeys) {
    if (modifiers.includes(key) && !(event as unknown as Record<string, boolean>)[`${key}Key`]) return false;
  }
  if (
    modifiers.includes("exact") &&
    systemKeys.some((key) => !modifiers.includes(key) && (event as unknown as Record<string, boolean>)[`${key}Key`])
  ) return false;
  if (event instanceof KeyboardEvent) {
    const keyFilters = modifiers.filter((modifier) =>
      ["enter", "escape", "space", "tab", "up", "down", "left", "right"].includes(modifier),
    );
    const keyNames: Record<string, string> = {
      enter: "Enter", escape: "Escape", space: " ", tab: "Tab",
      up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    };
    if (keyFilters.length > 0 && !keyFilters.some((filter) => event.key === keyNames[filter])) return false;
  }
  return true;
}
