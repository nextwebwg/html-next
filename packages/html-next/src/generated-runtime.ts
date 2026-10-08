/** Native lifecycle and prop wiring shared by ahead-of-time generated components. */

import { fail } from "./diagnostics.js";
import { manageIndexedLifecycle } from "./generated-lifecycle-index.js";
import { lifecycleKey, type RuntimeElement } from "./generated-lifecycle.js";
import { ABSENT, NONCONFORMING, toAttribute, toText, truthy, type Value } from "./expression.js";
import { isNativeEvent } from "./freeze.js";
import { NESTED, raw, RAW } from "./keyed.js";
import { applyBoundControlValue, controlValue } from "./controls.js";
import { markProjectedRoot, stateAttributeValue } from "./component-styles.js";
import { renderedFormMark } from "./rendered-form.js";
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
import { typedText, type TextForm, type TypeCheck } from "./type-checks.js";
import { DataResource, type DataState } from "./data.js";
import { kebabCase } from "./names.js";
import { propsValidity, type PropRule, type Validity } from "./validate.js";
import type { boundFailures } from "./value-constraints.js";
import { manageDerivedValidity, setElementValidity, unmanageElementValidity, validityState } from "./validity.js";

export { ABSENT, binaryValue, formatCall, mathCall, negate, NONCONFORMING, textCall, toAttribute, toText, truthy } from "./expression.js";
export { manageGeneratedLifecycle } from "./generated-lifecycle.js";
export { dispose, IndexedList, KeyedList, PositionalList, RangedIndexedList, RangedKeyedList, RangedPositionalList } from "./keyed.js";
export { visitSelected } from "./selection.js";
export { holdTransitions, transitionChanged, transitionName, transitionRows, transitionRowsChanged, transitionStyles } from "./generated-transitions.js";
export { eventPasses } from "./event-filter.js";
export {
  checkAbsent, checkBoolean, checkConstrained, checkEvent, checkFormat, checkFunction, checkInteger, checkKeyword, checkList,
  checkNull, checkNumber, checkObject, checkRecord, checkSelectedType, checkSeparated, checkString, checkTrusted, checkUnion,
  checkUnknown,
} from "./type-checks.js";
export { boundFailures } from "./value-constraints.js";

/** A declared event's detail check (or 0 for an untyped event) and its bubbles, composed and cancelable flags. */
export type GeneratedEventDeclaration = readonly [check: ((detail: unknown) => boolean) | 0, bubbles: boolean, composed: boolean, cancelable: boolean];

/** An undeclared event: bubbling, composed and not cancelable, as the live host dispatches one. */
const dispatchUndeclared = (target: Element | readonly Element[], name: string, detail: unknown): boolean =>
  (target as Element).dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false }));

/** The detail check of a typed event; only modules that declare one import it, and with it the type system. */
export const detailCheck = (check: TypeCheck) => (detail: unknown): boolean => check(detail, "$", "value").ok;

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

const generatedPropUpdaters = new WeakMap<Element, (props: Readonly<Record<string, unknown>>) => void>();

/** What a root `$match` arm writes on its root: its literals, class tokens, style and output attributes. */
export type ArmRoot = readonly [
  tag: string, literals: Readonly<Record<string, string>>, classes: readonly string[], style: string,
  styles: readonly string[], written: readonly string[],
];

// ponytail: a focusability approximation for restoring focus across a root switch, as live's.
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]";
const replacedKey = Symbol.for("@nextwebwg/html-next.replaced.v1");

/**
 * The next arm's root, as live's root switch renders it: the arm's literals, then every attribute
 * of the old root its arm did not write, which is the invocation's, a factory's or page code's.
 * Class tokens and style properties are shared, so only the old arm's own are dropped.
 */
export function armElement(previous: Element, from: ArmRoot, to: ArmRoot): Element {
  const [, literals, classes, style, styles, written] = from;
  const ownStyle = previous.ownerDocument.createElement("div").style;
  ownStyle.cssText = style;
  for (const property of styles) ownStyle.setProperty(property, "initial");
  const ownStyles = new Set(Array.from(ownStyle));
  const next = to[0] === "svg" ? previous.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg") : previous.ownerDocument.createElement(to[0]);
  for (const [name, value] of Object.entries(to[1])) next.setAttribute(name, value);
  for (const attribute of Array.from(previous.attributes)) {
    let value: string | undefined;
    if (attribute.name === "class") {
      value = attribute.value.split(/\s+/).filter((token) => token !== "" && !classes.includes(token)).join(" ");
    } else if (attribute.name === "style") {
      const declared = (previous as HTMLElement).style;
      value = Array.from(declared).filter((property) => !ownStyles.has(property)).map((property) =>
        `${property}: ${declared.getPropertyValue(property)}${declared.getPropertyPriority(property) === "" ? "" : " !important"}`).join("; ");
    } else if (!written.includes(attribute.name) && literals[attribute.name] !== attribute.value) value = attribute.value;
    if (value === undefined || value === "" && (attribute.name === "class" || attribute.name === "style")) continue;
    const own = attribute.name === "class" || attribute.name === "style" ? next.getAttribute(attribute.name) : null;
    next.setAttribute(attribute.name, own === null || own === "" ? value : `${own}${attribute.name === "class" ? " " : "; "}${value}`);
  }
  return next;
}

/**
 * Puts a new root in the old one's place, as live's root switch does: the lifecycle record moves to
 * it (the old element still reaches the instance), the host's root follows, the props move, and
 * focus stays on the root, on moved projected content, or on the same position's control.
 */
export function replaceRoot(instance: GeneratedInstance, previous: Element, next: Element): void {
  const active = previous.ownerDocument.activeElement;
  const position = active !== null && active !== previous && previous.contains(active)
    ? Array.from(previous.querySelectorAll(FOCUSABLE)).indexOf(active) : -1;
  previous.replaceWith(next);
  const record = (previous as RuntimeElement)[lifecycleKey];
  if (record !== undefined) {
    delete (previous as RuntimeElement)[lifecycleKey];
    (next as RuntimeElement)[lifecycleKey] = record;
    record.element = next;
  }
  (previous as Element & { [replacedKey]?: unknown })[replacedKey] = instance;
  instance.e = next;
  notifyPropertySet(instance, "e", previous, next, undefined);
  instance.B?.m?.(previous, next);
  const target = active === previous ? next
    : active?.isConnected === true && next.contains(active) ? active
    : position >= 0 ? next.querySelectorAll(FOCUSABLE)[position] : undefined;
  (target as HTMLElement | undefined)?.focus?.({ preventScroll: true });
}

/** A compiled factory: options, and the HTML input an invocation's literal props carry. */
export type GeneratedFactory = (options: object, html?: Readonly<Record<string, string>>) => Element;

/**
 * Creates an invoked component through its factory where `placeholder` sits, as live lowering puts
 * the component's root in its invocation's place, and follows its root: when a root switch replaces
 * it, `follow` moves what the parent bound there. Returns the component's handle.
 */
export function invoke(
  instance: GeneratedInstance, factory: GeneratedFactory, placeholder: ChildNode, options: object,
  html: Readonly<Record<string, string>>, follow: (root: Element, previous: Element) => void, stops: (() => void)[],
): GeneratedInstance {
  const root = factory(options, html);
  // A placeholder that is its block's own node has no parent yet; the block takes the root instead.
  if (placeholder.parentNode !== null) placeholder.replaceWith(root);
  // A projected invocation's projection entry follows its root, so a slot that renders again inserts it.
  follows(placeholder, root);
  const child = (root as RuntimeElement)[lifecycleKey]!.h as GeneratedInstance;
  let current = root;
  const effect = createEffect(instance.q, () => {
    trackProperty(child, "e");
    const next = child.e;
    if (next !== current) {
      const previous = current;
      current = next;
      follows(previous, next);
      untracked(() => follow(next, previous));
    }
  }, 2, instance.c());
  instance.o.push(effect);
  stops.push(() => release(instance, effect));
  return child;
}

/**
 * A bound prop's first form, its attribute text, as live writes it on the invocation: none for a value
 * the prop's type does not take (a select prop's type is unknown until the component exists).
 */
export function propText(type: CompactType | null, value: unknown, attribute: string): string | null {
  return value === NONCONFORMING || !fits(value, type) ? null : toAttribute(value as Value, attribute);
}

/** The parent's projected content, by slot: elements with a `slot` attribute go to that slot, the rest to the unnamed one. */
export function projected(fragment: Node): { children: Node[]; slots: Record<string, Node[]> } {
  const children: Node[] = [];
  const slots: Record<string, Node[]> = {};
  for (const node of Array.from(fragment.childNodes)) {
    const name = node.nodeType === 1 ? (node as Element).getAttribute("slot") : null;
    if (name === null) children.push(node);
    else (slots[name] ??= []).push(node);
  }
  return { children, slots };
}

/**
 * Applies a parent's bound value to an invoked component's prop, as live's invocation binding does:
 * a value the prop's type (chosen by its selector) does not take is not applied at all.
 */
export function bindProp(child: GeneratedInstance, name: string, value: unknown): void {
  const record = child.B!;
  const props = record.D.props;
  const prop = props[name]!;
  const from = prop.select?.from;
  const checks = chosen(props, prop, from === undefined ? {}
    : { [from]: record.v[Object.hasOwn(props, from) ? record.n.length + Object.keys(props).indexOf(from) : record.n.indexOf(from)] });
  if (!fits(value, checks?.m ?? null)) return;
  // The child's own channel: a root it shares answers to the component that delegates to it.
  record.u!({ [name]: value });
}

/**
 * Whether a nested write reached anything in `value`: live parses a bound prop at its destination
 * inside the binding's effect, so every part of the value is a dependency of that binding.
 */
export function touches(value: unknown, dirty: ReadonlyMap<unknown, 1 | 2>, seen = new Set<unknown>()): boolean {
  if (dirty.size === 0 || value === null || typeof value !== "object" || seen.has(value)) return false;
  if (dirty.has(value)) return true;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    if (touches(raw(item), dirty, seen)) return true;
  }
  return false;
}

/** A listener on an invoked component's root, which moves to a replacement root as live's does. */
export function listenRoot(
  instance: GeneratedInstance, child: GeneratedInstance, type: string, listener: (event: Event) => void,
  capture: boolean, passive: boolean, once: boolean,
): () => void {
  let fired = false;
  const wrapped = (event: Event): void => {
    fired = once;
    listener(event);
  };
  const effect = createEffect(instance.q, () => {
    trackProperty(child, "e");
    const target = child.e;
    if (fired) return;
    target.addEventListener(type, wrapped, { capture, passive, once });
    return () => target.removeEventListener(type, wrapped, { capture });
  }, 2, instance.c());
  instance.o.push(effect);
  return () => release(instance, effect);
}

/**
 * The lifecycle of a component that delegates its root to `inner`: as live's, it owns the shared
 * root (its host is the root's, and inspection lists `inner` among its delegates), and connects first,
 * with `inner` riding its connection.
 */
export function delegateLifecycle(inner: GeneratedInstance): NonNullable<GeneratedInstance["L"]> {
  return (element, connect, handle) => {
    const record = (element as RuntimeElement)[lifecycleKey]! as { connect: (element: Element) => () => void; h?: unknown };
    const own = record.connect;
    record.connect = (current) => {
      const stop = connect();
      const stopInner = own(current);
      return () => { stop(); stopInner(); };
    };
    record.h = handle;
    (handle as GeneratedInstance).D = [inner, ...inner.D ?? []];
  };
}

/** The root a delegating component shares, followed when its owner's root switch replaces it. */
export function followShared(instance: GeneratedInstance, previous: Element, next: Element): void {
  instance.e = next;
  notifyPropertySet(instance, "e", previous, next, undefined);
  instance.B?.m?.(previous, next);
}

/** An invocation's literal attributes, then its consumer's: theirs win, and class and style combine. */
export function passThrough(literals: Readonly<Record<string, string>>, consumer: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...literals };
  for (const [name, value] of Object.entries(consumer)) {
    if (value === null || value === undefined || value === false) continue;
    const own = name === "class" || name === "style" ? merged[name] : undefined;
    merged[name] = own === undefined || own === "" ? value : `${own as string}${name === "class" ? " " : "; "}${value === true ? "" : String(value)}`;
  }
  return merged;
}

/**
 * A `<context>`: on first connect, as live resolves it on attaching, the nearest ancestor root of
 * component `from` that declares state `name` provides it (HR009 when none does). Its value is root
 * `index`: a new value re-renders and tells the controller's effects; a nested write the provider
 * rendered patches what reads into it (`nested`). The provider tells only connected readers.
 */
export function readContext(
  instance: GeneratedInstance, channel: GeneratedChannel, index: number, from: string, name: string,
  nested: (dirty: ReadonlyMap<unknown, 1 | 2>) => void,
): void {
  let provider: GeneratedInstance | undefined;
  let at = -1;
  const follow = (_changed: number, dirty: ReadonlyMap<unknown, 1 | 2> | undefined): void => {
    const values = instance.v!;
    const previous = values[index];
    const next = provider!.v![at];
    if (!Object.is(previous, next)) {
      instance.w(index, next);
      channel.n?.(index, previous, next);
    } else if (dirty !== undefined && touches(next, dirty)) nested(dirty);
  };
  instance.o.push({
    pause: () => { provider?.R?.delete(follow); },
    resume: () => {
      search: for (let element = instance.e.parentElement; provider === undefined && element !== null; element = element.parentElement) {
        const owner = (element as RuntimeElement)[lifecycleKey]?.h as GeneratedInstance | undefined;
        for (const candidate of owner === undefined ? [] : [owner, ...owner.D ?? []]) {
          const position = candidate.S.n.indexOf(name);
          if (candidate.S.g === from && position >= 0 && position < (candidate.S.k ?? candidate.S.n.length)) {
            provider = candidate;
            at = position;
            break search;
          }
        }
      }
      if (provider === undefined) fail("HR009", `<${instance.S.g}> requires context \`${name}\` from <${from}>.`);
      (provider.R ??= new Set()).add(follow);
      follow(0, undefined);
    },
    stop: () => { provider?.R?.delete(follow); },
  });
}

const readonlyViews = new WeakMap<object, Map<string, object>>();

/** A read-only view for the controller, as live's host gives one: reads track, writes warn by path. */
export function readonlyView(spec: GeneratedStateSpec, value: unknown, path: string): unknown {
  if (value === null || typeof value !== "object" || isNativeEvent(value)) return value;
  const target = raw(value) as object;
  let views = readonlyViews.get(target);
  if (views === undefined) readonlyViews.set(target, views = new Map());
  let view = views.get(path);
  if (view === undefined) {
    const deny = (key: PropertyKey): void => warnOnce(spec, `controller:${path}.${String(key)}`, `Destination \`${path}.${String(key)}\` is read-only.`);
    view = new Proxy(target, {
      get: (object, key) => {
        if (key === RAW) return object;
        trackProperty(object, key);
        return readonlyView(spec, Reflect.get(object, key), `${path}.${String(key)}`);
      },
      set: (_object, key) => (deny(key), true),
      deleteProperty: (_object, key) => (deny(key), true),
      defineProperty: (_object, key) => (deny(key), false),
    });
    views.set(path, view);
  }
  return view;
}

/** A declared read: its name, source, declared type, and debounce and poll in milliseconds. */
export interface GeneratedData { readonly n: string; readonly s?: string; readonly t?: string; readonly d?: number; readonly p?: number }

/**
 * A `<data>` read, as live runs one: its state (root `index`) starts pending, a request goes out when
 * the root connects and whenever a `from` parameter changes (`from` reports the parameters and whether
 * they all conform), every parameter is sampled again when it is sent, and disconnecting aborts it.
 * `host.data` shows the state read-only. Returns what re-requests after a `from` parameter changed.
 */
/**
 * `host.data` for a component that declares reads, as live's host gives it: each read's state by
 * name, read-only. `reads` maps each name to its root and is what reading one tracks.
 */
export function dataHandles(spec: GeneratedStateSpec, values: readonly unknown[], reads: Readonly<Record<string, number>>): object {
  const deny = (key: PropertyKey): void => warnOnce(spec, `controller:data.${String(key)}`, `Destination \`data.${String(key)}\` is read-only.`);
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string" || !Object.hasOwn(reads, key)) return undefined;
      trackProperty(reads, key);
      return readonlyView(spec, values[reads[key]!], key);
    },
    set: (_target, key) => (deny(key), true),
    deleteProperty: (_target, key) => (deny(key), true),
    defineProperty: (_target, key) => (deny(key), false),
    has: (_target, key) => typeof key === "string" && Object.hasOwn(reads, key),
  });
}

export function manageData(
  instance: GeneratedInstance, index: number, declaration: GeneratedData,
  from: () => readonly [Record<string, unknown>, boolean], sample: () => Record<string, unknown>,
  reads: Readonly<Record<string, number>>,
): () => void {
  const values = instance.v!;
  const resource = declaration.s === undefined ? undefined : new DataResource({
    source: declaration.s, baseURL: instance.S.f,
    ...declaration.t === undefined ? {} : { type: declaration.t },
    ...declaration.d === undefined ? {} : { debounce: declaration.d },
    ...declaration.p === undefined ? {} : { poll: declaration.p },
    sampleParameters: sample,
    onState: (state: DataState) => {
      const previous = values[index];
      instance.w(index, state);
      notifyPropertySet(reads, declaration.n, previous, state, undefined);
    },
  });
  let connected = false;
  const request = (): void => {
    const [parameters, valid] = from();
    if (valid) resource?.update(parameters);
  };
  instance.o.push({
    pause: () => { connected = false; resource?.disconnect(); },
    resume: () => { connected = true; request(); },
    stop: () => resource?.disconnect(),
  });
  return () => { if (connected) request(); };
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

/** A declared type, compiled: its check, terminal name, text form and compact type. */
export interface PropChecks {
  readonly c: TypeCheck;
  readonly t?: string;
  readonly j: TextForm;
  readonly m: CompactType;
}

/**
 * A declared prop, compiled: its rule and default, its type's checks (a select prop's are its options'),
 * and `k`, `boundFailures`, when it declares a bound.
 */
export interface CompiledProp extends PropRule, Partial<PropChecks> {
  readonly default?: unknown;
  readonly k?: typeof boundFailures;
  readonly select?: { readonly from: string; readonly options: readonly (PropChecks & { readonly value: unknown })[] };
}

type CompiledProps = Readonly<Record<string, CompiledProp>>;

/** The checks of a prop's type, chosen by its selector's value as `selectedPropType` chooses; null when no option matches. */
function chosen(props: CompiledProps, prop: CompiledProp, values: Readonly<Record<string, unknown>>): PropChecks | null {
  if (prop.select === undefined) return prop as PropChecks;
  const supplied = values[prop.select.from];
  const value = supplied === undefined ? props[prop.select.from]?.default ?? null : supplied;
  if (value === null) return null;
  return prop.select.options.find((option) => option.value === value) ?? null;
}

/** An input through a prop's type (`invocationValue`): null stays null, and a value the type refuses is undefined. */
function taken(checks: PropChecks | null, input: unknown, source: "html" | "value"): unknown {
  if (input === null || checks === null) return input;
  const parsed = checks.c(input, "$", source);
  return parsed.ok ? parsed.value : undefined;
}

/** The `data-<name>` text of a value (`reflectedPropValue`): the type's form when the type takes it, else as given. */
function reflected(value: unknown, checks: PropChecks | null): string {
  const parsed = checks?.c(value, "$", "value");
  return parsed?.ok === true ? typedText(parsed.value, checks!.j) : typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/** The destination check (`conformsAtDestination`) on a compact type, or on null, a select prop's type without an option. */
const fits = (value: unknown, type: CompactType | null): boolean => value === ABSENT || type !== null && conforms(value, type);

/** A compiled instance's props, as the live runtime keeps an instance's. */
export interface GeneratedPropRecord {
  readonly D: { readonly props: CompiledProps };
  /** The state and computed names; each prop's root follows them, in the contract's order. */
  readonly n: readonly string[];
  readonly v: unknown[];
  /** The latest input of each prop, and the props an input made explicit. */
  readonly i: Record<string, PropInput>;
  readonly x: Set<string>;
  /** Props the root template binds as `data-<name>` itself, so that attribute is its output; a root switch changes them. */
  b: readonly string[];
  /** Moves the prop boundary to a new root, set by `manageProps`. */
  m?: (previous: Element, next: Element) => void;
  /** Applies a framework's or parent's props, set by `manageProps`. */
  u?: (props: Readonly<Record<string, unknown>>) => void;
  /** Props whose `data-<name>` holds a raw input write, which a first connection leaves as it is. */
  readonly w: Set<string>;
  /** The factory's values, written raw on the root before it first renders its props. */
  readonly f: Readonly<Record<string, unknown>>;
  /** The props' validity, as the root reports it. */
  readonly y: () => Validity;
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
  element: Element | undefined, D: GeneratedPropRecord["D"], n: readonly string[], v: unknown[],
  input: Readonly<Record<string, unknown>>, bound: readonly string[], html?: Readonly<Record<string, string>>,
): GeneratedPropRecord {
  const props = D.props;
  const names = Object.keys(props);
  // The factory's explicit values are recorded as `data-<name>`, raw, once the root exists (`manageProps`).
  const raw = new Set<string>();
  for (const name of names) {
    const prop = props[name]!;
    const value = input[name];
    if (value === undefined || value === null || prop.select !== undefined && props[prop.select.from] === undefined) continue;
    raw.add(name);
  }
  // An invocation's literal props are its HTML input; a factory's root reads its `data-<name>`
  // attributes back as HTML input instead, and the factory's values win.
  const incoming: Record<string, PropInput> = Object.create(null);
  if (html !== undefined) {
    for (const name of names) if (Object.hasOwn(html, name)) incoming[name] = { value: html[name], source: "html", present: true };
  } else for (const attribute of Array.from(element?.attributes ?? [])) {
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
      // An invocation's bare boolean attribute is HTML input "", which reads as true.
      accepted[name] = taken(chosen(props, prop, from === undefined || props[from] !== undefined ? accepted : { [from]: v[at(from)] }),
        item.value, item.source);
    }
  }
  for (const name of names) {
    const prop = props[name]!;
    v[at(name)] = accepted[name] !== undefined ? accepted[name] : prop.default === undefined ? null : prop.default;
  }
  const inputs: Record<string, PropInput> = Object.create(null);
  for (const name of names) inputs[name] = incoming[name] ?? { value: null, source: "value", present: false };
  const record: GeneratedPropRecord = {
    D, n, v, i: inputs, b: bound, w: raw, f: input,
    x: new Set(names.filter((name) => incoming[name] !== undefined && incoming[name]!.value !== null)),
    // Reads every prop's input and value, as live's validity does, so an effect reading it tracks them all.
    y: () => propsValidity(props, (prop, selector) => chosen(props, prop, prop.select === undefined ? {} : { [prop.select.from]: selector }),
      (prop) => prop.k,
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
export function manageProps(instance: GeneratedInstance): void {
  const record = instance.B!;
  const { D, n, v, i: inputs, x: explicit } = record;
  const props = D.props;
  const names = Object.keys(props);
  const at = (name: string): number => names.includes(name) ? n.length + names.indexOf(name) : n.indexOf(name);
  // The factory's explicit values, as its live attachment writes them before rendering.
  for (const name of record.w) {
    instance.e.setAttribute(`data-${kebabCase(name)}`, reflected(record.f[name], chosen(props, props[name]!, record.f)));
  }
  for (const name of record.b) record.w.delete(name);
  const changed = new Set<string>();
  let connected = false;
  let installed = false;
  /** The root's validity: every prop of every component sharing it, the owner's first, as live's. */
  const shared = (): Validity => {
    const owner = (instance.e as RuntimeElement)[lifecycleKey]?.h as GeneratedInstance | undefined;
    const errors = [owner ?? instance, ...owner?.D ?? []].flatMap((entry) => entry.B?.y().errors ?? []);
    return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
  };
  const selected = (prop: CompiledProp, values: Readonly<Record<string, unknown>>): PropChecks | null => chosen(props, prop, values);
  const reflect = (name: string): void => {
    const prop = props[name]!;
    const element = instance.e;
    record.w.delete(name);
    if (!record.b.includes(name) && !explicit.has(name)) return;
    const value = v[at(name)];
    // Null is "no value" at the attribute boundary: it removes the attribute.
    const text = value === undefined || value === ABSENT || value === null ? null
      : reflected(value, selected(prop, prop.select === undefined ? {} : { [prop.select.from]: v[at(prop.select.from)] }));
    if (text === null) element.removeAttribute(`data-${kebabCase(name)}`);
    else element.setAttribute(`data-${kebabCase(name)}`, text);
  };
  const job = new ReactiveEffect(instance.q, () => {
    if (!connected) return;
    for (const name of changed) reflect(name);
    changed.clear();
    setElementValidity(instance.e, shared());
  }, 2);
  instance.o.push({
    pause: () => { connected = false; },
    resume: () => {
      connected = true;
      changed.clear();
      if (installed) {
        for (const name of names) reflect(name);
        setElementValidity(instance.e, shared());
        return;
      }
      installed = true;
      manageDerivedValidity(instance.e, shared);
      // Live reflects every explicit or bound prop as it adopts the root, then the factory's (and an
      // invocation's bound) values write their raw text again: those keep it.
      for (const name of names) if (!record.w.has(name)) reflect(name);
      job.schedule();
    },
    stop: () => job.stop(),
  });
  // A root switch moves validity to the new root, and the props reflect there again.
  record.m = (previous, next) => {
    generatedPropUpdaters.set(next, update);
    if (!installed) return;
    unmanageElementValidity(previous);
    manageDerivedValidity(next, shared);
    for (const name of names) reflect(name);
    job.schedule();
  };
  const update = (input: Readonly<Record<string, unknown>>): void => {
    const element = instance.e;
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
        // A framework's undefined returns the prop to its default (`assignedPropValue`).
        const accepted = value !== undefined ? taken(selected(prop, next), value, "value") : prop.default === undefined ? null : prop.default;
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
        if (!record.b.includes(name)) element.removeAttribute(attribute);
      } else {
        explicit.add(name);
        if (!record.b.includes(name)) {
          element.setAttribute(attribute, reflected(value, selected(prop, next)));
          record.w.add(name);
        }
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
  };
  generatedPropUpdaters.set(instance.e, record.u = update);
}

/**
 * A prototype for cloning: `[tag, [name, value, ...], ...children]`, where an empty tag is a
 * fragment, a string is text, 0 is an empty Text (a `$value` writes it, and an invoked component
 * replaces it), 1 is a `$if` anchor pair, 2 is a `$each` anchor pair, 3 is an `$html` range and 4 is
 * a slot's placeholder pair.
 */
export type TemplateSpec = readonly [tag: string, attributes: readonly string[], ...children: readonly unknown[]];
type TemplateChild = string | 0 | 1 | 2 | 3 | 4 | TemplateSpec;

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
      const prefix = child === 2 ? "html-next:each-" : child === 3 ? "html-next:html-" : child === 4 ? "html-next:slot-" : "html-next:";
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
  /** `readonlyView`, supplied by a module with computeds or contexts, which the host shows read-only. */
  readonly r?: typeof readonlyView;
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
  /** The root element, which a root `$match` replaces. */
  e: Element;
  /** Registers the lifecycle: a component whose root is another's rides that one's (`delegateLifecycle`). */
  L?: (element: Element, connect: () => () => void, handle: unknown) => void;
  /** Components whose root is this one's, which inspection and serialization report with it. */
  D?: GeneratedInstance[];
  /** How many of its owners were released since the list was last compacted. */
  x?: number;
  /** Its root values, as attaching set them. */
  readonly v?: unknown[];
  /** `host.data`, set before attaching by a component that declares reads (`dataHandles`). */
  readonly A?: object;
  /** A context provider's readers, told after each of its renders. */
  R?: Set<(changed: number, dirty: ReadonlyMap<unknown, 1 | 2> | undefined) => void>;
  /** The projected nodes and the slot each is for, set before attaching, and `host.slots` over them. */
  readonly J?: Projection;
  readonly Y?: Readonly<Record<string, readonly Element[]>>;
}

/** Each projected node and the name of the slot it is for (`""` for the unnamed slot). */
export type Projection = readonly [node: Node, slot: string][];

/** Each top-level projected node's projection entry, which follows an invoked component's root. */
const projectedEntries = new WeakMap<Node, [Node, string]>();
/** Components invoked in projected content no slot has placed yet, by the top-level projected node holding them. */
const waiting = new WeakMap<Node, Map<Node, () => void>>();

function follows(previous: Node, root: Node): void {
  const entry = projectedEntries.get(previous);
  if (entry === undefined) return;
  entry[0] = root;
  projectedEntries.set(root, entry);
  markProjectedRoot(root);
}

/**
 * Whether a component invoked in projected content may be created: once a rendered slot has placed
 * the projected node holding it, as live lowering waits for a slot to render it. Hidden content gets
 * no instance or bindings; until then `realize` waits for a slot to place that node.
 */
export function placed(site: Node, realize: () => void): boolean {
  // The projected node holding the site; before its component has it, the node under the projection's fragment.
  let top = site;
  for (let node: Node | null = site; node !== null && node.nodeType !== 11; node = node.parentNode) {
    top = node;
    if (projectedEntries.has(node)) break;
  }
  const parent = top.parentNode;
  if (projectedEntries.has(top) && parent !== null && parent.nodeType !== 11) return true;
  let pending = waiting.get(top);
  if (pending === undefined) waiting.set(top, pending = new Map());
  pending.set(site, realize);
  return false;
}

/**
 * A factory's projection, as the live runtime takes a factory's: `children` for the unnamed slot,
 * then each named slot's nodes; strings become text and elements are marked projected.
 */
export function project(
  instance: { J?: Projection; Y?: Readonly<Record<string, readonly Element[]>> },
  children: readonly (string | Node)[], slots: Readonly<Record<string, readonly (string | Node)[]>>,
): Projection {
  const projected: [Node, string][] = [];
  for (const [name, nodes] of [["", children], ...Object.entries(slots)] as const) {
    for (const child of nodes) {
      const node = typeof child === "string" ? document.createTextNode(child) : child;
      markProjectedRoot(node);
      const entry: [Node, string] = [node, name];
      projected.push(entry);
      projectedEntries.set(node, entry);
    }
  }
  // A consumer's <template slot> lists the elements its outlets render now, in document order (none
  // while the instance is disconnected); any other projected element lists itself.
  const into = (key: string): Element[] => projected
    .filter(([node, name]) => node.nodeType === 1 && name === (key === "default" ? "" : key))
    .flatMap(([node]) => {
      const template = scopedTemplates.get(node as Element);
      if (template === undefined) return [node as Element];
      if ((instance as GeneratedInstance).c?.() !== true) return [];
      const ranges = [...template.l].flatMap((record) => record.r?.[0].isConnected === true ? [record.r] : [])
        .sort(([left], [right]) => left.compareDocumentPosition(right) & 4 ? -1 : 1);
      return ranges.flatMap(([start, end]) => {
        const elements: Element[] = [];
        for (let current = start.nextSibling; current !== null && current !== end; current = current.nextSibling) {
          if (current.nodeType === 1) elements.push(current as Element);
        }
        return elements;
      });
    });
  // A host lists the elements a slot was given, in order; `default` reads the unnamed slot.
  instance.Y = new Proxy({}, {
    get: (_target, key) => typeof key === "string" ? into(key) : undefined,
    has: (_target, key) => typeof key === "string" && into(key).length > 0,
  });
  return instance.J = projected;
}

/**
 * A rendering of a consumer's slot template: its nodes, the slot's prop values it reads, and the
 * range markers its outlet put it between.
 */
export interface ScopedRecord { readonly n: Node; readonly s: Record<string, unknown>; z?: (() => void)[]; r?: readonly [ChildNode, ChildNode] }

/** A consumer's compiled scoped-slot template: makes a rendering, patches one, and holds the live ones. */
export interface ScopedTemplate {
  readonly m: (dirty: Map<unknown, 1 | 2>, props: Record<string, unknown>) => ScopedRecord;
  readonly p: (record: ScopedRecord, changed: number, dirty: Map<unknown, 1 | 2>) => void;
  readonly l: Set<ScopedRecord>;
}

const scopedTemplates = new WeakMap<Element, ScopedTemplate>();

/** Registers a consumer's compiled template on its `<template slot>` carrier, which the slot it is projected into finds. */
export function scopedTemplate(carrier: Element, template: ScopedTemplate): ScopedTemplate {
  scopedTemplates.set(carrier, template);
  return template;
}

/**
 * Renders a slot between its placeholders as the live runtime renders one: the nodes projected into
 * it, or its fallback, between rendered-form marks; a slot with neither leaves one marker. A scoped
 * slot (`props`) renders the consumer's `<template slot>` with its props instead of moving it.
 * Returns the node its fallback goes before, when the fallback renders, or a scoped rendering.
 */
export function fillSlot(
  start: ChildNode, end: ChildNode, name: string, projected: Projection, fallback: boolean,
  props?: Record<string, unknown>, dirty?: Map<unknown, 1 | 2>,
): ChildNode | readonly [ScopedTemplate, ScopedRecord] | undefined {
  const doc = start.ownerDocument!;
  const assigned = projected.filter((entry) => entry[1] === name).map(([node]) => node);
  const slot = `slot="${name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"`;
  let rendered: readonly [ScopedTemplate, ScopedRecord] | undefined;
  // A slot with props, or one given a consumer's <template slot>, renders that template afresh,
  // in the consumer's scope; any other content given to it does not render.
  const carrier = assigned.find((node) => node.nodeType === 1 && (node as Element).localName === "template");
  if (props !== undefined && assigned.length > 0 || carrier !== undefined) {
    if (carrier === undefined) fail("HR007", `Scoped slot \`${name}\` requires a consumer <template slot="${name}">.`);
    const template = scopedTemplates.get(carrier as Element);
    if (template === undefined) fail("HR007", "Scoped projection requires the live delivery's parser or a compiled consumer template.");
    const record = template.m(dirty ?? new Map(), props ?? {});
    for (const node of Array.from(record.n.childNodes)) markProjectedRoot(node);
    template.l.add(record);
    rendered = [template, record];
  }
  // A range rendered from a template, or a slot that exposes props, is marked scoped.
  const scoped = rendered === undefined && props === undefined ? "" : ' scoped=""';
  const nodes = rendered === undefined ? assigned.length : rendered[1].n.childNodes.length;
  if (nodes === 0 && !fallback || rendered !== undefined && nodes === 0) {
    start.replaceWith(renderedFormMark(doc, "marker", slot));
    end.remove();
    return rendered;
  }
  const close = renderedFormMark(doc, "end", "") as ChildNode;
  const open = renderedFormMark(doc, "start", assigned.length === 0 ? `${slot} fallback=""${scoped}` : `${slot}${scoped}`) as ChildNode;
  start.replaceWith(open);
  end.replaceWith(close);
  if (assigned.length === 0) return close;
  if (rendered !== undefined) {
    rendered[1].r = [open, close];
    close.before(rendered[1].n);
  }
  else {
    close.before(...assigned);
    // Components invoked in the nodes this slot now places are created, as live lowers them now.
    for (const node of assigned) {
      const pending = waiting.get(node);
      if (pending === undefined) continue;
      waiting.delete(node);
      for (const realize of pending.values()) realize();
    }
  }
  return rendered;
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

/** A two-way binding on an invoked component, listening on its root and following it through a root switch. */
export function bindRootControl(instance: GeneratedInstance, child: GeneratedInstance, path: () => readonly unknown[] | undefined): () => void {
  const effect = createEffect(instance.q, () => {
    trackProperty(child, "e");
    const root = child.e;
    return untracked(() => bindControl(instance, root, path));
  }, 2, instance.c());
  instance.o.push(effect);
  return () => release(instance, effect);
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
 * Stops an owner a removed row or region held, and lets the instance drop it: released owners are
 * compacted out once they are half the list, so creating and removing rows retains nothing.
 */
function release(instance: GeneratedInstance, effect: ReactiveEffect): void {
  effect.stop();
  const owners = instance.o;
  instance.x = (instance.x ?? 0) + 1;
  if (instance.x * 2 < owners.length) return;
  instance.x = 0;
  let kept = 0;
  for (const owner of owners) if (!(owner as Partial<ReactiveEffect>).stopped) owners[kept++] = owner;
  owners.length = kept;
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
  return () => release(instance, effect);
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

/** A name nothing in scope provides, read in a consumer's scoped-slot template: HB001, as live's evaluation fails. */
export function undeclared(name: string): never {
  fail("HB001", `\`${name}\` is not declared in scope.`);
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
      // A symbol is never a name, so indexOf answers -1 for it.
      const index = names.indexOf(key as string);
      if (index < 0) return undefined;
      trackProperty(roots, key);
      if (index < writable) return wrap(values[index], types[index]!, undefined, key);
      channel!.w.add(index);
      // A computed or context is read-only, nested writes too, as live's host gives it.
      return spec.r!(spec, channel!.g(index), key as string);
    },
    set: (_target, key, value) => {
      const index = names.indexOf(key as string);
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
    has: (_target, key) => names.includes(key as string),
  });
  const denyData = (key: PropertyKey): void => readOnly(`data.${String(key)}`);
  const data = handle.A ?? new Proxy({}, {
    get: () => undefined,
    set: (_target, key) => (denyData(key), true),
    deleteProperty: (_target, key) => (denyData(key), true),
    defineProperty: (_target, key) => (denyData(key), false),
    has: () => false,
  });
  // The live host reads refs from an ordinary object, so inherited names answer as they do there.
  const recorded: Record<string, unknown> = {};
  const host = Object.freeze({
    // A root switch replaces the element, so the root is read where it is now, and tracked.
    get root(): Element { trackProperty(handle, "e"); return handle.e; },
    get element(): Element { trackProperty(handle, "e"); return handle.e; },
    state,
    data,
    on(type: string, callback: (event: Event) => void | (() => void)) {
      let stopped = false;
      const stop = host.effect(() => {
        if (type === "connect") return untracked(() => callback(new Event(type))) as void | (() => void);
        if (type === "disconnect") return () => { if (!stopped) untracked(() => callback(new Event(type))); };
        const listener = (event: Event): void => { callback(event); };
        const target: Element = host.root;
        target.addEventListener(type, listener);
        return () => target.removeEventListener(type, listener);
      });
      return () => { stopped = true; stop(); };
    },
    props: handle.B?.h ?? Object.freeze(Object.create(null) as object),
    refs: new Proxy({}, {
      get: (_target, key) => typeof key === "string" ? (spec.z ?? Reflect.get)(recorded, key) : undefined,
      has: (_target, key) => typeof key === "string" && recorded[key] !== undefined,
    }),
    slots: handle.Y ?? new Proxy({}, {
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
    dispatch: (event: string, detail?: unknown): boolean => (spec.x ?? dispatchUndeclared)(handle.e, event, detail, spec.d?.[event]),
  });
  // The handle is the lifecycle record too: inspection and serialization read its values and host.
  Object.assign(handle, { S: spec, s: state, q: scheduler, o: entries, r: recorded, c: () => connected, p: (value: object) => wrap(value, 0, undefined, ""), w: assign, v: values, H: host, e: root });
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
  // A delegated root's lifecycle rides the component that owns the element (`L`); otherwise its own.
  (handle.L ?? manageIndexedLifecycle)(handle.e, () => {
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
  }, handle);
  return handle;
}
