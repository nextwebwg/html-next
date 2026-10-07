/** Native control bindings and state preservation during Vue hydration. */
export const VUE_CONTROL_PATH = "vue/control.ts";
export const VUE_CONTROL_SPECIFIER = "./control";

export function importsVueControl(source: string): boolean {
  return new RegExp(`from ['"]${VUE_CONTROL_SPECIFIER}['"]`).test(source);
}

const SOURCE = `
import { cloneVNode, createVNode, defineComponent, Fragment, onMounted, onUpdated, type VNode } from "vue";

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type BoundControl = { readonly tag: "input" | "textarea" | "select"; readonly name: "value" | "checked"; readonly value: unknown; readonly nativeProperty?: boolean; readonly optionalValue?: boolean; readonly defaultValue?: string; readonly defaultChecked?: boolean };
const connectedControls = new WeakSet<Control>();
const boundValues = new WeakMap<Control, unknown>();
const selectOptions = new WeakMap<HTMLSelectElement, readonly (readonly [HTMLOptionElement, string])[]>();
const selectBindings = new WeakMap<HTMLSelectElement, BoundControl>();
const selectObservers = new WeakMap<HTMLSelectElement, MutationObserver>();

function currentOptions(element: HTMLSelectElement): readonly (readonly [HTMLOptionElement, string])[] {
  return Array.from(element.options, (option) => [option, option.value] as const);
}

function optionsChanged(element: HTMLSelectElement): boolean {
  const previous = selectOptions.get(element);
  const next = currentOptions(element);
  selectOptions.set(element, next);
  return previous !== undefined && (previous.length !== next.length || next.some(([option, value], index) =>
    previous[index]?.[0] !== option || previous[index]?.[1] !== value));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  }
  return false;
}

function snapshotValue(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

function writeBoundControl(element: Control, binding: BoundControl): void {
  const value = binding.value;
  // An absent component value leaves the browser's selection/default behavior in charge.
  if (binding.optionalValue && value === undefined) return;
  if (binding.name === "checked" && element instanceof HTMLInputElement) {
    const next = Boolean(value);
    if (element.checked !== next) element.checked = next;
  } else if (element instanceof HTMLSelectElement && element.multiple && !binding.nativeProperty) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    for (const option of Array.from(element.options)) {
      const next = selected.has(option.value);
      if (option.selected !== next) option.selected = next;
    }
  } else {
    // Keep in-progress numeric spellings such as 1e3 or 1.0 when the live control
    // already represents the bound number. Rewriting moves the caret and loses syntax.
    if (element instanceof HTMLInputElement && (element.type === "number" || element.type === "range")) {
      if (typeof value === "number" && element.valueAsNumber === value) return;
      if (value == null && element.value === "") return;
    }
    const next = binding.nativeProperty ? String(value) : value == null ? "" : String(value);
    if (element.value !== next) element.value = next;
  }
}

/** SSR must not turn a live property binding into a new native form-reset default. */
function restoreDefault(element: Control, binding: Pick<BoundControl, "name" | "defaultValue" | "defaultChecked">): void {
  if (element instanceof HTMLInputElement && binding.name === "checked") {
    const current = element.checked;
    element.checked = current;
    element.defaultChecked = binding.defaultChecked ?? false;
    element.checked = current;
  } else if (!(element instanceof HTMLSelectElement)) {
    const current = element.value;
    element.value = current;
    element.defaultValue = binding.defaultValue ?? "";
    element.value = current;
  }
}

function optionText(node: VNode): string {
  if (typeof node.children === "string") return node.children;
  if (Array.isArray(node.children)) return node.children.map((child) =>
    typeof child === "string" ? child : optionText(child as VNode)).join("");
  return "";
}

function selectChildren(nodes: unknown, selected: ReadonlySet<string>, defaults: Array<readonly [VNode, boolean]>): unknown {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((child: VNode) => {
    if (child.type === "option") {
      const value = child.props?.value ?? optionText(child).replace(/\\s+/g, " ").trim();
      const copy = cloneVNode(child, { selected: selected.has(String(value)) });
      defaults.push([copy, child.props !== null && Object.hasOwn(child.props, "selected") &&
        child.props.selected !== false && child.props.selected !== null && child.props.selected !== undefined]);
      return copy;
    }
    if (child.type === "optgroup" || child.type === Fragment) {
      const copy = cloneVNode(child);
      copy.children = selectChildren(child.children, selected, defaults) as VNode[];
      return copy;
    }
    return child;
  });
}

/** Render options through Vue VNodes so slotted options receive SSR selection too. */
export const SelectedOptions = defineComponent({
  name: "SelectedOptions",
  props: { value: { type: null }, multiple: Boolean, nativeProperty: Boolean, optionalValue: Boolean },
  setup(props, { slots }) {
    let defaults: Array<readonly [VNode, boolean]> = [];
    const restoreDefaults = () => {
      const options = defaults.flatMap(([node, original]) =>
        node.el instanceof HTMLOptionElement ? [{ option: node.el, original, selected: node.el.selected }] : []);
      for (const { option, original } of options) option.defaultSelected = original;
      // Setting one default can change another option's live selection in a single select.
      // Restore the full pre-default selection only after every authored default is in place.
      for (const { option, selected } of options) if (!selected) option.selected = false;
      for (const { option, selected } of options) if (selected) option.selected = true;
    };
    onMounted(restoreDefaults);
    onUpdated(restoreDefaults);
    return () => {
      if (props.optionalValue && props.value === undefined) {
        defaults = [];
        return createVNode(Fragment, null, slots.default?.() ?? []);
      }
      const values = props.nativeProperty ? [String(props.value)] : props.multiple
        ? Array.isArray(props.value) ? props.value.map(String) : []
        : [props.value == null ? "" : String(props.value)];
      defaults = [];
      return createVNode(Fragment, null, selectChildren(slots.default?.() ?? [], new Set(values), defaults) as VNode[]);
    };
  },
});

/** Vue reactivity drives this directive; native controls own their edited value until state changes. */
export const vBindControl = {
  deep: true,
  getSSRProps(binding: { value: BoundControl }): Record<string, unknown> | undefined {
    const { tag, name, value, nativeProperty, optionalValue } = binding.value;
    if (optionalValue && value === undefined) return undefined;
    if (name === "checked") return { checked: Boolean(value) };
    if (tag === "input" || tag === "textarea") {
      return { value: nativeProperty ? String(value) : value == null ? "" : String(value) };
    }
    return undefined;
  },
  created(element: Control): void {
    if (element.isConnected) connectedControls.add(element);
  },
  mounted(element: Control, binding: { value: BoundControl }): void {
    boundValues.set(element, snapshotValue(binding.value.value));
    if (!connectedControls.has(element)) writeBoundControl(element, binding.value);
    restoreDefault(element, binding.value);
    connectedControls.delete(element);
    if (element instanceof HTMLSelectElement) {
      selectBindings.set(element, binding.value);
      selectOptions.set(element, currentOptions(element));
      const observer = new MutationObserver(() => {
        const current = selectBindings.get(element);
        if (current !== undefined && optionsChanged(element)) writeBoundControl(element, current);
      });
      observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["value"] });
      selectObservers.set(element, observer);
    }
  },
  updated(element: Control, binding: { value: BoundControl }): void {
    const previous = boundValues.get(element);
    if (element instanceof HTMLSelectElement) selectBindings.set(element, binding.value);
    if (!sameValue(previous, binding.value.value)) {
      writeBoundControl(element, binding.value);
      boundValues.set(element, snapshotValue(binding.value.value));
    }
  },
  beforeUnmount(element: Control): void {
    boundValues.delete(element);
    connectedControls.delete(element);
    if (element instanceof HTMLSelectElement) {
      selectOptions.delete(element);
      selectBindings.delete(element);
      selectObservers.get(element)?.disconnect();
      selectObservers.delete(element);
    }
  },
};

export function readBoundControl(element: Control): unknown {
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

`;

export function vueControlModule(version: string): string {
  return `// Generated by HTML Next ${version}. Do not edit.\n${SOURCE.trim()}\n`;
}
