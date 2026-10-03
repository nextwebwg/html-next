import type { GeneratedArtifact } from "../generate.js";

const SOURCE = `type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type BoundName = "value" | "checked";
export interface BoundDefaults {
  readonly value?: string;
  readonly checked?: boolean;
  readonly options?: readonly boolean[];
}

const boundValues = new WeakMap<Control, unknown>();
const preHydrationValues = new WeakMap<Control, { readonly bound: unknown; readonly value: string; readonly checked: boolean }>();

function snapshot(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  }
  return false;
}

function readControl(element: Control): unknown {
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") return element.checked;
    if (element.type === "number" || element.type === "range") {
      return Number.isNaN(element.valueAsNumber) ? null : element.valueAsNumber;
    }
  }
  if (element instanceof HTMLSelectElement && element.multiple) {
    return Array.from(element.selectedOptions, (option) => option.value);
  }
  return element.value;
}

/** Other elements use their value property, then their value attribute, as the live runtime does. */
export function attachGenericBinding(element: Element | null, update: (value: unknown) => void): (() => void) | undefined {
  if (element === null) return undefined;
  const eventName = element instanceof HTMLSelectElement || element instanceof HTMLInputElement &&
    ["checkbox", "radio", "file"].includes(element.type) ? "change" : "input";
  const listener = (): void => {
    if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked) return;
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? readControl(element)
      : (element as Element & { value?: unknown }).value ?? element.getAttribute("value");
    update(value);
  };
  element.addEventListener(eventName, listener);
  return () => element.removeEventListener(eventName, listener);
}

// This module runs before hydrateRoot. React may replace a textarea's live value during hydration,
// so retain the browser's pre-hydration edit before React starts claiming existing nodes.
if (typeof document !== "undefined") {
  for (const element of document.querySelectorAll("input, textarea, select")) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      preHydrationValues.set(element, {
        bound: snapshot(readControl(element)),
        value: element.value,
        checked: element instanceof HTMLInputElement && element.checked,
      });
    }
  }
}

function writeControl(element: Control, name: BoundName, value: unknown, nativeProperty: boolean): void {
  if (name === "checked" && element instanceof HTMLInputElement) {
    const next = Boolean(value);
    if (element.checked !== next) element.checked = next;
  } else if (name === "value" && element instanceof HTMLSelectElement && element.multiple && !nativeProperty) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    for (const option of Array.from(element.options)) {
      const next = selected.has(option.value);
      if (option.selected !== next) option.selected = next;
    }
  } else if (nativeProperty) {
    // Use the native setter: input/textarea coerce null to "", unlike String(null).
    element.value = value as string;
  } else {
    const next = value == null ? "" : String(value);
    if (element.value !== next) element.value = next;
  }
}

function restoreDefault(element: Control, name: BoundName, defaults: BoundDefaults): void {
  if (name === "checked" && element instanceof HTMLInputElement) {
    const current = element.checked;
    element.defaultChecked = defaults.checked ?? false;
    element.checked = current;
  } else if (element instanceof HTMLSelectElement) {
    const options = Array.from(element.options);
    const selected = options.map((option) => option.selected);
    for (const [index, option] of options.entries()) option.defaultSelected = defaults.options?.[index] ?? false;
    for (const [index, option] of options.entries()) if (!selected[index]) option.selected = false;
    for (const [index, option] of options.entries()) if (selected[index]) option.selected = true;
  } else {
    const current = element.value;
    element.defaultValue = defaults.value ?? "";
    element.value = current;
  }
}

/** Keep native pre-hydration edits until the bound model itself changes. */
export function attachBoundControl(
  element: Element | null,
  name: BoundName,
  initial: unknown,
  defaults: BoundDefaults,
  update?: (value: unknown) => void,
  nativeProperty = false,
  accepted = true,
): (() => void) | undefined {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return undefined;
  const hadBoundValue = boundValues.has(element);
  const previous = boundValues.get(element);
  if (accepted) boundValues.set(element, snapshot(initial));
  const preHydration = preHydrationValues.get(element);
  if (preHydration !== undefined) {
    writeControl(element, name, nativeProperty ? name === "checked" ? preHydration.checked : preHydration.value : preHydration.bound, nativeProperty);
    preHydrationValues.delete(element);
  } else if (accepted && (!hadBoundValue || !sameValue(previous, initial))) writeControl(element, name, initial, nativeProperty);
  restoreDefault(element, name, defaults);
  // A render can detach and reattach a callback ref to this same control. Keep its last model
  // in the WeakMap so reattachment can distinguish a model change from a native user edit.
  if (update === undefined) return undefined;
  const eventName = element instanceof HTMLSelectElement || element instanceof HTMLInputElement &&
    ["checkbox", "radio", "file"].includes(element.type) ? "change" : "input";
  const listener = () => {
    if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked) return;
    update(readControl(element));
  };
  element.addEventListener(eventName, listener);
  return () => { element.removeEventListener(eventName, listener); };
}

/** A same-model re-render must not reset an edited control or its dirty-value flag. */
export function syncBoundControl(element: Element | null, name: BoundName, value: unknown, defaults: BoundDefaults, nativeProperty = false, accepted = true): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
  if (!accepted) return;
  const previous = boundValues.get(element);
  if (!sameValue(previous, value)) {
    writeControl(element, name, value, nativeProperty);
    boundValues.set(element, snapshot(value));
  }
  restoreDefault(element, name, defaults);
}

/** Clone the state containers along a writable path so React observes nested native edits. */
export function writeBoundPath<T>(root: T, path: readonly (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  if (path.some((segment) => typeof segment !== "string" && typeof segment !== "number")) return root;
  if (root === null || typeof root !== "object") return root;
  const result = Array.isArray(root) ? root.slice() : { ...root };
  let source = root as Record<string | number, unknown>;
  let target = result as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = source[key];
    if (next === null || typeof next !== "object") return root;
    const copy = Array.isArray(next) ? next.slice() : { ...next };
    target[key] = copy;
    source = next as Record<string | number, unknown>;
    target = copy as Record<string | number, unknown>;
  }
  target[path[path.length - 1]!] = value;
  return result as T;
}
`;

export function reactControlArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "react/control.ts", content: `// Generated by HTML Next ${version}. Do not edit.\n${SOURCE}` });
}
