/**
 * The rendering module converted React components share: the helpers their markup renders and
 * binds values with, and the checks their handlers write through. They are the same for every
 * component, so they ship once beside the components rather than inside each one; a bundler keeps
 * only the ones a component imports. Preact output reuses these with its compatibility API.
 */
import type { GeneratedArtifact } from "../generate.js";
import { REACT_PLAIN_SOURCE } from "./react-plain-source.js";
import { ROOT_METADATA_SOURCE } from "../generated/dom-attributes-source.js";
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
import { createPortal } from "react-dom";
${preact ? 'import { createElement as nativeElement } from "preact";' : ""}

${expressionHelpersSource()}
${ROOT_METADATA_SOURCE}

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
    dispose.current = bindRootHandle(element, ref);
  });
}

function bindRootHandle<T extends Element>(element: T | null, ref: React.Ref<T> | undefined): (() => void) | undefined {
  if (!ref || !element) return undefined;
  if (typeof ref === "function") {
    const cleanup = ref(element);
    return typeof cleanup === "function" ? cleanup : () => { ref(null); };
  }
  ref.current = element;
  return () => { ref.current = null; };
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
${preact ? `export const HtmlNextInput = /* @__PURE__ */ React.memo(({ htmlNextDefault, htmlNextAuthored, htmlNextInitial, ...props }: React.ComponentProps<"input"> & ControlDefaults) =>
  <input {...props} {...useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial })} />, sameControlProps);` : ""}
export const HtmlNextTextarea = /* @__PURE__ */ React.memo(({ htmlNextDefault, htmlNextAuthored, htmlNextInitial, ...props }: React.ComponentProps<"textarea"> & ControlDefaults) =>
  <textarea {...props} {...useControlDefaults({ htmlNextDefault, htmlNextAuthored, htmlNextInitial })} />, sameControlProps);

${preact ? "" : `type NativeInputAttributes = React.ComponentProps<"input"> & ControlDefaults & Readonly<Record<string, unknown>> & { readonly htmlNextValue?: unknown };
interface NativeInputProps { readonly htmlNextAttributes: NativeInputAttributes }
type NativeInputSnapshot = Partial<Record<'name' | 'type', string | null>> | null;
/** One input owner preserves controller edits before React commits its native fields. */
const NativeInput = /* @__PURE__ */ (() => class extends React.Component<NativeInputProps, {}, NativeInputSnapshot> {
  private readonly root = React.createRef<HTMLInputElement>();
  private mounted = false;
  private currentRef: React.Ref<HTMLInputElement> | undefined;
  private cleanup: (() => void) | undefined;
  private commit(previous?: NativeInputAttributes): void {
    const element = this.root.current;
    const attributes = this.props.htmlNextAttributes;
    if ('htmlNextValue' in attributes && (!previous || !Object.is(previous.htmlNextValue, attributes.htmlNextValue))) {
      if (attributes.htmlNextValue == null) element?.removeAttribute('value');
      else element?.setAttribute('value', String(attributes.htmlNextValue));
    }
    if (this.currentRef !== attributes.ref) {
      this.cleanup?.();
      this.currentRef = attributes.ref;
      this.cleanup = bindRootHandle(element, attributes.ref);
    }
  }
  componentDidMount(): void {
    this.commit();
    this.mounted = true;
    if (this.props.htmlNextAttributes.htmlNextDefault !== undefined) this.forceUpdate();
  }
  componentWillUnmount(): void {
    this.cleanup?.();
    this.cleanup = undefined;
    this.currentRef = undefined;
  }
  getSnapshotBeforeUpdate(previous: NativeInputProps): NativeInputSnapshot {
    const element = this.root.current;
    if (element === null) return null;
    const before = previous.htmlNextAttributes, after = this.props.htmlNextAttributes;
    let name = before.name === after.name ? element.getAttribute('name') : undefined;
    let type = before.type === after.type ? element.getAttribute('type') : undefined;
    if (name === (before.name == null ? null : String(before.name))) name = undefined;
    if (type === (before.type == null ? null : String(before.type))) type = undefined;
    return name === undefined && type === undefined ? null : { name, type };
  }
  componentDidUpdate(previous: NativeInputProps, _state: {}, attributes: NativeInputSnapshot): void {
    const element = this.root.current;
    if (element !== null && attributes !== null) for (const name of ['name', 'type'] as const) {
      const value = attributes[name];
      if (value === undefined || element.getAttribute(name) === value) continue;
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    }
    this.commit(previous.htmlNextAttributes);
  }
  render(): ReactNode {
    const { htmlNextValue, htmlNextDefault, htmlNextAuthored, htmlNextInitial, ref: _ref, ...props } = this.props.htmlNextAttributes;
    const defaults = htmlNextDefault === undefined || htmlNextDefault === 'defaultChecked' && this.mounted
      ? {} : { [htmlNextDefault]: this.mounted ? htmlNextAuthored : htmlNextInitial };
    return <input {...props} defaultValue={typeof document === 'undefined' && htmlNextValue != null ? String(htmlNextValue) : props.defaultValue} {...defaults} ref={this.root} />;
  }
})();
export const HtmlNextInput: React.NamedExoticComponent<NativeInputProps> = /* @__PURE__ */ React.memo(NativeInput, (before, after) => sameControlProps(before.htmlNextAttributes, after.htmlNextAttributes));
export const HtmlNextValueInput = HtmlNextInput;

/** Native value attributes retain the browser's dirty-value flag and textarea attribute semantics. */
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
export function RetainedText({ value, text, accepts }: { readonly value: unknown; readonly text: string | ((value: unknown) => string); readonly accepts?: () => boolean }): ReactNode {
  const accepted = acceptsBindingResult(value, accepts);
  const shown = accepted ? typeof text === "function" ? text(value) : text : "";
  const last = React.useRef(shown);
  React.useLayoutEffect(() => { if (accepted) last.current = shown; }, [accepted, shown]);
  return accepted ? shown : last.current;
}

/** A value that keeps its last accepted value while an expression is invalid, rendered through \`render\`. */
export function RetainedValue({ value, accepts, render }: { readonly value: unknown; readonly accepts?: (value: unknown) => boolean; readonly render: (value: any, hasValue: boolean) => ReactNode }): ReactNode {
  const accepted = acceptsBindingResult(value, accepts);
  const last = React.useRef<{ value: unknown; hasValue: boolean }>({ value: undefined, hasValue: false });
  React.useLayoutEffect(() => { if (accepted) last.current = { value, hasValue: true }; }, [accepted, value]);
  return render(accepted ? value : last.current.value, accepted || last.current.hasValue);
}

/** An \`<output>\` whose text React and the form's own resets both write, kept in step. */
export function OutputValue({ htmlNextValue, htmlNextText, htmlNextRetain, htmlNextAccepts = true, ref, ...attrs }: React.OutputHTMLAttributes<HTMLOutputElement> & { readonly htmlNextValue: unknown; readonly htmlNextText: string | ((value: unknown) => string); readonly htmlNextRetain: boolean; readonly htmlNextAccepts?: boolean; readonly ref?: React.Ref<HTMLOutputElement> }): ReactNode {
  const accepted = !htmlNextRetain || (acceptsBindingResult(htmlNextValue) && htmlNextAccepts);
  const next = accepted ? typeof htmlNextText === "function" ? htmlNextText(htmlNextValue) : htmlNextText : "";
  const last = React.useRef(next);
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
  const shown = accepted ? next : last.current;
  React.useLayoutEffect(() => {
    if (accepted) last.current = next;
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
${REACT_PLAIN_SOURCE}

export function renderPlainSlot(slot: ReactNode | ((props: Record<string, any>) => ReactNode) | undefined, fallback: ReactNode): ReactNode {
  if (typeof slot === "function") return markProjected(slot({}));
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
  wrap?: (content: ReactNode) => ReactNode;
  /** Replaced when the child gives new contexts or slots, which an outlet rendered before it reads again. */
  stamp?: object;
  plain?: Map<string, PlainFrame>; readonly subscribe: (listener: () => void) => () => void; readonly listeners: Set<() => void>;
};
const childLinks = new WeakMap<object, ChildLink>();
/** A new stable entry for one accepted child: its props' names are fixed, and reads go through its link. */
function childEntry(tag: string, props: Readonly<Record<string, unknown>>): object {
  const listeners = new Set<() => void>();
  const link: ChildLink = { tag, props, slots: undefined, listeners,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const entry = Object.freeze(Object.create(null, Object.fromEntries(Object.keys(props).map((prop) =>
    [prop, { get: () => link.props[prop], enumerable: true }]))) as object);
  childLinks.set(entry, link);
  return entry;
}
/**
 * What an accepting component's accepted children find in context. A compiled consumer gives every entry
 * up front, so its owner stays one object and holds no \`lists\`. Otherwise each render makes a new owner,
 * so every accepted child renders with it, in document order, and the wrapped ones (\`useChildEntry\`) take
 * their places in its lists. \`mounted\` and \`changed\` outlive the render; a render only commits through them.
 */
type ChildOwner = {
  readonly entries: ReadonlyMap<string, object>; readonly accepts: ChildListSlots; readonly parent: ChildOwner | undefined;
  readonly lists?: Readonly<Record<string, object[]>>; readonly at: Record<string, number>;
  readonly mounted: Set<object>; readonly changed: () => void;
  open: boolean; moved: boolean;
};
export const ChildEntries = React.createContext<ChildOwner | undefined>(undefined);
const noSubscribe = (): (() => void) => () => {};

/** An accepting component's lists: by \`as\` name, the slot it reads and the tags that slot accepts. */
type ChildListSlots = Readonly<Record<string, readonly [string, readonly string[]]>>;
/** A converted component's static mark: its tag, then its root component's tags for a preset, and its declared props' defaults. */
type ChildMark = { readonly tags: readonly string[]; readonly props: Readonly<Record<string, unknown>> };
const markedProps = (mark: ChildMark, given: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(mark.props).map(([prop, absent]) => [prop, given[prop] ?? absent]));

/**
 * A component's \`as\` lists, by name, with each entry keeping its identity by key, and each accepting
 * slot's content to render. A compiled consumer gives the descriptors; otherwise they come from the
 * slot's own content, whose accepted elements render with their entry's key. Those direct children are
 * in the list before the component renders. A list starts with them, and the wrapped children that were
 * mounted at the last commit in their places, and takes new wrapped children in place as the outlet
 * renders them, so content after the outlet reads it complete.
 */
export function useChildLists(given: unknown, lists: ChildListSlots, tag: string, file: string,
  props: { readonly children?: unknown; readonly slots?: Readonly<Record<string, unknown>> }): {
  readonly lists: Readonly<Record<string, readonly object[]>>; readonly entries: ChildOwner; readonly plainEntries: ReadonlyMap<string, object>; readonly content: Readonly<Record<string, ReactNode>>;
} {
  const parent = React.useContext(ChildEntries);
  const kept = React.useRef(new Map<string, object>()).current;
  const mounted = React.useRef(new Set<object>()).current;
  const committed = React.useRef<Readonly<Record<string, readonly object[]>>>({});
  const compiled = React.useRef<ChildOwner | undefined>(undefined);
  const rereading = React.useRef(false);
  const [, setRevision] = React.useState(0);
  const changed = React.useRef(() => { setRevision((revision) => revision + 1); }).current;
  const content: Record<string, ReactNode> = {};
  let descriptors = given as Readonly<Record<string, readonly ChildDescriptor[] | undefined>> | undefined;
  if (descriptors === undefined) {
    const derived: Record<string, ChildDescriptor[]> = {};
    for (const [name, [slot, accepts]] of Object.entries(lists)) {
      const supplied = (slot === "" ? props.children : props.slots?.[slot]) as ReactNode;
      content[slot] = typeof supplied === "function" ? supplied : childDescriptors(supplied, tag, slot, accepts, name, derived[name] = []);
    }
    descriptors = derived;
  } else for (const [name, [slot, accepts]] of Object.entries(lists)) {
    const supplied = (slot === "" ? props.children : props.slots?.[slot]) as ReactNode;
    content[slot] = typeof supplied === "function" ? supplied : childDescriptors(supplied, tag, slot, accepts, name, undefined);
  }
  const current = new Map<string, object>();
  const result: Record<string, object[]> = {};
  for (const name of Object.keys(lists)) {
    const direct = (descriptors[name] ?? []).flatMap((descriptor) => {
      if ("leftOut" in descriptor) {
        warnUnless(false, file + "#" + descriptor.leftOut, (file === "" ? "" : file + ": ") + "HR007: " + descriptor.message);
        return [];
      }
      let entry = kept.get(descriptor.key);
      if (entry === undefined || childLinks.get(entry)!.tag !== descriptor.tag) entry = childEntry(descriptor.tag, descriptor.props);
      const link = childLinks.get(entry)!;
      // Entries retain their source frames while their props and slot values change.
      link.props = descriptor.props; link.slots = descriptor.slots; preparePlain(link);
      current.set(descriptor.key, entry);
      return entry;
    });
    result[name] = given === undefined && mounted.size > 0 ? withMounted(direct, committed.current[name], mounted) : direct;
  }
  for (const entry of mounted) preparePlain(childLinks.get(entry)!);
  kept.clear();
  for (const [key, entry] of current) kept.set(key, entry);
  if (given !== undefined) for (const name of Object.keys(result)) Object.freeze(result[name]);
  const owner: ChildOwner = given !== undefined
    ? compiled.current ??= { entries: kept, accepts: lists, parent, at: {}, mounted, changed, open: false, moved: false }
    : { entries: kept, accepts: lists, parent, lists: result, at: {}, mounted, changed, open: true, moved: false };
  React.useLayoutEffect(() => {
    if (owner.lists === undefined) return;
    owner.open = false;
    committed.current = owner.lists;
    for (const list of Object.values(owner.lists)) Object.freeze(list);
    // Content before the outlet read the list before these children took their places: it reads again,
    // once, since a wrapped child's prop can be a new value at every render.
    rereading.current = owner.moved && !rereading.current;
    owner.moved = false;
    if (rereading.current) changed();
  });
  return { lists: result, entries: owner, plainEntries: kept, content };
}

/** Direct children, with the wrapped ones still mounted after the entry they last followed. */
function withMounted(direct: object[], last: readonly object[] | undefined, mounted: ReadonlySet<object>): object[] {
  let at = 0;
  for (const entry of last ?? []) {
    const index = direct.indexOf(entry);
    if (index >= 0) at = index + 1;
    else if (mounted.has(entry)) direct.splice(at++, 0, entry);
  }
  return direct;
}

/**
 * The descriptors a slot's own content gives, as a compiled consumer's would: one per accepted element
 * in content order, through arrays and fragments, keyed by its place and React key, with its declared
 * props resolved and its \`slots\`. Plain elements, text and presets are left out with a warning, and a
 * preset's root does not join the list. Any other component is the consumer's to render, and what it
 * renders joins through \`useChildEntry\`. The content returns with each accepted element given its
 * entry's key, so it finds its entry when it renders.
 */
function childDescriptors(content: ReactNode, tag: string, slot: string, accepts: readonly string[], as: string, descriptors: ChildDescriptor[] | undefined): ReactNode {
  const named = "\`" + tag + "\`'s " + (slot === "" ? "default slot" : "\`" + slot + "\` slot");
  const quoted = accepts.map((name) => "\`" + name + "\`");
  const listed = named + " accepts " + (quoted.length < 2 ? quoted.join("") : quoted.slice(0, -1).join(", ") + " and " + quoted.at(-1));
  const leftOut = (name: string, message: string): void => { descriptors?.push({ leftOut: tag + ":accepts:" + slot + ":" + name, message }); };
  const walk = (node: ReactNode, key: string): ReactNode => {
    if (Array.isArray(node)) return node.map((item: ReactNode, index) => walk(item, key + "." + (isElement(item) && item.key != null ? "$" + item.key : index)));
    if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
      if (/^[\\t\\n\\f\\r ]*$/.test(String(node))) return node;
      leftOut("#text", listed + "; this text is left out.");
      return null;
    }
    if (!isElement(node)) return node;
    if (node.type === React.Fragment) {
      const children = walk(node.props.children as ReactNode, key);
      return Array.isArray(children) ? React.cloneElement(node, {}, ...children) : React.cloneElement(node, {}, children);
    }
    const mark = (node.type as unknown as { readonly htmlNextChild?: ChildMark }).htmlNextChild;
    if (mark !== undefined && accepts.includes(mark.tags[0]!)) {
      descriptors?.push({ key, tag: mark.tags[0]!, props: markedProps(mark, node.props), slots: node.props.slots as Readonly<Record<string, unknown>> | undefined });
      return descriptors === undefined ? node : React.cloneElement(node, { htmlNextEntry: key });
    }
    const preset = mark?.tags.find((candidate) => accepts.includes(candidate));
    if (preset !== undefined) {
      leftOut(mark!.tags[0]!, "\`<" + mark!.tags[0]! + ">\` is a preset of \`" + preset + "\`, which " + named + " accepts; a preset among accepted children is not supported yet, so it is left out.");
      return React.createElement(ChildEntries, { key: node.key, value: undefined }, markProjected(node));
    }
    if (typeof node.type === "string") {
      leftOut(node.type, listed + "; this \`<" + node.type + ">\` is left out.");
      return null;
    }
    return node;
  };
  return walk(content, as + ":");
}

/**
 * An accepted child's place in its accepting parent's list. A direct child marks its place, and gives
 * its entry its context providers. Any other child, such as one inside the consumer's own wrapper
 * component, is wrapped: its stable entry joins the nearest ancestor that accepts its tag as the outlet
 * renders it, after the children rendered before it, and it counts as mounted only once it commits, so a
 * render React repeats or discards leaves nothing behind. A wrapped child that renders without its parent
 * tells the parent to render again, which reads every child's place and props afresh.
 * Limit: an outlet that renders before the child's own root reads the child's contexts only after the
 * child commits, and not in server output.
 */
export function useChildEntry(given: unknown, mark: ChildMark, props: Readonly<Record<string, unknown>>, wrap?: (content: ReactNode) => ReactNode): ChildLink | undefined {
  const nearest = React.useContext(ChildEntries);
  const own = React.useRef<{ entry?: object; owner?: ChildOwner }>({}).current;
  const tag = mark.tags[0]!;
  let entry = typeof given === "string" ? nearest?.entries.get(given) : undefined;
  let owner: ChildOwner | undefined;
  let name: string | undefined;
  if (entry !== undefined) {
    if (nearest!.open) {
      name = (given as string).slice(0, (given as string).indexOf(":"));
      nearest!.at[name] = nearest!.lists![name]!.indexOf(entry) + 1;
    }
  } else {
    for (owner = nearest; owner !== undefined; owner = owner.parent) {
      name = Object.keys(owner.accepts).find((list) => owner!.accepts[list]![1].includes(tag));
      if (name !== undefined) break;
    }
    if (owner?.lists === undefined) owner = undefined;
    else {
      const next = markedProps(mark, props);
      const slots = props.slots as Readonly<Record<string, unknown>> | undefined;
      entry = own.entry ??= childEntry(tag, next);
      const link = childLinks.get(entry)!;
      const same = Object.keys(next).every((prop) => Object.is(link.props[prop], next[prop]));
      if (link.slots !== slots) link.stamp = {};
      link.props = next; link.slots = slots;
      if (owner.open) {
        const list = owner.lists[name!]!;
        let at = owner.at[name!] ?? 0;
        const index = list.indexOf(entry);
        if (index >= 0) { list.splice(index, 1); if (index < at) at--; }
        list.splice(at, 0, entry);
        if (index !== at || !same) owner.moved = true;
        owner.at[name!] = at + 1;
      }
    }
  }
  const link = entry === undefined ? undefined : childLinks.get(entry);
  if (link !== undefined) preparePlain(link);
  if (link !== undefined && wrap !== undefined) { link.wrap = wrap; link.stamp = {}; }
  const inRender = owner?.open === true;
  const list = owner?.lists?.[name!];
  React.useLayoutEffect(() => {
    if (wrap !== undefined || owner !== undefined) for (const listener of link?.listeners ?? []) listener();
    if (owner === undefined) return;
    if (!inRender && own.owner === owner) owner.changed();
    own.owner = owner;
  });
  const mounted = owner?.mounted;
  React.useLayoutEffect(() => {
    if (mounted === undefined) return undefined;
    mounted.add(entry!);
    if (!list!.includes(entry!)) owner!.changed();
    return () => { mounted.delete(entry!); owner!.changed(); };
  }, [mounted]);
  return link;
}

/** Each accepted tag's slots: those its own template places, those with props, all it declares, and those names as text. */
export type ChildSlots = Readonly<Record<string, readonly [readonly string[], readonly string[], readonly string[], string]>>;

/**
 * \`<slot of="$column" name="cell">\`: the entry's child's \`<template slot>\` rendered with the outlet's
 * values, or the shared source for ordinary content. Own and borrowed outlets place that source once;
 * other outlets show their fallback.
 */
export function ChildSlot(props: {
  readonly entry: unknown; readonly name: string; readonly values?: Record<string, unknown>; readonly slots: ChildSlots; readonly file: string; readonly fallback: ReactNode;
  /** By accepted tag: the outlet's values checked and converted by that tag's slot declaration, as live's \`childSlotProps\`. */
  readonly shapes?: Readonly<Record<string, (values: Record<string, unknown>) => Record<string, unknown>>>;
}): ReactNode {
  const { entry, name, values, slots, file, fallback, shapes } = props;
  const prefix = file === "" ? "HR007: " : file + ": HR007: ";
  const link = entry !== null && typeof entry === "object" ? childLinks.get(entry) : undefined;
  React.useSyncExternalStore(link?.subscribe ?? noSubscribe, () => link?.stamp, () => link?.stamp);
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
  else if (values !== undefined || known?.[1].includes(name) === true) {
    if (!hasSlotContent(slot as ReactNode)) return fallback;
    warnUnless(false, location + ":plain", prefix + "\`" + name + "\` has props, so its content is a \`<template slot=\\"" + name + "\\">\`.");
    return fallback;
  } else {
    return <PlainSlot frame={linkedPlain(link, name)} content={slot as ReactNode} fallback={fallback} />;
  }
  const placed = markProjected(content);
  return link.wrap === undefined ? placed : link.wrap(placed);
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
