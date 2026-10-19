/** Native form-control values, read and written as the live runtime's two-way bindings do. */

import { truthy, type Value } from "./expression.js";

/** What a bound control holds: checkedness, a number, the selected values, or its value. */
export function controlValue(element: Element): Value {
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") return element.checked;
    if (element.type === "number" || element.type === "range") {
      return Number.isNaN(element.valueAsNumber) ? null : element.valueAsNumber;
    }
    return element.value;
  }
  if (element instanceof HTMLSelectElement) {
    return element.multiple
      ? Array.from(element.selectedOptions, (option) => option.value)
      : element.value;
  }
  if (element instanceof HTMLTextAreaElement) return element.value;
  return (element as unknown as { value?: Value }).value ?? element.getAttribute("value");
}

const held = new WeakMap<Element, unknown>();

/**
 * An emptied control's write reverts its state to the declared `value`
 * (types#null-and-missing-values); the binding does not echo that value back into the control the
 * user is editing. `reverted` is the value the state took, or undefined to release the control. A
 * later value that differs, written from anywhere else, shows normally.
 */
export function holdControl(element: Element, reverted: unknown): void {
  if (reverted == null) held.delete(element);
  else held.set(element, reverted);
}

/**
 * Writes a bound value into a native control, skipping writes the control already agrees with.
 *
 * The skip is required, not an optimization: assigning `value` resets the control's dirty value
 * flag even when the string is identical, and `minlength`/`maxlength` only constrain a dirty
 * value. Echoing the user's own input back would therefore switch off their constraints.
 */
export function applyBoundControlValue(element: Element, name: string, value: Value): boolean {
  if (held.has(element)) {
    if (Object.is(held.get(element), value)) return true;
    held.delete(element);
  }
  const lowerName = name.toLowerCase();
  if (lowerName === "checked" && element instanceof HTMLInputElement) {
    const next = truthy(value);
    if (element.checked !== next) element.checked = next;
    return true;
  }
  if (lowerName === "value" && element instanceof HTMLSelectElement && element.multiple) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    for (const option of Array.from(element.options)) {
      const next = selected.has(option.value);
      if (option.selected !== next) option.selected = next;
    }
    return true;
  }
  if (
    lowerName === "value" &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement)
  ) {
    const next = value == null ? "" : String(value);
    if (element.value !== next) element.value = next;
    return true;
  }
  return false;
}
