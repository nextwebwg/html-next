import type { GeneratedArtifact } from "../generate.js";

const SOURCE = `type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type BoundName = "value" | "checked";
export interface BoundDefaults {
  readonly value?: string;
  readonly checked?: boolean;
  readonly options?: readonly boolean[];
}

interface HydrationSnapshot {
  readonly bound: unknown;
  readonly value: string;
  readonly checked: boolean;
  prepared: boolean;
}
const boundValues = new WeakMap<Control, unknown>();
const preHydrationValues = new WeakMap<Control, HydrationSnapshot>();

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

// This module runs before framework hydration. Retain native edits before the framework
// claims controls or replaces a textarea's live value.
if (typeof document !== "undefined") captureHydrationControls(document);

/** Called before a generated subtree claims controls that arrived after its helpers loaded. */
export function captureHydrationControls(root: ParentNode, preparing = false): void {
  const pending: HydrationSnapshot[] = [];
  for (const element of root.querySelectorAll("input, textarea, select")) {
    if (boundValues.has(element as Control) || preHydrationValues.get(element as Control)?.prepared === true) continue;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const captured = {
        bound: snapshot(readControl(element)),
        value: element.value,
        checked: element instanceof HTMLInputElement && element.checked,
        prepared: preparing,
      };
      preHydrationValues.set(element, captured);
      if (preparing) pending.push(captured);
    }
  }
  // Independent roots may claim DOM before either root's control attachments run.
  // Keep that batch's snapshots intact; later hydration can capture fresh native edits.
  if (pending.length > 0) queueMicrotask(() => { for (const captured of pending) captured.prepared = false; });
}

function writeControl(element: Control, name: BoundName, value: unknown, nativeProperty: boolean): void {
  if (name === "checked" && element instanceof HTMLInputElement) {
    const next = nativeProperty ? Boolean(value)
      : Array.isArray(value) ? value.length > 0
      : value instanceof Error ? true
      : value !== null && typeof value === "object" ? Object.keys(value).length > 0
      : Boolean(value);
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
    if (element.value !== current) element.value = current;
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
export function syncBoundControl(element: Element | null, name: BoundName, value: unknown, defaults: BoundDefaults, nativeProperty = false, accepted = true, force = false): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
  if (!accepted) return;
  const previous = boundValues.get(element);
  if (force || !sameValue(previous, value)) {
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
  const leaf = path[path.length - 1]!;
  if (Object.is(source[leaf], value)) return root;
  target[leaf] = value;
  return result as T;
}
`;

/** Native setters, input reads, reset defaults and hydration capture shared by target attachments. */
export function nativeControlModule(version: string): string {
  return `// Generated by HTML Next ${version}. Do not edit.\n${SOURCE}`;
}

export function reactControlArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "react/control.ts", content: nativeControlModule(version) });
}
