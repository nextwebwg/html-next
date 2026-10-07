/** Native lifecycle and prop wiring shared by ahead-of-time generated components. */

import { fail } from "./diagnostics.js";
import { manageGeneratedLifecycle } from "./generated-lifecycle.js";
import { manageIndexedLifecycle } from "./generated-lifecycle-index.js";
import { ABSENT, NONCONFORMING, toAttribute, toText, truthy, type Value } from "./expression.js";
import { isNativeEvent } from "./freeze.js";
import { NESTED, raw, RAW } from "./keyed.js";
import { applyBoundControlValue, controlValue } from "./controls.js";
import { stateAttributeValue } from "./component-styles.js";
import { hasExecutableUrl, markContentOnly, sanitizeFragment } from "./sanitize.js";
import {
  createComputed,
  createEffect,
  createSignal,
  notifyPropertyDelete,
  notifyPropertySet,
  ReactiveEffect,
  ReactiveScheduler,
  trackProperty,
  untracked,
  type ReactiveOwner,
} from "./reactivity.js";
import { parseTypedValue, parseTypeExpression, type TypeNode } from "./type-system.js";
import { selectedPropType } from "./contract.js";
import { kebabCase } from "./names.js";
import { assignedPropValue, invocationValue, reflectedPropValue } from "./prop-values.js";
import type { ComponentContract, PropContract, PropType } from "./types.js";
import { validateComponentProps } from "./validate.js";
import { manageElementValidity, setElementValidity, validityState } from "./validity.js";

export { ABSENT, binaryValue, formatCall, mathCall, negate, NONCONFORMING, textCall, toAttribute, toText, truthy } from "./expression.js";
export { manageGeneratedLifecycle } from "./generated-lifecycle.js";
export { dispose, IndexedList, KeyedList, PositionalList } from "./keyed.js";
export { visitSelected } from "./selection.js";

export interface GeneratedEvent {
  readonly name: string;
  readonly type: string;
  readonly detail: unknown;
  readonly bubbles: boolean;
  readonly composed: boolean;
  readonly cancelable: boolean;
}

/** A declared event's detail check (or 0 for an untyped event) and its bubbles, composed and cancelable flags. */
export type GeneratedEventDeclaration = readonly [check: ((detail: unknown) => boolean) | 0, bubbles: boolean, composed: boolean, cancelable: boolean];

/** An undeclared event: bubbling, composed and not cancelable, as the live host dispatches one. */
const dispatchUndeclared = (target: Element | readonly Element[], name: string, detail: unknown): boolean =>
  (target as Element).dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false }));

/** The detail check of a typed event; only modules that declare one import it, and with it the type system. */
export const detailCheck = (type: TypeNode) => (detail: unknown): boolean => parseTypedValue(detail, type, "$", "value").ok;

/**
 * Dispatches a component event as the live runtime does: a declared event checks its detail
 * (HR002) and uses its declared flags; an undeclared one bubbles, is composed and not cancelable.
 * Several targets each receive their own event while connected.
 */
export function dispatchDeclared(
  target: Element | readonly Element[],
  name: string,
  detail: unknown,
  declaration: GeneratedEventDeclaration | undefined,
): boolean {
  if (declaration !== undefined && declaration[0] !== 0 && detail !== undefined && !declaration[0](detail)) {
    fail("HR002", `Event \`${name}\` detail does not satisfy its declared type.`);
  }
  const init = { detail, bubbles: declaration?.[1] ?? true, composed: declaration?.[2] ?? true, cancelable: declaration?.[3] ?? false };
  if (!Array.isArray(target)) return (target as Element).dispatchEvent(new CustomEvent(name, init));
  let accepted = true;
  for (const element of target as readonly Element[]) {
    if (element.isConnected && !element.dispatchEvent(new CustomEvent(name, init))) accepted = false;
  }
  return accepted;
}

/** A handler's dispatch to `$ref` targets: connected ones, in document order. */
export function refTargets(recorded: unknown): Element[] {
  return (Array.isArray(recorded) ? [...recorded as Element[]] : recorded === undefined ? [] : [recorded as Element])
    .filter((target) => target.isConnected)
    .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
}

/** A computed that reads itself while it computes (live `HR006`). */
export function computedCycle(): never {
  fail("HR006", "A reactive computed value depends on itself.");
}

/** A root read: an undefined value fails as the interpreter's undeclared read does (HB001). */
export function rootValue(value: unknown, name: string): unknown {
  if (value === undefined) fail("HB001", `\`${name}\` is not declared in scope.`);
  return value;
}

/** Validates and dispatches an event emitted by target-native generated code. */
export function dispatchGeneratedEvent(target: EventTarget | null | undefined, event: GeneratedEvent): boolean {
  if (event.detail !== undefined) {
    const parsed = parseTypedValue(event.detail, parseTypeExpression(event.type));
    if (!parsed.ok) fail("HR002", `Event \`${event.name}\` detail does not satisfy its declared type.`);
  }
  return target?.dispatchEvent(new CustomEvent(event.name, {
    detail: event.detail,
    bubbles: event.bubbles,
    composed: event.composed,
    cancelable: event.cancelable,
  })) ?? false;
}

export type GeneratedPropType = "string" | "boolean" | "number" | readonly string[];

export interface GeneratedProp {
  readonly name: string;
  /** The `data-<name>` attribute that records an explicit value on the root. */
  readonly attribute: string;
  /** The value the author or framework supplied; `undefined` when the prop was not set. */
  readonly value: unknown;
  /** The declared default, used for rendering but never reflected. */
  readonly default?: unknown;
  /**
   * The template itself binds this attribute on the root, so it is template output and always shows
   * the effective value (defaults included). Otherwise it only records explicit values.
   */
  readonly bound?: boolean;
  readonly type: GeneratedPropType;
  readonly required: boolean;
}

const generatedPropUpdaters = new WeakMap<Element, (props: Readonly<Record<string, unknown>>) => void>();

interface ChoiceIssue { readonly path: string; readonly message: string; readonly reason: "valueMissing" | "typeMismatch" }

function managedChoiceValidity(element: Element, issues: () => readonly ChoiceIssue[]): { refresh(): void; stop(): void } {
  const target = element as Element & { validity?: ValidityState; validationMessage?: string; checkValidity?: () => boolean; reportValidity?: () => boolean; setCustomValidity?: (message: string) => void };
  const ownValidity = !('validity' in target);
  const ownCheck = !('checkValidity' in target);
  const ownMessage = !('validationMessage' in target);
  const ownReport = !('reportValidity' in target);
  let failures: readonly ChoiceIssue[] = [];
  let mirroredAria = false;
  if (ownValidity) Object.defineProperty(target, "validity", { configurable: true, get: () => ({
    valid: failures.length === 0,
    valueMissing: failures.some((failure) => failure.reason === "valueMissing"),
    typeMismatch: failures.some((failure) => failure.reason === "typeMismatch"),
    patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false,
    rangeOverflow: false, stepMismatch: false, badInput: false, customError: false,
    errors: failures,
  }) });
  if (ownCheck) Object.defineProperty(target, "checkValidity", { configurable: true, value: () => failures.length === 0 });
  if (ownMessage) Object.defineProperty(target, "validationMessage", { configurable: true, get: () => failures[0]?.message ?? "" });
  if (ownReport) Object.defineProperty(target, "reportValidity", { configurable: true, value: () => failures.length === 0 });
  const refresh = (): void => {
    failures = issues();
    target.setCustomValidity?.(failures[0]?.message ?? "");
    if (!('setCustomValidity' in target)) {
      if (failures.length > 0) {
        element.setAttribute("data-invalid", "");
        element.removeAttribute("data-valid");
      } else {
        element.removeAttribute("data-invalid");
        element.setAttribute("data-valid", "");
      }
      if (failures.length > 0 && (!element.hasAttribute("aria-invalid") || mirroredAria)) {
        element.setAttribute("aria-invalid", "true");
        mirroredAria = true;
      } else if (failures.length === 0 && mirroredAria) {
        element.removeAttribute("aria-invalid");
        mirroredAria = false;
      }
    }
  };
  return { refresh, stop: () => {
    target.setCustomValidity?.("");
    if (ownValidity) delete target.validity;
    if (ownCheck) delete target.checkValidity;
    if (ownMessage) delete target.validationMessage;
    if (ownReport) delete target.reportValidity;
    element.removeAttribute("data-invalid");
    element.removeAttribute("data-valid");
    if (mirroredAria) element.removeAttribute("aria-invalid");
  } };
}

function propValue(input: unknown, type: GeneratedPropType): unknown {
  if (type === "string" && typeof input === "string") return input;
  if (type === "boolean" && typeof input === "boolean") return input;
  if (type === "number" && typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(type) && typeof input === "string") return input;
  return input;
}

function generatedPropIssues(prop: GeneratedProp, value: unknown): readonly ChoiceIssue[] {
  if (value === null || value === undefined || value === "") {
    return prop.required ? [{ path: prop.name, reason: "valueMissing", message: `\`${prop.name}\` is required.` }] : [];
  }
  const type = prop.type;
  const valid = type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === "string" && (type as readonly string[]).includes(value);
  return valid ? [] : [{ path: prop.name, reason: "typeMismatch", message: `Value does not satisfy \`${prop.name}\`.` }];
}

function assignedGeneratedProp(
  prop: GeneratedProp,
  input: unknown,
): unknown {
  if (input === null) {
    return null;
  }
  if (input !== undefined) return propValue(input, prop.type);
  return undefined;
}

/**
 * Installs the scalar prop boundary used by a directly compiled component. Explicit values are
 * reflected as `data-<name>` (defaults never are); that record is output, never read back. No
 * JavaScript properties are added to the element.
 */
export function manageGeneratedProps(
  element: Element,
  props: readonly GeneratedProp[],
  apply?: (name: string, value: unknown) => void,
): () => void {
  // `explicit` holds the supplied value (or undefined); `effective` adds the declared default.
  const explicit = props.map((prop) => assignedGeneratedProp(prop, prop.value));
  const effective = (index: number): unknown => explicit[index] === undefined
    ? (props[index]!.default ?? null) : explicit[index];
  const validity = props.length > 0
    ? managedChoiceValidity(element, () => props.flatMap((prop, index) => generatedPropIssues(prop, effective(index))))
    : undefined;
  const byName = new Map(props.map((prop, index) => [prop.name, index]));
  const dirty = new Set(props.map((_, index) => index));
  let connected = false;
  let pending = false;

  const flush = (): void => {
    pending = false;
    if (!connected) return;
    for (const index of dirty) {
      const prop = props[index]!;
      const value = prop.bound ? effective(index) : explicit[index];
      const serialized = value === undefined || value === null ? null : String(value);
      if (serialized === null) element.removeAttribute(prop.attribute);
      else element.setAttribute(prop.attribute, serialized);
      apply?.(prop.name, effective(index));
    }
    dirty.clear();
    validity?.refresh();
  };
  const schedule = (index: number): void => {
    dirty.add(index);
    if (connected && !pending) {
      pending = true;
      queueMicrotask(flush);
    }
  };
  generatedPropUpdaters.set(element, (next) => {
    for (const [name, input] of Object.entries(next)) {
      const index = byName.get(name);
      if (index === undefined) continue;
      const value = assignedGeneratedProp(props[index]!, input);
      if (Object.is(explicit[index], value)) continue;
      explicit[index] = value;
      schedule(index);
    }
  });

  const stopLifecycle = manageGeneratedLifecycle(
    element,
    () => {
      connected = true;
      for (let index = 0; index < props.length; index += 1) dirty.add(index);
      flush();
    },
    () => {
      connected = false;
    },
  );
  return () => { stopLifecycle(); validity?.stop(); };
}

/** A compact equivalent of manageGeneratedProps for generated components with exactly one scalar prop. */
export function manageGeneratedProp(
  element: Element,
  prop: GeneratedProp,
  apply?: (value: unknown) => void,
): () => void {
  let explicit = assignedGeneratedProp(prop, prop.value);
  let dirty = true;
  let connected = false;
  let pending = false;
  const effective = (): unknown => explicit === undefined ? (prop.default ?? null) : explicit;
  const validity = managedChoiceValidity(element, () => generatedPropIssues(prop, effective()));
  const flush = (): void => {
    pending = false;
    if (!connected || !dirty) return;
    dirty = false;
    const value = prop.bound ? effective() : explicit;
    const serialized = value === undefined || value === null ? null : String(value);
    if (serialized === null) element.removeAttribute(prop.attribute);
    else element.setAttribute(prop.attribute, serialized);
    apply?.(effective());
    validity?.refresh();
  };
  const schedule = (): void => {
    dirty = true;
    if (connected && !pending) {
      pending = true;
      queueMicrotask(flush);
    }
  };
  generatedPropUpdaters.set(element, (next) => {
    if (!Object.hasOwn(next, prop.name)) return;
    const value = assignedGeneratedProp(prop, next[prop.name]);
    if (!Object.is(explicit, value)) {
      explicit = value;
      schedule();
    }
  });
  const stopLifecycle = manageGeneratedLifecycle(
    element,
    () => {
      connected = true;
      dirty = true;
      flush();
    },
    () => { connected = false; },
  );
  return () => { stopLifecycle(); validity?.stop(); };
}

/** The framework-adapter prop channel for directly compiled components; not a page-authoring API. */
export function updateGeneratedProps(element: Element, props: Readonly<Record<string, unknown>>): void {
  generatedPropUpdaters.get(element)?.(props);
}

interface PropInput { readonly value: unknown; readonly source: "html" | "value"; readonly present: boolean }

/** `host.props[name]`, as the live host gives it. */
interface GeneratedPropHandle {
  readonly value: unknown;
  readonly inputValue: unknown;
  readonly validity: ReturnType<typeof validityState>;
  validate(): ReturnType<typeof validityState>;
}

/** A compiled instance's props, as the live runtime keeps an instance's. */
export interface GeneratedPropRecord {
  readonly D: Pick<ComponentContract, "props">;
  /** The state and computed names; each prop's root follows them, in the contract's order. */
  readonly n: readonly string[];
  readonly v: unknown[];
  /** The latest input of each prop, and the props an input made explicit. */
  readonly i: Record<string, PropInput>;
  readonly x: Set<string>;
  /** Props the root template binds as `data-<name>` itself, so that attribute is its output. */
  readonly b: readonly string[];
  /** The props' validity, as the root reports it. */
  readonly y: () => ReturnType<typeof validateComponentProps>;
  /** `host.props`. */
  readonly h: Readonly<Record<string, GeneratedPropHandle>>;
}

/**
 * Accepts a compiled component's props from its factory, as the live runtime accepts a factory's:
 * explicit inputs are recorded as `data-<name>` first, then every prop the root's attributes or the
 * factory supplies is parsed through its type, and an input that does not parse leaves the default.
 * Fills each prop's root in `v`; `manageProps` takes over once the instance is attached.
 */
export function acceptProps(
  element: Element, D: Pick<ComponentContract, "props">, n: readonly string[], v: unknown[],
  input: Readonly<Record<string, unknown>>, bound: readonly string[],
): GeneratedPropRecord {
  const props = D.props;
  const names = Object.keys(props);
  for (const name of names) {
    const prop = props[name]!;
    const value = input[name];
    if (value === undefined || value === null || prop.select !== undefined && props[prop.select.from] === undefined) continue;
    element.setAttribute(`data-${kebabCase(name)}`, reflectedPropValue(value, selectedPropType(D as ComponentContract, prop, input)));
  }
  // The root's `data-<name>` attributes are read back as HTML input, and the factory's values win.
  const incoming: Record<string, PropInput> = Object.create(null);
  for (const attribute of Array.from(element.attributes)) {
    const name = names.find((candidate) => attribute.name === `data-${kebabCase(candidate)}` || attribute.name === `data-${candidate.toLowerCase()}`);
    if (name !== undefined) incoming[name] = { value: attribute.value, source: "html", present: true };
  }
  for (const name of names) if (input[name] !== undefined) incoming[name] = { value: input[name], source: "value", present: true };
  const accepted: Record<string, unknown> = {};
  const at = (name: string): number => names.includes(name) ? n.length + names.indexOf(name) : n.indexOf(name);
  for (const pass of [false, true]) {
    for (const name of names) {
      const prop = props[name]!;
      const item = incoming[name];
      if (item === undefined || (prop.select !== undefined) !== pass) continue;
      // A selector that is state chooses with its initial value.
      const from = prop.select?.from;
      accepted[name] = invocationValue(prop, item.value, item.source, false, selectedPropType(D as ComponentContract, prop,
        from === undefined || props[from] !== undefined ? accepted : { [from]: v[at(from)] }));
    }
  }
  for (const name of names) {
    const prop = props[name]!;
    v[at(name)] = accepted[name] !== undefined ? accepted[name] : prop.default === undefined ? null : prop.default;
  }
  const inputs: Record<string, PropInput> = Object.create(null);
  for (const name of names) inputs[name] = incoming[name] ?? { value: null, source: "value", present: false };
  const record: GeneratedPropRecord = {
    D, n, v, i: inputs, b: bound,
    x: new Set(names.filter((name) => incoming[name] !== undefined && incoming[name]!.value !== null)),
    // Reads every prop's input and value, as live's validity does, so an effect reading it tracks them all.
    y: () => validateComponentProps(D as ComponentContract,
      (name) => {
        trackProperty(inputs, name);
        if (inputs[name]?.present) return inputs[name]!.value;
        trackProperty(record, name);
        return v[at(name)];
      },
      (name) => (trackProperty(record, name), v[at(name)]),
      (name) => inputs[name]?.source ?? "value"),
    h: Object.freeze(Object.fromEntries(names.map((name) => {
      const validity = (): ReturnType<typeof validityState> => {
        const errors = record.y().errors.filter((error) => error.path === name);
        return validityState(errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors });
      };
      return [name, Object.freeze({
        get value() { trackProperty(record, name); return v[at(name)]; },
        get inputValue() { trackProperty(inputs, name); return inputs[name]!.value; },
        get validity() { return validity(); },
        validate: validity,
      })];
    }))),
  };
  return record;
}

/**
 * The live runtime's prop boundary for an attached compiled instance: on first connect the root
 * takes its validity and bound props their reflection; a reconnect reflects every explicit or bound
 * prop again; and the framework channel (`updateGeneratedProps`) applies inputs as
 * `updateComponentProps` does, recording the raw input and re-rendering what an accepted value changed.
 */
export function manageProps(instance: GeneratedInstance, element: Element): void {
  const record = instance.B!;
  const { D, n, v, i: inputs, x: explicit, b: bound } = record;
  const props = D.props;
  const names = Object.keys(props);
  const at = (name: string): number => names.includes(name) ? n.length + names.indexOf(name) : n.indexOf(name);
  const changed = new Set<string>();
  let connected = false;
  let installed = false;
  const selected = (prop: PropContract, values: Readonly<Record<string, unknown>>): PropType | null =>
    selectedPropType(D as ComponentContract, prop, values);
  const reflect = (name: string): void => {
    const prop = props[name]!;
    if (!bound.includes(name) && !explicit.has(name)) return;
    const value = v[at(name)];
    // Null is "no value" at the attribute boundary: it removes the attribute.
    const text = value === undefined || value === ABSENT || value === null ? null
      : reflectedPropValue(value, selected(prop, prop.select === undefined ? {} : { [prop.select.from]: v[at(prop.select.from)] }));
    if (text === null) element.removeAttribute(`data-${kebabCase(name)}`);
    else element.setAttribute(`data-${kebabCase(name)}`, text);
  };
  const job = new ReactiveEffect(instance.q, () => {
    if (!connected) return;
    for (const name of changed) reflect(name);
    changed.clear();
    setElementValidity(element, record.y());
  }, 2);
  instance.o.push({
    pause: () => { connected = false; },
    resume: () => {
      connected = true;
      changed.clear();
      if (installed) {
        for (const name of names) reflect(name);
        setElementValidity(element, record.y());
        return;
      }
      installed = true;
      manageElementValidity(element, {}, { derive: record.y });
      for (const name of bound) reflect(name);
      job.schedule();
    },
    stop: () => job.stop(),
  });
  generatedPropUpdaters.set(element, (input) => {
    const next: Record<string, unknown> = {};
    for (const name of names) {
      next[name] = v[at(name)];
      const from = props[name]!.select?.from;
      if (from !== undefined && props[from] === undefined) next[from] = v[at(from)];
    }
    for (const pass of [false, true]) {
      for (const [name, value] of Object.entries(input)) {
        const prop = props[name];
        if (prop === undefined || (prop.select !== undefined) !== pass) continue;
        const accepted = assignedPropValue(prop, value, selected(prop, next));
        if (accepted !== undefined) next[name] = accepted;
      }
    }
    for (const [name, value] of Object.entries(input)) {
      const prop = props[name];
      if (prop === undefined) continue;
      const previous = inputs[name];
      inputs[name] = { value: value === undefined ? null : value, source: "value", present: value !== undefined };
      notifyPropertySet(inputs, name, previous, inputs[name], undefined);
      // A bound data-* attribute is template output; only its binding writes it.
      const attribute = `data-${kebabCase(name)}`;
      if (value === undefined || value === null) {
        explicit.delete(name);
        if (!bound.includes(name)) element.removeAttribute(attribute);
      } else {
        explicit.add(name);
        if (!bound.includes(name)) element.setAttribute(attribute, reflectedPropValue(value, selected(prop, next)));
      }
      const index = at(name);
      const current = v[index];
      if (!Object.is(current, next[name])) {
        instance.w(index, next[name]);
        notifyPropertySet(record, name, current, next[name], undefined);
        changed.add(name);
        for (const other of names) if (props[other]!.select?.from === name) changed.add(other);
      }
    }
    job.schedule();
  });
}

/**
 * A prototype for cloning: `[tag, [name, value, ...], ...children]`, where an empty tag is a
 * fragment, a string is text, 0 is an empty Text a `$value` writes, 1 is a `$if` anchor pair and
 * 2 is a `$each` anchor pair.
 */
export type TemplateSpec = readonly [tag: string, attributes: readonly string[], ...children: readonly unknown[]];
type TemplateChild = string | 0 | 1 | 2 | 3 | TemplateSpec;

const SVG = "http://www.w3.org/2000/svg";

/**
 * Builds a prototype once with createElement/setAttribute: no HTML parser or sink. Elements take
 * the namespace their position implies, as the live runtime creates them: `<svg>` and its
 * descendants are SVG, and `<foreignObject>`'s children are HTML again.
 */
export function buildTemplate(spec: TemplateSpec, doc: Document = document, svg?: number): Node {
  const inSvg = svg === 1 || spec[0] === "svg";
  const node = spec[0] === "" ? doc.createDocumentFragment() : inSvg ? doc.createElementNS(SVG, spec[0]) : doc.createElement(spec[0]);
  const attributes = spec[1];
  for (let index = 0; index < attributes.length; index += 2) {
    (node as Element).setAttribute(attributes[index]!, attributes[index + 1]!);
  }
  for (let index = 2; index < spec.length; index += 1) {
    const child = spec[index] as TemplateChild;
    if (typeof child === "object") node.append(buildTemplate(child, doc, inSvg && spec[0] !== "foreignObject" ? 1 : 0));
    else if (typeof child === "string" || child === 0) node.append(doc.createTextNode(child === 0 ? "" : child));
    else {
      const prefix = child === 2 ? "html-next:each-" : child === 3 ? "html-next:html-" : "html-next:";
      node.append(doc.createComment(`${prefix}start`), doc.createComment(`${prefix}end`));
    }
  }
  return node;
}

/** The expression interpreter's member read, over raw values; object results are canonical raw objects. */
export const readMember = (object: unknown, key: string): unknown =>
  key === "length" && (Array.isArray(object) || typeof object === "string") ? (object as { length: number }).length
    : object === null || typeof object !== "object" || Array.isArray(object) ? ABSENT
    : (object = (object as Record<string, unknown>)[key]) === undefined ? ABSENT : raw(object);

/** The interpreter's index read (`list[n]`, `record[key]`) over raw values. */
export function readIndex(object: unknown, index: unknown): unknown {
  if (object === NONCONFORMING || index === NONCONFORMING) return NONCONFORMING;
  if (object === ABSENT || object === null || index === ABSENT || index === null) return ABSENT;
  let value: unknown;
  if (Array.isArray(object) && typeof index === "number") value = object[index];
  else if (typeof object === "object" && (typeof index === "string" || typeof index === "number")) {
    value = (object as Record<string, unknown>)[String(index)];
  } else return ABSENT;
  return value === undefined ? ABSENT : raw(value);
}

/** A member read whose object may be nonconforming, which then stays nonconforming. */
export const readFailing = (object: unknown, key: string): unknown =>
  object === NONCONFORMING ? object : readMember(object, key);

/** `not`, truthiness, `and`/`or`, `? :` and `default` over evaluated operands that may be nonconforming. */
export const notValue = (value: unknown): unknown => value === NONCONFORMING ? value : !truthy(value as Value);
export const truthyValue = (value: unknown): unknown => value === NONCONFORMING ? value : truthy(value as Value);
export const logicValue = (and: boolean, left: unknown, right: unknown): unknown =>
  left === NONCONFORMING ? left : truthy(left as Value) !== and ? !and
    : right === NONCONFORMING ? right : truthy(right as Value);
export const chooseValue = (test: unknown, consequent: unknown, alternate: unknown): unknown =>
  test === NONCONFORMING ? test : truthy(test as Value) ? consequent : alternate;
export const defaultValue = (value: unknown, fallback: unknown): unknown =>
  value === NONCONFORMING ? value : value === ABSENT || value === null ? fallback : value;

/** A list or object literal whose items may be nonconforming. */
export const listValue = (items: unknown[]): unknown => items.includes(NONCONFORMING) ? NONCONFORMING : items;
export function recordValue(keys: readonly string[], values: readonly unknown[]): unknown {
  if (values.includes(NONCONFORMING)) return NONCONFORMING;
  const record: Record<string, unknown> = {};
  keys.forEach((key, index) => { record[key] = values[index]; });
  return record;
}

/**
 * The `$each` modifiers over a list's items, as live `shapeList` applies them: `$where` keeps
 * truthy items, `$sort` orders by each key (numbers numerically, anything else by its text,
 * `-` descending), and `$limit` keeps that many when it is a number.
 */
export function shapeItems(
  items: unknown, where: ((item: unknown) => unknown) | 0,
  sort: readonly (readonly [read: (item: unknown) => unknown, descending: boolean])[], limit: unknown,
): unknown[] {
  let result = Array.isArray(items) ? [...items as unknown[]] : [];
  if (where !== 0) result = result.filter((item) => truthy(where(raw(item)) as Value));
  if (sort.length > 0) {
    const compare = (a: unknown, b: unknown): number =>
      typeof a === "number" && typeof b === "number" ? a - b : toText(a as Value).localeCompare(toText(b as Value));
    const value = (item: unknown, read: (item: unknown) => unknown): unknown =>
      item !== null && typeof item === "object" && !Array.isArray(item) ? read(item) : item;
    result.sort((a, b) => {
      for (const [read, descending] of sort) {
        const order = compare(value(raw(a), read), value(raw(b), read));
        if (order !== 0) return descending ? -order : order;
      }
      return 0;
    });
  }
  if (typeof limit === "number") result = result.slice(0, Math.max(0, Math.trunc(limit)));
  return result;
}

/** A row's `loop` record, made afresh for each read as live makes one per update. */
export const loopRecord = (row: { j?: number; l?: number }): Record<string, unknown> =>
  ({ index: row.j, first: row.j === 0, last: row.j === row.l! - 1, count: row.l });

/** Flags a row whose binding converts a list or object (see `KeyedRow.w`); returns the value. */
export const trackContainer = (row: { w?: number }, value: unknown): unknown => {
  if (value !== null && typeof value === "object") row.w = 1;
  return value;
};

/** Writes `$value` text: the sole Text child's data, or `textContent` for "" and foreign content (decision 2b). */
export function writeText(element: Element, text: string): void {
  const node = element.firstChild;
  if (text !== "" && node !== null && node.nodeType === 3 && node.nextSibling === null) (node as Text).data = text;
  else element.textContent = text;
}

/** Writes a converted attribute value; null removes it. */
export function writeAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** Writes a URL attribute as the live runtime does: an executable URL removes it. */
export function writeUrlAttribute(element: Element, name: string, value: string | null): void {
  if (value === null || hasExecutableUrl(value)) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

/** A two-way binding's value into its control; an element that is not one gets the attribute. */
export function writeControl(element: Element, name: string, value: unknown): void {
  if (!applyBoundControlValue(element, name, value as Value)) writeUrlAttribute(element, name, toAttribute(value as Value, name));
}

/** `$html`: sanitized content replacing the element's, marked so no bundle lowers it as a component. */
export function writeHtml(element: Element, html: string): void {
  element.replaceChildren(sanitizeFragment(html, element.ownerDocument, markContentOnly));
}

/** `<template $html>`: sanitized content between its range marks (sanitized content holds no comments). */
export function writeHtmlRange(start: Comment, html: string): void {
  let end = start.nextSibling!;
  while (end.nodeType !== 8 || (end as Comment).data !== "html-next:html-end") end = end.nextSibling!;
  clearRegion(start, end as Comment);
  end.before(sanitizeFragment(html, start.ownerDocument, markContentOnly));
}

/** `data-<tag>-state` for the props and state `:host-state()` rules name, as live writes it. */
export const hostState = (names: readonly string[], values: readonly unknown[]): string =>
  stateAttributeValue(names, (name) => values[names.indexOf(name)]);

/** Records a value a non-idempotent binding read, so it re-runs only when one of them changed. */
export const rec = (reads: unknown[], value: unknown): unknown => (reads.push(value), value);
/** Records a list's length, which truthiness reads (`truthyIn`). */
export const recLength = (reads: unknown[], value: unknown): unknown =>
  (Array.isArray(value) && reads.push(value.length), value);
/** Records a container's contents, which text and formatting read item by item. */
export function recContents(reads: unknown[], value: unknown): unknown {
  if (Array.isArray(value)) reads.push(value.length, ...value);
  else if (value !== null && typeof value === "object") for (const key of Object.keys(value)) reads.push(key, (value as Record<string, unknown>)[key]);
  return value;
}
/** Whether a binding's reads differ from the last evaluation's; the first evaluation always differs. */
export function readsChanged(last: readonly unknown[] | undefined, reads: readonly unknown[]): boolean {
  if (last === undefined || last.length !== reads.length) return true;
  for (let index = 0; index < reads.length; index += 1) if (!Object.is(last[index], reads[index])) return true;
  return false;
}

/** Removes everything between two region anchors, node by node, as the live `$if` teardown does. */
export function clearRegion(start: Comment, end: Comment): void {
  let current = start.nextSibling;
  while (current !== null && current !== end) {
    const next: ChildNode | null = current.nextSibling;
    current.remove();
    current = next;
  }
}

/**
 * A declared type in generated form: 0 none, "?" unknown, "s" string, "b" boolean, "n" number,
 * "i" integer, "z" null, "a" absent, ["l", item], ["r", value], ["o", [field, type, ...], open?],
 * ["u", ...members], ["k", keyword], ["p", check, acceptsNull] for any other kind (a format, a
 * function, an event, trusted content), and ["c", base, acceptsNull] for a constrained type whose
 * base accepts null: a reference checks only the base, a null write the whole type.
 */
export type CompactType = 0 | "?" | "s" | "b" | "n" | "i" | "z" | "a" | readonly unknown[];

const acceptsNull = (type: CompactType): boolean =>
  type === "?" || type === "z" || typeof type === "object" && (
    type[0] === "u" ? type.some((member, index) => index > 0 && acceptsNull(member as CompactType))
      : (type[0] === "p" || type[0] === "c") && type[2] === true);

/** A string format's check over any value. */
export const formatOf = (format: (value: string) => boolean) => (value: unknown): boolean => typeof value === "string" && format(value);
export const isFunctionValue = (value: unknown): boolean => typeof value === "function";
export { isNativeEvent };
export {
  colorFormat, colorHexFormat, dateFormat, datetimeFormat, datetimeLocalFormat, durationFormat, emailFormat, keywordFormat,
  lengthFormat, monthFormat, percentageFormat, timeFormat, urlFormat, weekFormat,
} from "./formats.js";

const conformsAtReference = (value: unknown, type: CompactType): boolean => {
  switch (typeof type === "object" ? type[0] : type) {
    case "?": return true;
    case "s": return typeof value === "string";
    case "b": return typeof value === "boolean";
    case "n": return Number.isFinite(value);
    case "i": return Number.isInteger(value);
    case "a": return value === undefined;
    case "l": return Array.isArray(value);
    case "r":
    case "o": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "u": return (type as readonly unknown[]).some((member, index) => index > 0 && conformsAtReference(value, member as CompactType));
    case "k": return value === (type as readonly unknown[])[1];
    case "p": return ((type as readonly unknown[])[1] as (value: unknown) => boolean)(value);
    case "c": return conformsAtReference(value, (type as readonly unknown[])[1] as CompactType);
  }
  return false;
};

/**
 * A declared reference's check (`evalConforming`): a missing value or null always passes, and
 * anything else must satisfy the reference's own type, not its subtree.
 */
export const referenceConforms = (value: unknown, type: CompactType): boolean =>
  value === ABSENT || value === null || conformsAtReference(value, type);

/** @internal The destination check (`conformsAtDestination`) on a compact type. */
export const conforms = (value: unknown, type: CompactType): boolean =>
  type === 0 || (value === null ? acceptsNull(type) : conformsAtReference(value, type));

/** @internal The declared type one step into `type` (`typeAtKey`); 0 when nothing describes it. */
export function compactTypeAt(type: CompactType, key: PropertyKey): CompactType {
  if (typeof type !== "object") return 0;
  switch (type[0]) {
    case "l": {
      if (typeof key !== "string" || key === "") return 0;
      for (let index = 0; index < key.length; index += 1) {
        const code = key.charCodeAt(index);
        if (code < 48 || code > 57) return 0;
      }
      return type[1] as CompactType;
    }
    case "r": return type[1] as CompactType;
    case "o": {
      const fields = type[1] as readonly unknown[];
      const name = String(key);
      for (let index = 0; index < fields.length; index += 2) if (fields[index] === name) return fields[index + 1] as CompactType;
      return type[2] === 1 ? 0 : "a";
    }
    case "u": {
      // One describing member (a nullable list, for example) is returned as is, without allocating.
      let found: CompactType = 0;
      let several: unknown[] | undefined;
      for (let index = 1; index < type.length; index += 1) {
        const member = compactTypeAt(type[index] as CompactType, key);
        if (member === 0) continue;
        if (found === 0) found = member;
        else (several ??= ["u", found]).push(member);
      }
      return several ?? found;
    }
  }
  return 0;
}

/** A generated component's declared state: names, compact types, and its source for warnings. */
export interface GeneratedStateSpec {
  readonly n: readonly string[];
  readonly t: readonly CompactType[];
  readonly f: string;
  /** The component tag, which inspection and serialization report. */
  readonly g: string;
  /** How many of the names are writable `<state>`; the rest are read-only computeds. Props' roots follow them all. */
  readonly k?: number;
  /** Declared events, which `host.dispatch` checks and flags as the live host does. */
  readonly d?: Readonly<Record<string, GeneratedEventDeclaration>>;
  /** `dispatchDeclared`, supplied by a module that declares events, so others do not bundle it. */
  readonly x?: typeof dispatchDeclared;
  /** `iteratedRef`, supplied by a module with refs inside rows. */
  readonly z?: typeof iteratedRef;
}

/** A ref the host reads: an iterated one is what the iteration still renders, in document order. */
export function iteratedRef(recorded: Record<string, unknown>, key: string): unknown {
  const value = recorded[key];
  if (!Array.isArray(value)) return value;
  const live = (value as Element[]).filter((element) => element.isConnected);
  if (live.length !== value.length) recorded[key] = live;
  return live.sort((a, b) => (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1);
}

/**
 * What a module with computeds shares with its controller host. Every state or nested write
 * advances the epoch, so a computed knows it may be stale; the module computes a slot on demand
 * (`g`); the computeds a controller has read (`w`) are refreshed before each render, and the host
 * tells controller effects when one changed (`n`).
 */
export interface GeneratedChannel {
  e: number;
  readonly g: (index: number) => unknown;
  readonly w: Set<number>;
  n?: (index: number, previous: unknown, next: unknown) => void;
}

/** The instance internals generated handlers, listeners and refs use; each is imported only when used. */
export interface GeneratedInstance {
  readonly S: GeneratedStateSpec;
  /** The controller's state facade, which validates, stores raw and schedules. */
  readonly s: Record<PropertyKey, unknown>;
  readonly q: ReactiveScheduler;
  /** The instance's owners, paused on disconnect and resumed on connect. */
  readonly o: ReactiveOwner[];
  /** Recorded refs, read by `host.refs` and handler steps. */
  readonly r: Record<string, unknown>;
  readonly c: () => boolean;
  /** A facade over a raw object, for writes into an outer local's data. */
  readonly p: (value: object) => unknown;
  /** Writes a root's value and schedules its render, as a prop update does. */
  readonly w: (index: number, value: unknown) => void;
  /** The instance's props, set before attaching so `host.props` can read them. */
  readonly B?: GeneratedPropRecord;
}

/** A control's write into state is not checked against the declared type, as live's is not. */
let trusted = false;

/**
 * A two-way binding's control listener, as live binds one while the root is connected: a select,
 * checkbox, radio or file control reports `change`, anything else `input`; an unchecked radio
 * writes nothing. `path` resolves the destination (an outer local's object, or a root's name first).
 */
export function bindControl(instance: GeneratedInstance, target: Element, path: () => readonly unknown[] | undefined): () => void {
  const type = target instanceof HTMLSelectElement ||
    target instanceof HTMLInputElement && ["checkbox", "radio", "file"].includes(target.type) ? "change" : "input";
  return listen(instance, target, type, () => {
    if (target instanceof HTMLInputElement && target.type === "radio" && !target.checked) return;
    const resolved = path();
    if (resolved === undefined) return;
    trusted = true;
    try {
      let object: unknown = instance.s;
      for (let index = 0; index < resolved.length - 1; index += 1) {
        if (object == null) return;
        const step = resolved[index];
        // An outer local's value arrives as an object, reached through a facade of its own.
        object = typeof step === "object" && step !== null ? instance.p(step) : (object as Record<PropertyKey, unknown>)[step as PropertyKey];
      }
      if (object != null) (object as Record<PropertyKey, unknown>)[resolved.at(-1) as PropertyKey] = controlValue(target);
    } finally { trusted = false; }
  }, false, false, false);
}

/** A handler's `<set>`: checks the destination's declared type, then writes through the host's facades. */
export function setState(instance: GeneratedInstance, path: readonly (string | number)[], value: unknown, key: string, label: string): void {
  const { n: names, t: types } = instance.S;
  let type = types[names.indexOf(path[0] as string)]!;
  for (let index = 1; index < path.length; index += 1) type = compactTypeAt(type, path[index]!);
  if (!conforms(value, type)) {
    warnOnce(instance.S, key, `State \`${label}\` does not satisfy its declared type.`);
    return;
  }
  // Through the controller's facades, which notify, mark what changed and schedule the render.
  let target: unknown = instance.s;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (target == null) return;
    target = (target as Record<PropertyKey, unknown>)[path[index]!];
  }
  if (target != null) (target as Record<PropertyKey, unknown>)[path.at(-1)!] = value;
}

/**
 * Listens while the root is connected, as a live template listener effect does. A `once`
 * listener is spent by its first event and never re-armed by a reconnect.
 */
export function listen(
  instance: GeneratedInstance, target: EventTarget, type: string, listener: (event: Event) => void,
  capture: boolean, passive: boolean, once: boolean,
): () => void {
  let fired = false;
  const wrapped = (event: Event): void => {
    fired = once;
    listener(event);
  };
  const effect = createEffect(instance.q, () => {
    if (fired) return;
    target.addEventListener(type, wrapped, { capture, passive, once });
    return () => target.removeEventListener(type, wrapped, { capture });
  }, 2, instance.c());
  instance.o.push(effect);
  return () => effect.stop();
}

/** The changed-roots bits plus the raw objects written since the last render (see `DirtyObjects`). */
export type GeneratedUpdate = (changed: number, dirty: Map<unknown, 1 | 2>) => void;

interface Facade extends ProxyHandler<object> {
  /** Declared type, raw target, proxy, next facade of the same target with another type. */
  t: CompactType;
  r: object;
  p: object;
  n: Facade | undefined;
  /** The last path that reached it: parent facade (undefined for a root) and key. */
  u: Facade | undefined;
  k: PropertyKey;
}

const reportedWarnings = new WeakMap<GeneratedStateSpec, Set<string>>();

/** A declared reference's value (`readPath`): list items by index, `length`, and object keys. */
export function readDeclared(value: unknown, steps: readonly string[], reads?: unknown[]): unknown {
  for (const step of steps) {
    reads?.push(value);
    if (Array.isArray(value)) {
      value = step === "length" ? value.length : /^\d+$/.test(step) ? value[Number(step)] : undefined;
    } else if (typeof value === "string" && step === "length") {
      value = value.length;
    } else if (typeof value === "object" && value !== null) {
      value = (value as Record<string, unknown>)[step];
    } else {
      return ABSENT;
    }
  }
  return value === undefined ? ABSENT : raw(value);
}

/** Checks a declared reference; a failing one warns once (HR007) and leaves its expression nonconforming. */
export function checkReference(spec: GeneratedStateSpec, value: unknown, type: CompactType, key: string, message: string): boolean {
  if (referenceConforms(value, type)) return true;
  warnOnce(spec, key, message);
  return false;
}

/**
 * Checks a select prop's reference against the type its selector's value chooses; the last option
 * stands for no match (and a null selector), whose type is null.
 */
export function checkSelected(
  spec: GeneratedStateSpec, value: unknown, selector: unknown,
  options: readonly (readonly [choice: unknown, type: CompactType, message: string])[], key: string,
): boolean {
  const [, type, message] = options.find(([choice], index) => index === options.length - 1 || selector !== null && choice === selector)!;
  return checkReference(spec, value, type, key, message);
}

/** Warns HR007 once per component and key, as the live runtime's authored warnings do. */
export function warnOnce(spec: GeneratedStateSpec, key: string, message: string): void {
  let reported = reportedWarnings.get(spec);
  if (reported === undefined) reportedWarnings.set(spec, reported = new Set());
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`${spec.f}: HR007: ${message}`);
}

/**
 * Attaches the controller contract to a generated root and renders its initial state. Template
 * reads stay raw; writes through `host.state` are validated, stored raw, and mark the roots and
 * objects that changed for one priority-1 render per flush on the instance's scheduler.
 */
export function attachGeneratedController(
  root: Element,
  spec: GeneratedStateSpec,
  values: unknown[],
  update: GeneratedUpdate,
  /** Calls the controller module's default export; read when the root first connects, as live does. */
  controller: ((host: never) => unknown) | undefined,
  channel?: GeneratedChannel,
  /** Filled before the first render, so regions it renders can already listen and record refs. */
  handle = {} as GeneratedInstance,
): GeneratedInstance {
  const { n: names, t: types } = spec;
  const writable = spec.k ?? names.length;
  const scheduler = new ReactiveScheduler();
  const entries: ReactiveOwner[] = [];
  const facades = new WeakMap<object, Facade>();
  // Root reads and writes track this target, so controller effects see root replacement.
  const roots = {};
  let dirty = 0;
  let objects = new Map<unknown, 1 | 2>();
  let spare = new Map<unknown, 1 | 2>();
  let connected = false;
  let started = false;
  let gone = false;
  let cleanup: (() => void) | undefined;
  const render = (changed: number): void => {
    const written = objects;
    objects = spare;
    try { untracked(() => update(changed, written)); }
    finally { written.clear(); spare = written; }
  };
  const job = new ReactiveEffect(scheduler, () => {
    // Bits wait while disconnected; a reconnect's full render may already have taken them.
    if (!connected || dirty === 0) return;
    if (channel !== undefined) for (const index of channel.w) channel.g(index);
    const changed = dirty;
    dirty = 0;
    render(changed);
  }, 1);
  if (channel !== undefined) channel.n = (index, previous, next) => notifyPropertySet(roots, names[index]!, previous, next, undefined);
  /** Stores a root's new value, marks it changed and schedules the render. */
  const assign = (index: number, next: unknown): void => {
    if (channel !== undefined) channel.e += 1;
    values[index] = next;
    // Roots from index 29 share one bit; the written map says which of them changed.
    if (index < 29) dirty |= 1 << index;
    else {
      dirty |= 1 << 29;
      if (connected) objects.set(index, 1);
    }
    job.schedule();
  };
  const warn = (path: string, message: string): void => warnOnce(spec, `controller:${path}`, message);
  const readOnly = (path: string): void => warn(path, `Destination \`${path}\` is read-only.`);
  const mismatch = (path: string): void => warn(path, `State \`${path}\` does not satisfy its declared type.`);
  const pathOf = (facade: Facade | undefined, key: PropertyKey): string => {
    let path = String(key);
    for (; facade !== undefined; facade = facade.u) path = `${String(facade.k)}.${path}`;
    return path;
  };
  /** Marks a written object (1) and the objects on its last path (2), then schedules a render. */
  const written = (facade: Facade): void => {
    if (channel !== undefined) channel.e += 1;
    // A reconnect renders everything, so nothing written while disconnected needs keeping.
    if (!connected) return;
    objects.set(facade.r, 1);
    for (let parent = facade.u; parent !== undefined; parent = parent.u) {
      if (!objects.has(parent.r)) objects.set(parent.r, 2);
    }
    dirty |= NESTED;
    job.schedule();
  };
  /** Structural type equality: a union step can build an equal type afresh. */
  const same = (left: unknown, right: unknown): boolean => left === right ||
    Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => same(item, right[index]));
  const wrap = (value: unknown, type: CompactType, parent: Facade | undefined, key: PropertyKey): unknown => {
    if (value === null || typeof value !== "object" || isNativeEvent(value)) return value;
    const target = raw(value) as object;
    const first = facades.get(target);
    let facade = first;
    while (facade !== undefined && !same(facade.t, type)) facade = facade.n;
    if (facade === undefined) {
      facade = Object.create(traps) as Facade;
      facade.t = type;
      facade.r = target;
      facade.p = new Proxy(target, facade);
      facade.n = first;
      facades.set(target, facade);
    }
    // The last path that reached it, unless that path runs through it (cyclic data): chains stay
    // acyclic, so walking one always ends.
    let above = parent;
    while (above !== undefined && above !== facade) above = above.u;
    if (above === undefined) {
      facade.u = parent;
      facade.k = key;
    }
    return facade.p;
  };
  const traps: ThisType<Facade> & ProxyHandler<object> = {
    get(target, key, receiver) {
      if (key === RAW) return target;
      trackProperty(target, key);
      const value: unknown = Reflect.get(target, key, receiver);
      return value !== null && typeof value === "object" ? wrap(value, compactTypeAt(this.t, key), this, key) : value;
    },
    set(target, key, value) {
      if (!trusted && !conforms(value, compactTypeAt(this.t, key))) {
        mismatch(pathOf(this, key));
        return true;
      }
      const length = Array.isArray(target) ? target.length : undefined;
      const previous: unknown = Reflect.get(target, key);
      const next = raw(value);
      Reflect.set(target, key, next);
      if (!Object.is(previous, next) || length !== undefined && length !== (target as unknown[]).length) written(this);
      notifyPropertySet(target, key, previous, next, length);
      return true;
    },
    deleteProperty(target, key) {
      if (!conforms(undefined, compactTypeAt(this.t, key))) {
        mismatch(pathOf(this, key));
        return true;
      }
      const had = Reflect.has(target, key);
      Reflect.deleteProperty(target, key);
      if (had) written(this);
      notifyPropertyDelete(target, key, had);
      return true;
    },
    defineProperty(target, key, descriptor) {
      const type = compactTypeAt(this.t, key);
      if ("value" in descriptor && conforms(descriptor.value, type)) return Reflect.defineProperty(target, key, descriptor);
      if (!conforms(descriptor.value, type)) mismatch(pathOf(this, key));
      return false;
    },
  };
  const state = new Proxy({}, {
    get: (_target, key) => {
      const index = typeof key === "string" ? names.indexOf(key) : -1;
      if (index < 0) return undefined;
      trackProperty(roots, key);
      if (index < writable) return wrap(values[index], types[index]!, undefined, key);
      channel!.w.add(index);
      return wrap(channel!.g(index), types[index]!, undefined, key);
    },
    set: (_target, key, value) => {
      const index = typeof key === "string" ? names.indexOf(key) : -1;
      if (index < 0 || index >= writable) readOnly(String(key));
      else if (!trusted && !conforms(value, types[index]!)) mismatch(String(key));
      else {
        const previous = values[index];
        const next = raw(value);
        if (!Object.is(previous, next)) {
          assign(index, next);
          notifyPropertySet(roots, key, previous, next, undefined);
        }
      }
      return true;
    },
    deleteProperty: (_target, key) => (readOnly(String(key)), true),
    defineProperty: (_target, key) => (readOnly(String(key)), false),
    has: (_target, key) => typeof key === "string" && names.includes(key),
  });
  const dataPath = (key: PropertyKey): string => `data.${String(key)}`;
  const data = new Proxy({}, {
    get: () => undefined,
    set: (_target, key) => (readOnly(dataPath(key)), true),
    deleteProperty: (_target, key) => (readOnly(dataPath(key)), true),
    defineProperty: (_target, key) => (readOnly(dataPath(key)), false),
    has: () => false,
  });
  // The live host reads refs from an ordinary object, so inherited names answer as they do there.
  const recorded: Record<string, unknown> = {};
  const host = Object.freeze({
    get root() { return root; },
    get element() { return root; },
    state,
    data,
    on(type: string, callback: (event: Event) => void | (() => void)) {
      let stopped = false;
      const stop = host.effect(() => {
        if (type === "connect") return untracked(() => callback(new Event(type))) as void | (() => void);
        if (type === "disconnect") return () => { if (!stopped) untracked(() => callback(new Event(type))); };
        const listener = (event: Event): void => { callback(event); };
        root.addEventListener(type, listener);
        return () => root.removeEventListener(type, listener);
      });
      return () => { stopped = true; stop(); };
    },
    props: handle.B?.h ?? Object.freeze(Object.create(null) as object),
    refs: new Proxy({}, {
      get: (_target, key) => typeof key !== "string" ? undefined : spec.z === undefined ? recorded[key] : spec.z(recorded, key),
      has: (_target, key) => typeof key === "string" && recorded[key] !== undefined,
    }),
    slots: new Proxy({}, {
      get: (_target, key) => typeof key === "string" ? [] : undefined,
      has: () => false,
    }),
    signal: <T>(initialValue: T) => createSignal(initialValue),
    computed<T>(compute: () => T) {
      const computed = createComputed(scheduler, compute);
      if (!connected) computed.pause();
      entries.unshift(computed);
      return computed;
    },
    effect(run: () => void | (() => void)) {
      const effect = createEffect(scheduler, run, 2, connected);
      entries.push(effect);
      return () => effect.stop();
    },
    dispatch: (event: string, detail?: unknown): boolean => (spec.x ?? dispatchUndeclared)(root, event, detail, spec.d?.[event]),
  });
  Object.assign(handle, { S: spec, s: state, q: scheduler, o: entries, r: recorded, c: () => connected, p: (value: object) => wrap(value, 0, undefined, ""), w: assign });
  render(-1);
  const disconnect = (): void => {
    if (!gone) {
      gone = true;
      const finish = cleanup;
      cleanup = undefined;
      finish?.();
    }
    connected = false;
    objects.clear();
    for (const entry of entries) entry.pause();
  };
  manageIndexedLifecycle(root, () => {
    connected = true;
    for (const entry of entries) entry.resume();
    if (started) {
      // Live resumes its template effects after the controller's: every binding re-renders.
      dirty = 0;
      render(-1);
    } else {
      started = true;
      if (controller !== undefined) void Promise.resolve(controller(host as never)).then((result) => {
        if (typeof result !== "function") return;
        if (gone) (result as () => void)();
        else cleanup = result as () => void;
      });
    }
    return disconnect;
  }, { S: spec, v: values, H: host });
  return handle;
}
