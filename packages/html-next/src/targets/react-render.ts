/**
 * The rendering module converted React components share: the helpers their markup renders and
 * binds values with, and the checks their handlers write through. They are the same for every
 * component, so they ship once beside the components rather than inside each one; a bundler keeps
 * only the ones a component imports. Preact output reuses these with its compatibility API.
 */
import type { GeneratedArtifact } from "../generate.js";
import { NATIVE_VALUE_ATTRIBUTE, nativeValueCss } from "../native-value.js";
import { closureFreeFunctionSource } from "./format-source.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";
import { formatReact } from "./vue-format.js";
import { expressionHelpersSource } from "./vue-lowering.js";

/** Where the module sits, relative to the package root, and how a component imports it. */
export const REACT_RENDER_PATH = "react/render.tsx";
export const REACT_RENDER_SPECIFIER = "./render";

const source = (preact = false): string => `import React from "react";
import type { ReactNode } from "react";
${preact ? 'import { createElement as nativeElement } from "preact";' : ""}

${expressionHelpersSource()}

/** React removes a node from its declared parent even when a controller has temporarily moved it. */
export function rememberParent(element: Element | null): () => void {
  const parent = element?.parentNode;
  const next = element?.nextSibling;
  return () => {
    if (parent && element && element.parentNode !== parent) parent.insertBefore(element, next?.parentNode === parent ? next : null);
  };
}

export function useOwnedRootRef<T extends Element>(root: { current: T | null }): (element: T | null) => () => void {
  return React.useCallback(element => {
    root.current = element;
    const restore = rememberParent(element);
    return () => { restore(); root.current = null; };
  }, [root]);
}

/** Publish native handles only when the consumer or native root changes. */
export function useRootHandle<T extends Element>(root: { current: T | null }, ref: React.Ref<T> | undefined): void {
  const previous = React.useRef<{ element: T | null; ref: React.Ref<T> | undefined } | undefined>(undefined);
  const dispose = React.useRef<(() => void) | undefined>(undefined);
  React.useLayoutEffect(() => () => {
    dispose.current?.(); dispose.current = undefined; previous.current = undefined;
  }, []);
  React.useLayoutEffect(() => {
    const element = root.current;
    if (previous.current?.element === element && previous.current?.ref === ref) return;
    dispose.current?.(); dispose.current = undefined;
    previous.current = { element, ref };
    if (!ref || !element) return;
    if (typeof ref === "function") {
      const cleanup = ref(element);
      dispose.current = typeof cleanup === "function" ? cleanup : () => { ref(null); };
    } else {
      ref.current = element;
      dispose.current = () => { ref.current = null; };
    }
  });
}

/** Structured prop metadata keeps its initial value; rendered bindings read current inputs. */
export function useReflectedProp(): (name: string, value: unknown) => string | undefined {
  const structured = React.useRef<Map<string, string> | undefined>(undefined);
  return (name, value) => {
    if (value == null) return undefined;
    if (typeof value !== "object") return String(value);
    const values = structured.current ??= new Map<string, string>();
    if (!values.has(name)) values.set(name, JSON.stringify(value));
    return values.get(name);
  };
}

/**
 * React state a handler reads and writes in step order, as HTML Next handlers do: a write is the
 * next read's value at once, before React renders it. The setter takes a value or an updater.
 * With \`written\`, a write that changes the value records the state's name and the path below it
 * that the write changed, for a controller host to read.
 */
export function useLiveState<T>(initial: T, written?: unknown[][], name?: string): readonly [T, (next: T | ((previous: T) => T), path?: readonly unknown[]) => void, () => T, (notify: () => void) => () => void, () => void] {
  const [value, setValue] = React.useState<T>(initial);
  const latest = React.useRef<{ value: T; revision: number; listeners?: Set<() => void>; subscribe?: (notify: () => void) => () => void; touch?: () => void }>({ value, revision: 0 });
  const base = latest.current.revision;
  React.useLayoutEffect(() => { if (latest.current.revision === base) latest.current.value = value; });
  const set = React.useCallback((next: T | ((previous: T) => T), path: readonly unknown[] = []) => {
    const current = latest.current;
    const previous = current.value;
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
    current.value = resolved;
    if (!Object.is(previous, resolved)) { current.revision++; for (const notify of current.listeners ?? []) notify(); }
    setValue(() => resolved);
    if (written !== undefined && !Object.is(previous, resolved)) written.push([name, ...path]);
  }, []);
  const get = React.useCallback(() => latest.current.value, []);
  const subscribe = latest.current.subscribe ??= (notify: () => void): (() => void) => { (latest.current.listeners ??= new Set()).add(notify); return () => { latest.current.listeners?.delete(notify); }; };
  const touch = latest.current.touch ??= (): void => { const current = latest.current; current.revision++; for (const notify of current.listeners ?? []) notify(); };
  return [value, set, get, subscribe, touch];
}

/** Equal props, with style compared entry by entry: a control with them commits nothing. Its initial default only seeds it. */
function sameControlProps(previousProps: object, nextProps: object): boolean {
  const [previous, next] = [previousProps as Readonly<Record<string, unknown>>, nextProps as Readonly<Record<string, unknown>>];
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return false;
  return keys.every((key) => {
    if (key === "htmlNextInitial") return true;
    const [before, after] = [previous[key], next[key]];
    if (key !== "style" || before === null || after === null || typeof before !== "object" || typeof after !== "object") return Object.is(before, after);
    const entries = Object.entries(after);
    return entries.length === Object.keys(before).length && entries.every(([name, value]) => Object.is((before as Record<string, unknown>)[name], value));
  });
}
interface ControlDefaults { readonly htmlNextDefault?: "defaultValue" | "defaultChecked"; readonly htmlNextAuthored?: unknown; readonly htmlNextInitial?: unknown }
/** A bound control renders its initial default, then switches to its authored one as it mounts, rendering only itself. */
function useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial }: ControlDefaults): Record<string, unknown> {
  ${preact ? 'const initial = React.useRef(htmlNextInitial);\n  return htmlNextDefault === undefined ? {} : { [htmlNextDefault]: htmlNextDefault === "defaultChecked" ? initial.current : htmlNextInitial };' : `const mounted = React.useRef(false);
  const [, settle] = React.useReducer((revision: number) => revision + 1, 0);
  React.useLayoutEffect(() => { if (htmlNextDefault !== undefined) { mounted.current = true; settle(); } }, []);
  return htmlNextDefault === undefined || htmlNextDefault === "defaultChecked" && mounted.current ? {} : { [htmlNextDefault]: mounted.current ? htmlNextAuthored : htmlNextInitial };`}
}
/** Inputs and textareas render through these, so React DOM, which rewrites an input's name and type and a textarea's default whenever it commits one, commits nothing to them on an unrelated render. */
export const HtmlNextInput = React.memo(({ htmlNextDefault, htmlNextAuthored, htmlNextInitial, ...props }: React.ComponentProps<"input"> & ControlDefaults) =>
  <input {...props} {...useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial })} />, sameControlProps);
export const HtmlNextTextarea = React.memo(({ htmlNextDefault, htmlNextAuthored, htmlNextInitial, ...props }: React.ComponentProps<"textarea"> & ControlDefaults) =>
  <textarea {...props} {...useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial })} />, sameControlProps);

${preact ? "" : `/** Native value attributes retain the browser's dirty-value flag and textarea attribute semantics. */
${closureFreeFunctionSource(nativeValueCss, "nativeValueCss")}
function useValueAttribute<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(value: unknown, ref: React.Ref<T> | undefined, style?: React.CSSProperties): { ref: React.RefObject<T | null>; style?: React.CSSProperties } {
  const root = React.useRef<T | null>(null);
  let represented = style;
  const restored: [string, string][] = [];
  for (const [name, authored] of Object.entries(style ?? {})) {
    if (typeof authored !== "string") continue;
    const rewritten = nativeValueCss(authored, ${JSON.stringify(NATIVE_VALUE_ATTRIBUTE)});
    if (rewritten === authored) continue;
    if (represented === style) represented = { ...style };
    (represented as Record<string, unknown>)[name] = rewritten;
    restored.push([name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()).replace(/^ms-/, "-ms-"), authored]);
  }
  React.useLayoutEffect(() => {
    if (value == null) root.current?.removeAttribute("value");
    else root.current?.setAttribute("value", String(value));
    root.current?.removeAttribute(${JSON.stringify(NATIVE_VALUE_ATTRIBUTE)});
  }, [value]);
  React.useLayoutEffect(() => {
    for (const [name, authored] of restored) root.current?.style.setProperty(name, authored);
  });
  useRootHandle(root, ref);
  return { ref: root, style: represented };
}
export const HtmlNextValueInput = /* @__PURE__ */ React.memo(({ htmlNextValue, htmlNextDefault, htmlNextAuthored, htmlNextInitial, ref, ...props }: React.ComponentProps<"input"> & ControlDefaults & { readonly htmlNextValue?: unknown }) =>
  <input {...props} ref={useValueAttribute<HTMLInputElement>(htmlNextValue, ref).ref} defaultValue={typeof document === "undefined" && htmlNextValue != null ? String(htmlNextValue) : undefined} {...useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial })} />, sameControlProps);
interface NativeTextareaProps extends React.ComponentPropsWithoutRef<"textarea"> { readonly htmlNextRoot: React.RefObject<HTMLTextAreaElement | null> }
/** React rewrites an uncontrolled textarea's default on every commit. Snapshot controller-owned defaults before that mutation. */
const NativeTextarea = /* @__PURE__ */ (() => class extends React.Component<NativeTextareaProps, {}, string | null> {
  private committedChildren = this.props.children;
  componentDidMount(): void { this.committedChildren = this.props.children; }
  getSnapshotBeforeUpdate(previous: NativeTextareaProps): string | null {
    return previous.defaultValue === this.props.defaultValue && previous.children === this.props.children
      ? this.props.htmlNextRoot.current?.defaultValue ?? null : null;
  }
  componentDidUpdate(_previous: NativeTextareaProps, _state: {}, nativeDefault: string | null): void {
    const element = this.props.htmlNextRoot.current;
    if (element && nativeDefault !== null && element.defaultValue !== nativeDefault) element.defaultValue = nativeDefault;
    this.committedChildren = this.props.children;
  }
  render(): ReactNode {
    const { htmlNextRoot, children, ...props } = this.props;
    const nativeDefault = props.defaultValue ?? (children !== this.committedChildren ? children : htmlNextRoot.current?.defaultValue ?? children);
    const defaultText = String(nativeDefault ?? "");
    return <textarea {...props} defaultValue={defaultText} ref={htmlNextRoot}
      onInput={event => { props.onInput?.(event); if (event.currentTarget.defaultValue !== defaultText) this.forceUpdate(); }}
      onChange={event => { props.onChange?.(event); if (event.currentTarget.defaultValue !== defaultText) this.forceUpdate(); }} />;
  }
})();
export const HtmlNextValueTextarea = /* @__PURE__ */ React.memo(({ htmlNextValue, htmlNextDefault, htmlNextAuthored, htmlNextInitial, ref, style, ...props }: React.ComponentProps<"textarea"> & ControlDefaults & { readonly htmlNextValue?: unknown }) => {
  const native = useValueAttribute<HTMLTextAreaElement>(htmlNextValue, ref, style);
  return <NativeTextarea {...props} ${NATIVE_VALUE_ATTRIBUTE}={htmlNextValue == null ? undefined : String(htmlNextValue)} htmlNextRoot={native.ref} style={native.style} {...useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial })} />;
}, sameControlProps);

export const HtmlNextValueSelect = /* @__PURE__ */ React.memo(({ htmlNextValue, ref, style, ...props }: React.ComponentProps<"select"> & { readonly htmlNextValue?: unknown }) =>
  <select {...props} ${NATIVE_VALUE_ATTRIBUTE}={htmlNextValue == null ? undefined : String(htmlNextValue)} {...useValueAttribute<HTMLSelectElement>(htmlNextValue, ref, style)} />, sameControlProps);
`}

${preact ? `/** The serializer cannot infer selection from the uppercase VALUE used for native attributes. */
function initialSelectOptions(children: ReactNode, value: unknown): ReactNode {
  const selected = new Set((Array.isArray(value) ? value : [value]).map(String));
  const serverOptions = (child: ReactNode): ReactNode => {
    if (Array.isArray(child)) return child.map(serverOptions);
    if (!React.isValidElement(child)) return child;
    const element = child as React.ReactElement<Record<string, any>>;
    const attributes = element.props;
    return React.cloneElement(element, element.type === "option"
      ? { selected: selected.has(String(attributes.VALUE ?? attributes.value ?? attributes.children ?? "")) }
      : { children: serverOptions(attributes.children) });
  };
  return serverOptions(children);
}
/** Preact's core select leaves option properties to the native binding helper after the first render. */
export function HtmlNextSelect({ htmlNextDefault, htmlNextAuthored, htmlNextInitial, ...props }: React.ComponentProps<"select"> & ControlDefaults): ReactNode {
  const initial = React.useRef(true);
  React.useLayoutEffect(() => { initial.current = false; }, []);
  return nativeElement("select", { ...props, ...(typeof document === "undefined" ? { children: initialSelectOptions(props.children, htmlNextInitial) } : {}), value: initial.current ? htmlNextInitial as React.SelectHTMLAttributes<HTMLSelectElement>["value"] : undefined });
}
` : ""}

/** Text that keeps its last accepted value while an expression is invalid. */
export function RetainedText({ value, text, accepts }: { readonly value: unknown; readonly text: string; readonly accepts?: () => boolean }): ReactNode {
  const accepted = value !== Symbol.for("html-next.invalid-result") && (accepts?.() ?? true);
  const last = React.useRef(accepted ? text : "");
  React.useLayoutEffect(() => { if (accepted) last.current = text; }, [accepted, text]);
  return accepted ? text : last.current;
}

/** A value that keeps its last accepted value while an expression is invalid, rendered through \`render\`. */
export function RetainedValue({ value, accepts, render }: { readonly value: unknown; readonly accepts?: (value: unknown) => boolean; readonly render: (value: any, hasValue: boolean) => ReactNode }): ReactNode {
  const accepted = value !== Symbol.for("html-next.invalid-result") && (accepts === undefined ? value !== undefined : accepts(value));
  const last = React.useRef<{ value: unknown; hasValue: boolean }>({ value: undefined, hasValue: false });
  React.useLayoutEffect(() => { if (accepted) last.current = { value, hasValue: true }; }, [accepted, value]);
  return render(accepted ? value : last.current.value, accepted || last.current.hasValue);
}

/** An \`<output>\` whose text React and the form's own resets both write, kept in step. */
export function OutputValue({ htmlNextValue, htmlNextText, htmlNextRetain, htmlNextAccepts = true, ref, ...attrs }: React.OutputHTMLAttributes<HTMLOutputElement> & { readonly htmlNextValue: unknown; readonly htmlNextText: string; readonly htmlNextRetain: boolean; readonly htmlNextAccepts?: boolean; readonly ref?: React.Ref<HTMLOutputElement> }): ReactNode {
  const accepted = !htmlNextRetain || (htmlNextValue !== undefined && htmlNextValue !== Symbol.for("html-next.invalid-result") && htmlNextAccepts);
  const last = React.useRef(accepted ? htmlNextText : "");
  const output = React.useRef<HTMLOutputElement | null>(null);
  const attach = React.useCallback((element: HTMLOutputElement | null) => {
    output.current = element;
    if (typeof ref === "function") {
      const cleanup = ref(element);
      return () => { output.current = null; if (typeof cleanup === "function") cleanup(); else ref(null); };
    }
    if (ref != null) (ref as { current: HTMLOutputElement | null }).current = element;
    return () => { output.current = null; if (ref != null) (ref as { current: HTMLOutputElement | null }).current = null; };
  }, [ref]);
  const shown = accepted ? htmlNextText : last.current;
  React.useLayoutEffect(() => {
    if (accepted) last.current = htmlNextText;
    if (output.current !== null && output.current.textContent !== shown) output.current.textContent = shown;
  });
  return <output {...attrs} ref={attach}>{shown}</output>;
}

/** A computed value; reading it while it computes is a cycle (HR006). */
export function cycleCheckedComputed<T>(evaluate: () => T, cache = true): { get(): T } {
  let reading = false;
  let ready = false;
  let cached!: T;
  return { get() {
    if (reading) {
      const message = "A reactive computed value depends on itself.";
      throw Object.assign(new Error(\`HR006: \${message}\`), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR006", message }) });
    }
    if (!cache || !ready) {
      reading = true;
      try { cached = evaluate(); ready = true; } finally { reading = false; }
    }
    return cached;
  } };
}

type KeyedRowsRender = () => ReactNode;
interface KeyedBoundaryState { readonly failed: boolean; readonly renderRows: KeyedRowsRender; }

/** A keyed list that produces a duplicate key (HR004) keeps its last committed rows. */
export class KeyedBoundary extends React.Component<{ readonly renderRows: KeyedRowsRender }, KeyedBoundaryState> {
  state: KeyedBoundaryState = { failed: false, renderRows: this.props.renderRows };
  private lastCommittedRender: KeyedRowsRender | undefined;
  static getDerivedStateFromProps(props: { readonly renderRows: KeyedRowsRender }, state: KeyedBoundaryState): Partial<KeyedBoundaryState> | null {
    return props.renderRows === state.renderRows ? null : { failed: false, renderRows: props.renderRows };
  }
  static getDerivedStateFromError(error: unknown): Partial<KeyedBoundaryState> {
    if ((error as { diagnostic?: { code?: string } } | null)?.diagnostic?.code !== "HR004") throw error;
    return { failed: true };
  }
  componentDidMount(): void { this.lastCommittedRender = this.props.renderRows; }
  componentDidUpdate(): void { if (!this.state.failed) this.lastCommittedRender = this.props.renderRows; }
  render(): ReactNode {
    return <KeyedRows renderRows={this.state.failed ? this.lastCommittedRender ?? (() => null) : this.props.renderRows} />;
  }
}
function KeyedRows(props: { readonly renderRows: KeyedRowsRender }): ReactNode { return props.renderRows(); }

export ${HOST_STATE_TOKENS_SOURCE.trim()}

/** A plain slot's content, or its fallback when the consumer passed none. */
export function renderPlainSlot(slot: ReactNode | ((props: Record<string, any>) => ReactNode) | undefined, fallback: ReactNode): ReactNode {
  if (typeof slot === "function") return null;
  return hasSlotContent(slot) ? markProjected(slot) : fallback;
}

function isElement(value: ReactNode): value is React.ReactElement<Record<string, unknown>> {
  return React.isValidElement(value);
}

function hasSlotContent(value: ReactNode): boolean {
  if (value == null || typeof value === "boolean" || value === "") return false;
  if (Array.isArray(value)) return value.some(hasSlotContent);
  if (isElement(value) && value.type === React.Fragment) {
    return hasSlotContent((value.props as { children?: ReactNode }).children);
  }
  return true;
}

/** A scoped slot rendered with its values; plain children cannot fill it (HR007). */
export function renderScopedSlot<T extends Record<string, unknown>>(slot: ReactNode | ((props: T) => ReactNode) | undefined, values: T, name: string, fallback: ReactNode): ReactNode {
  if (slot === undefined) return fallback;
  if (typeof slot !== "function") {
    const message = "Scoped slot \`" + name + "\` requires a consumer <template slot=\\"" + name + "\\">.";
    throw Object.assign(new Error(\`HR007: \${message}\`), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR007", message }) });
  }
  return markProjected(slot(values));
}

/** A React key for a value: an object keys by its identity, as live keys a list by \`Object.is\`. */
const identities = new WeakMap<object, string>();
let nextIdentity = 0;
export function identityKey(value: unknown): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  let key = identities.get(value);
  if (key === undefined) identities.set(value, key = "#" + nextIdentity++);
  return key;
}

/**
 * Columns as markup: what a consumer gave for one accepted child, which its parent keeps as one
 * stable entry while the key stays. The entry's getters read the latest props; the link carries the
 * child's slot content and, once the child renders, its context providers.
 */
type ChildDescriptor = { readonly key: string; readonly tag: string; readonly props: Readonly<Record<string, unknown>>; readonly slots?: Readonly<Record<string, unknown>> }
  // Content the slot does not accept, which the parent warns about under its own file.
  | { readonly leftOut: string; readonly message: string };
type ChildLink = {
  readonly tag: string; props: Readonly<Record<string, unknown>>; slots: Readonly<Record<string, unknown>> | undefined;
  wrap?: (content: ReactNode) => ReactNode; claims: Map<string, object>; readonly subscribe: (listener: () => void) => () => void; readonly listeners: Set<() => void>;
};
const childLinks = new WeakMap<object, ChildLink>();
/** A parent's entries by key, which its accepted children find theirs in. */
export const ChildEntries = React.createContext<ReadonlyMap<string, object> | undefined>(undefined);
const noSubscribe = (): (() => void) => () => {};

/** A component's \`as\` lists, by name, from the descriptors its consumer gave; each entry keeps its identity by key. */
export function useChildLists(given: unknown, names: readonly string[], file: string): { readonly lists: Readonly<Record<string, readonly object[]>>; readonly entries: ReadonlyMap<string, object> } {
  const kept = React.useRef(new Map<string, object>()).current;
  const descriptors = (given ?? {}) as Readonly<Record<string, readonly ChildDescriptor[] | undefined>>;
  const current = new Map<string, object>();
  const lists: Record<string, readonly object[]> = {};
  for (const name of names) lists[name] = Object.freeze((descriptors[name] ?? []).flatMap((descriptor) => {
    if ("leftOut" in descriptor) {
      warnUnless(false, file + "#" + descriptor.leftOut, (file === "" ? "" : file + ": ") + "HR007: " + descriptor.message);
      return [];
    }
    let entry = kept.get(descriptor.key);
    let link = entry === undefined ? undefined : childLinks.get(entry);
    if (link === undefined || link.tag !== descriptor.tag) {
      const listeners = new Set<() => void>();
      const made: ChildLink = { tag: descriptor.tag, props: descriptor.props, slots: descriptor.slots, claims: new Map(), listeners,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
      link = made;
      entry = Object.freeze(Object.create(null, Object.fromEntries(Object.keys(descriptor.props).map((prop) =>
        [prop, { get: () => made.props[prop], enumerable: true }]))) as object);
      childLinks.set(entry, made);
    }
    // Plain content is claimed afresh each render by the first outlet that places it.
    link.props = descriptor.props; link.slots = descriptor.slots; link.claims = new Map();
    current.set(descriptor.key, entry!);
    return entry!;
  }));
  kept.clear();
  for (const [key, entry] of current) kept.set(key, entry);
  return { lists, entries: kept };
}

/**
 * An accepted child gives its entry its context providers, so content its parent places through
 * \`<slot of>\` reads the child's contexts, then the parent's. Limit: an outlet that renders before the
 * child's own root reads the child's contexts only after the child commits, and not in server output.
 */
export function useEntryProviders(key: unknown, wrap: (content: ReactNode) => ReactNode): void {
  const entries = React.useContext(ChildEntries);
  const entry = typeof key === "string" ? entries?.get(key) : undefined;
  const link = entry === undefined ? undefined : childLinks.get(entry);
  if (link !== undefined) link.wrap = wrap;
  React.useLayoutEffect(() => { for (const listener of link?.listeners ?? []) listener(); });
}

/** Each accepted tag's slots: those its own template places, those with props, all it declares, and those names as text. */
export type ChildSlots = Readonly<Record<string, readonly [readonly string[], readonly string[], readonly string[], string]>>;

/**
 * \`<slot of="$column" name="cell">\`: the entry's child's \`<template slot>\` rendered with the outlet's
 * values, its plain content where its own template does not place it and no earlier outlet took it, or
 * the fallback.
 */
export function ChildSlot(props: {
  readonly entry: unknown; readonly name: string; readonly values?: Record<string, unknown>; readonly slots: ChildSlots; readonly file: string; readonly fallback: ReactNode;
  /** By accepted tag: the outlet's values checked and converted by that tag's slot declaration, as live's \`childSlotProps\`. */
  readonly shapes?: Readonly<Record<string, (values: Record<string, unknown>) => Record<string, unknown>>>;
}): ReactNode {
  const { entry, name, values, slots, file, fallback, shapes } = props;
  const prefix = file === "" ? "HR007: " : file + ": HR007: ";
  const link = entry !== null && typeof entry === "object" ? childLinks.get(entry) : undefined;
  const wrap = React.useSyncExternalStore(link?.subscribe ?? noSubscribe, () => link?.wrap, () => link?.wrap);
  const claim = React.useRef({}).current;
  if (link === undefined) return fallback;
  const known = slots[link.tag];
  const location = file + "#of:" + link.tag + ":" + name;
  if (known !== undefined && !known[2].includes(name)) {
    warnUnless(false, location, prefix + "\`" + link.tag + "\` declares the slots " + known[3] + "; \`" + name + "\` is unknown.");
    return fallback;
  }
  const slot = link.slots?.[name];
  let content: ReactNode;
  // A \`<template slot>\` renders afresh at every outlet; plain content renders at one.
  if (typeof slot === "function") content = (slot as (values: Record<string, unknown>) => ReactNode)(shapes?.[link.tag]?.(values ?? {}) ?? values ?? {});
  else if (!hasSlotContent(slot as ReactNode)) return fallback;
  else if (values !== undefined || known?.[1].includes(name) === true) {
    warnUnless(false, location + ":plain", prefix + "\`" + name + "\` has props, so its content is a \`<template slot=\\"" + name + "\\">\`.");
    return fallback;
  } else {
    if (known?.[0].includes(name) === true) return fallback;
    if (!link.claims.has(name)) link.claims.set(name, claim);
    if (link.claims.get(name) !== claim) return fallback;
    content = slot as ReactNode;
  }
  const placed = markProjected(content);
  return wrap === undefined ? placed : wrap(placed);
}

/** Projected elements carry \`data-slotted\`, which the component's \`:slotted()\` rules select. */
export function markProjected(value: ReactNode): ReactNode {
  // Several projected children keep their places as a fragment's arguments; returned as an array they would be a list needing keys.
  if (Array.isArray(value)) return React.createElement(React.Fragment, null, ...value.map(markProjected));
  if (!isElement(value)) return value;
  if (value.type === React.Fragment) {
    // A fragment's children keep their places as arguments; one array argument would be a list needing keys.
    const children = markProjected((value.props as { children?: ReactNode }).children);
    return Array.isArray(children) ? React.cloneElement(value, {}, ...children) : React.cloneElement(value, {}, children);
  }
  // The writing component's stamp stays, so its styles keep reaching the element.
  const element = value as React.ReactElement<Record<string, unknown>>;
  return React.cloneElement(element, { "data-slotted": element.props["data-slotted"] ?? "" });
}

/** A copy of a state value with one nested path written, or the same value when nothing changes. */
export function writeStatePath<T>(root: T, path: readonly unknown[], value: unknown): T {
  if (root === null || typeof root !== "object") return root;
  const result = Array.isArray(root) ? root.slice() : { ...root };
  let source: unknown = root;
  let target: unknown = result;
  for (const [index, segment] of path.entries()) {
    if (typeof segment !== "string" && typeof segment !== "number") return root;
    if (index === path.length - 1) {
      if (Object.is((source as Record<string | number, unknown>)[segment], value)) return root;
      (target as Record<string | number, unknown>)[segment] = value;
    }
    else {
      const next = (source as Record<string | number, unknown>)[segment];
      if (next === null || typeof next !== "object") return root;
      const copy = Array.isArray(next) ? next.slice() : { ...next };
      (target as Record<string | number, unknown>)[segment] = copy;
      source = next; target = copy;
    }
  }
  return result as T;
}
`;

/** Every name the module exports, which a component's own identifiers must not take. */
export const REACT_RENDER_EXPORTS: readonly string[] = [...source(true).matchAll(/^export (?:const|function|class) ([\w$]+)/gm)].map((match) => match[1]!);

export function reactRenderArtifact(version: string, target: "react" | "preact" = "react"): GeneratedArtifact {
  return Object.freeze({ path: REACT_RENDER_PATH, content: formatReact(`// Generated by HTML Next ${version} for React 19. Do not edit.\n${source(target === "preact")}`, "render.tsx") });
}
