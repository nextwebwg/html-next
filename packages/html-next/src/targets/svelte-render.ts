/**
 * The rendering module converted Svelte components share: the helpers their markup renders and
 * binds values with, and the checks their handlers write through. They are the same for every
 * component, so they ship once beside the components rather than inside each one; a bundler keeps
 * only the ones a component imports. It is a `.svelte.ts` module because its attachments use runes.
 */
import type { GeneratedArtifact } from "../generate.js";
import { ROOT_METADATA_SOURCE } from "../generated/dom-attributes-source.js";
import { INPUT_STATUS_SOURCE } from "./shared-generated.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";
import { formatSvelteScript } from "./vue-format.js";
import { expressionHelpersSource } from "./vue-lowering.js";
import { SVELTE_PLAIN_SLOTS_SOURCE } from "./svelte-plain-source.js";

/** Where the module sits, relative to the package root, and how a component imports it. */
export const SVELTE_RENDER_PATH = "svelte/render.svelte.ts";
export const SVELTE_RENDER_SPECIFIER = "./render.svelte";

// Props converted components pass each other, which never reach the DOM. A NUL cannot appear in an
// authored HTML attribute or a declared public prop name.
export const SLOTS_PROP = "\0html-next:slots";
export const ROOT_OWNER_PROP = "\0html-next:root-owner";
export const BINDING_INPUTS_PROP = "\0html-next:binding-inputs";
export const LITERAL_INPUTS_PROP = "\0html-next:literal-inputs";
export const NATIVE_BINDINGS_PROP = "\0html-next:native-bindings";
/** A component's `as` lists, by slot (`childList`), and an accepted child's place in one (`ownChild`). */
export const LISTS_PROP = "\0html-next:lists";
export const ENTRY_PROP = "\0html-next:entry";
const INTERNAL_PROPS = [ROOT_OWNER_PROP, BINDING_INPUTS_PROP, LITERAL_INPUTS_PROP, SLOTS_PROP, LISTS_PROP, ENTRY_PROP];

/** Helpers a component calls by these names; the expression helpers come from its lowering. */
export const SVELTE_RENDER_COMPONENTS = ["formatValue", "isString", "isNumber", "isInteger", "isBoolean", "rootAttributes",
  "rootMetadata", "nativeAttributes", "retainedValue", "retainedStructuralValue", "writePath", "checkedSlot", "setProperty",
  "decorate", "hostStateTokens", "publishState", "injectContext", "reflectedProp", "childList", "childSlot", "ownChild", "acceptChildren", "usePlainSlots", "plainSnippet"] as const;

const SOURCE = `import { getContext, setContext, onDestroy, untrack, type Snippet } from "svelte";
import { PlainFrame, isPlainSnippet, type PlainInput } from "./plain.js";
export { plainSnippet } from "./plain.js";
${INPUT_STATUS_SOURCE}
${ROOT_METADATA_SOURCE}
import { createAttachmentKey } from "svelte/attachments";

/** Structured metadata retains its initial serialization while rendered bindings stay live. */
export function reflectedProp(): (name: string, value: unknown) => string | undefined {
  const initial = new Map<string, string>();
  return (name, value) => {
    if (value == null) return undefined;
    if (typeof value !== "object") return String(value);
    if (!initial.has(name)) initial.set(name, untrack(() => JSON.stringify(value)));
    return initial.get(name);
  };
}

${expressionHelpersSource()}

/**
 * Compose an authored attribute spread or the root's renderer records. Root records include
 * programmatic Svelte attachments and delegated native bindings. An authored spread can carry
 * style-scope classes and HTML attribute spellings safe for Svelte's property lookup.
 */
export function rootAttributes(rest: () => Record<string, unknown>, options: { metadataOnly?: boolean; scope?: string; forwardBindings?: boolean; omit?: readonly string[]; clientOmit?: readonly string[]; server?: () => Record<string, unknown> } = {}): () => Record<string, unknown> {
  const attach = createAttachmentKey();
  const prototype = (element: Element) => { if (options.metadataOnly) roots.add(element); };
  const attrs = $derived.by(() => {
    const props = rest();
    const attrs = Object.assign(Object.create(null) as Record<string | symbol, unknown>, options.metadataOnly ? rootMetadata(props) : props);
    if (options.metadataOnly) {
      for (const key of Object.getOwnPropertySymbols(props)) if (key.description === attach.description) attrs[key] = Reflect.get(props, key);
      if (options.forwardBindings && Object.hasOwn(props, ${JSON.stringify(NATIVE_BINDINGS_PROP)})) attrs[${JSON.stringify(NATIVE_BINDINGS_PROP)}] = props[${JSON.stringify(NATIVE_BINDINGS_PROP)}];
    }
    for (const name of [...${JSON.stringify(INTERNAL_PROPS)}, ...(options.forwardBindings ? [] : [${JSON.stringify(NATIVE_BINDINGS_PROP)}]), ...(options.omit ?? [])]) Reflect.deleteProperty(attrs, name);
    if (typeof document === "undefined") {
      for (const [name, value] of Object.entries(options.server?.() ?? {})) if (value !== undefined) attrs[name] = value;
    } else {
      for (const name of options.clientOmit ?? []) Reflect.deleteProperty(attrs, name);
    }
    if (options.scope !== undefined) attrs.class = [options.scope, props.class];
    attrs[attach] = prototype;
    // The attachment key is a symbol, which Svelte's element types leave out.
    return attrs as Record<string, unknown>;
  });
  return () => attrs;
}

const prototypeAttachment = createAttachmentKey();

/** Svelte's attribute alias table inherits prototype names; write those through the DOM after folding. */
export function nativeAttributes(input: Record<string, unknown>): Record<string, unknown> {
  let special: Map<string, unknown> | undefined;
  let attrs: Record<string | symbol, unknown> | undefined;
  for (const name in input) {
    if (!Object.hasOwn(input, name)) continue;
    const lower = name.toLowerCase();
    if (lower !== "constructor" && lower !== "__proto__") continue;
    special ??= new Map();
    attrs ??= Object.assign(Object.create(null) as Record<string | symbol, unknown>, input);
    special.set(lower, input[name]);
    Reflect.deleteProperty(attrs, name);
  }
  if (special === undefined || attrs === undefined) return input;
  const values = special;
  if (typeof document === "undefined") {
    for (const [name, value] of values) attrs[name] = value;
  } else attrs[prototypeAttachment] = (element: Element) => {
    for (const [name, value] of values) {
      if (value == null || value === false) element.removeAttribute(name);
      else element.setAttribute(name, value === true ? "" : String(value));
    }
    return () => { for (const name of values.keys()) element.removeAttribute(name); };
  };
  return attrs;
}

const roots = new WeakSet<Element>();

/** The root of the converted component an element is part of: the element or its nearest ancestor that is one. */
export function componentRoot(element: Element | null): Element | null {
  while (element !== null && !roots.has(element)) element = element.parentElement;
  return element;
}

/** A value that keeps its last accepted value while an expression is invalid. */
export function retainedValue<T>(initial: T): (candidate: unknown) => T {
  let previous = initial;
  return (candidate: unknown) => {
    if (!acceptsBindingResult(candidate)) return previous;
    previous = candidate as T;
    return previous;
  };
}

/** A structural value that keeps its last accepted value, and whether it has had one. */
export function retainedStructuralValue(): <T>(candidate: T | symbol) => { ready: boolean; value: T } {
  let ready = false;
  let previous: unknown;
  return function <T>(candidate: T | symbol) {
    if (acceptsBindingResult(candidate)) { ready = true; previous = candidate; }
    return { ready, value: previous as T };
  };
}

/** Writes one nested path of a state value in place, as Svelte's deep state expects; an unchanged value is not written. */
export function writePath(root: unknown, path: readonly unknown[], value: unknown): void {
  let target = root;
  for (const [index, key] of path.entries()) {
    if (typeof key !== "string" && typeof key !== "number" || target === null || typeof target !== "object") return;
    if (index === path.length - 1) { if (!Object.is((target as Record<string | number, unknown>)[key], value)) (target as Record<string | number, unknown>)[key] = value; }
    else target = (target as Record<string | number, unknown>)[key];
  }
}

/**
 * Publishes a state to the component's descendants, which read it with \`<context>\`. The getter
 * keeps every read current.
 */
export function publishState(tag: string, name: string, read: () => unknown, status?: () => InputStatus): void {
  setContext(\`html-next:\${tag}:\${name}\`, { get value() { return read(); }, get status() { return status?.() ?? READY_INPUT; } });
}

/** The state an ancestor component publishes; a reader with no such ancestor is HR009. */
export function injectContext<T>(reader: string, from: string, name: string): { readonly value: T; readonly status: InputStatus } {
  const context = getContext<{ readonly value: T; readonly status: InputStatus } | undefined>(\`html-next:\${from}:\${name}\`);
  if (context !== undefined) return context;
  const message = "<" + reader + "> requires context \u0060" + name + "\u0060 from <" + from + ">.";
  throw Object.assign(new Error("HR009: " + message), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR009", message }) });
}

/**
 * A child an \`as\` list holds: its tag, prop reads, each slot's snippet with the consumer's locals,
 * whether it renders at one outlet and whether it takes the slot props directly (a hand-written
 * consumer's snippet), and its contexts.
 */
interface ListedChild {
  readonly tag: string;
  props: Record<string, () => unknown>;
  slots: Record<string, readonly [snippet: Snippet<[any]>, locals: unknown, plain: boolean, nativeArguments?: boolean, present?: boolean]>;
  contexts?: Map<unknown, unknown>;
  /** The child's own resolved props, once it renders: an entry reads them, so it never disagrees with the child. */
  reads?: () => Readonly<Record<string, { readonly value: unknown }>>;
  readonly plain: Map<string, PlainFrame>;
  /** The elements outlets render for each slot, which the child's \`host.slots\` lists. */
  readonly placed: Map<string, Set<Element>>;
  readonly list: () => unknown;
}
type ListedItem = readonly [readonly unknown[], string, ListedChild["props"], ListedChild["slots"]] | string;
const listedChildren = new WeakMap<object, ListedChild>();
const reportedChildren = new Set<string>();
const objectKeys = new WeakMap<object, number>();
let nextObjectKey = 0;
/** Changes when an outlet renders or removes an element, so \`host.slots\` reads again. */
let placedChanged = $state(0);
${SVELTE_PLAIN_SLOTS_SOURCE}

/** A child's key in its list: its place among the consumer's children, then each enclosing \`$each\` key, objects by identity. */
function childKey(parts: readonly unknown[]): string {
  return parts.map((value) => {
    if (value === null || typeof value !== "object" && typeof value !== "function") return typeof value + ":" + String(value);
    let key = objectKeys.get(value);
    if (key === undefined) objectKeys.set(value, key = nextObjectKey++);
    return "object:" + key;
  }).join("/");
}

/**
 * A slot's \`as\` list (components#slot-accepts-as), which the consumer builds before the receiving
 * component renders: one stable, read-only entry per accepted child, in content order. \`build\` gives
 * each child its key parts, tag, prop reads and slot snippets, or a warning for content the slot leaves
 * out. An entry reads the child's own props once it renders, and the latest build's before then.
 */
export function childList(build: () => readonly unknown[]) {
  const children = new Map<string, readonly [object, ListedChild]>();
  onDestroy(() => { for (const [, child] of children.values()) for (const frame of child.plain.values()) frame.dispose(); });
  const list = $derived.by(() => {
    const next: object[] = [];
    const seen = new Set<string>();
    // The consumer's items are tuples TypeScript infers as arrays, so they are read as \`ListedItem\`s here.
    for (const item of build() as readonly ListedItem[]) {
      if (typeof item === "string") {
        if (!reportedChildren.has(item)) { reportedChildren.add(item); console.warn(item); }
        continue;
      }
      const [parts, tag, props, slots] = item;
      const key = childKey(parts);
      seen.add(key);
      let known = children.get(key);
      if (known === undefined) {
        const child: ListedChild = { tag, props, slots, plain: new Map(), placed: new Map(), list: () => list };
        const entry = Object.freeze(Object.create(null, Object.fromEntries(Object.keys(props).map((name) =>
          [name, { enumerable: true, get: () => { void list; const own = child.reads?.()[name]; return own === undefined ? child.props[name]!() : own.value; } }]))) as object);
        listedChildren.set(entry, child);
        children.set(key, known = [entry, child]);
      } else {
        known[1].props = props;
        known[1].slots = slots;
      }
      next.push(known[0]);
    }
    for (const [key, [, child]] of children) if (!seen.has(key)) {
      children.delete(key);
      queueMicrotask(() => { for (const frame of child.plain.values()) frame.dispose(); });
    }
    return Object.freeze(next);
  });
  return Object.assign(() => list, {
    own: (parts: readonly unknown[], contexts: Map<unknown, unknown>, reads?: ListedChild["reads"]): ListedChild | undefined => {
      void list;
      const known = children.get(childKey(parts));
      if (known === undefined) return undefined;
      known[1].contexts = contexts;
      known[1].reads = reads;
      return known[1];
    },
  });
}

/** What an accepted child gives a parent's list when its consumer builds none: its tag, props, \`slots\` snippets, and its root. */
interface OwnChild {
  readonly tag: string;
  readonly props: readonly string[];
  readonly slots: () => Readonly<Record<string, unknown>> | null | undefined;
  readonly root: () => Element | null | undefined;
}
type Accepting = (own: OwnChild, contexts: Map<unknown, unknown>, reads?: ListedChild["reads"]) => ListedChild | undefined;
const ACCEPTING = Symbol.for("html-next:accepting");

/**
 * A component's \`as\` lists by slot, from the compiled consumer's \`childList\` when it gives one
 * (\`given\`), and otherwise from the accepted children that join while they initialize (\`ownChild\`),
 * as a consumer written in the framework renders them through the slot's outlet. They join in content
 * order; once every root is connected the list follows their roots' document order, which a
 * MutationObserver on the roots' parents keeps current through a keyed move. On the server the list is
 * one array that fills as the outlet renders, so content after the outlet reads it complete.
 * ponytail: a child joins the first list that accepts its tag, so two \`as\` slots that accept one tag share it.
 */
export function acceptChildren(lists: Readonly<Record<string, readonly string[]>>, given: () => unknown) {
  type Joined = { readonly entry: object; readonly root: () => Element | null | undefined };
  const server = typeof document === "undefined";
  const joined: Record<string, Joined[]> = Object.fromEntries(Object.keys(lists).map((slot) => [slot, []]));
  const served: Record<string, object[]> = Object.fromEntries(Object.keys(lists).map((slot) => [slot, []]));
  let version = $state(0);
  let observer: MutationObserver | undefined;
  const ordered = Object.fromEntries(Object.keys(lists).map((slot) => {
    if (server) return [slot, () => served[slot]!];
    let previous: readonly object[] = Object.freeze([]);
    const list = $derived.by(() => {
      void version;
      const children = joined[slot]!.map((child) => [child, child.root()] as const);
      if (children.every(([, root]) => root?.isConnected)) children.sort(([, left], [, right]) => left!.compareDocumentPosition(right!) & 4 ? -1 : 1);
      const next = children.map(([child]) => child.entry);
      return next.length === previous.length && next.every((entry, index) => entry === previous[index]) ? previous : (previous = Object.freeze(next));
    });
    return [slot, () => list];
  }));
  $effect(() => () => observer?.disconnect());
  setContext(ACCEPTING, ((own, contexts, reads) => {
    const slot = Object.keys(lists).find((name) => lists[name]!.includes(own.tag));
    if (slot === undefined) return undefined;
    const child: ListedChild = { tag: own.tag, props: {}, contexts, reads, plain: new Map(), placed: new Map(), list: () => undefined,
      // A snippet renders afresh at each outlet, as a \`<template slot>\` does, and takes the slot props as they are.
      get slots() {
        return Object.fromEntries(Object.entries(own.slots() ?? {}).flatMap(([name, snippet]) =>
          typeof snippet === "function" ? [[name, [snippet as Snippet<[any]>, undefined, isPlainSnippet(snippet), true] as const]] : []));
      } };
    const entry = Object.freeze(Object.create(null, Object.fromEntries(own.props.map((name) =>
      [name, { enumerable: true, get: () => reads?.()[name]?.value ?? null }]))) as object);
    listedChildren.set(entry, child);
    onDestroy(() => { for (const frame of child.plain.values()) frame.dispose(); });
    if (server) { served[slot]!.push(entry); return child; }
    const place = { entry, root: own.root };
    joined[slot]!.push(place);
    untrack(() => version++);
    $effect(() => {
      const parent = own.root()?.parentNode;
      if (parent != null) (observer ??= new MutationObserver(() => version++)).observe(parent, { childList: true });
    });
    $effect(() => () => { joined[slot]!.splice(joined[slot]!.indexOf(place), 1); untrack(() => version++); });
    return child;
  }) satisfies Accepting);
  const compiled = () => given() as Record<string, (() => readonly object[]) | undefined> | undefined;
  return {
    list: (slot: string): readonly object[] => compiled()?.[slot]?.() ?? ordered[slot]!(),
    /** The roots of the children that joined, which the component's \`host.slots\` lists. */
    roots: (slot: string): Element[] => compiled() !== undefined ? [] : (joined[slot] ?? []).flatMap((child) => child.root() ?? []),
  };
}

/**
 * An accepted child's contexts and resolved props, given to the list that holds it (\`given\` is the list
 * and the child's key parts), so the content its parent places for it reads them before the parent's.
 * It gives back what the child's \`host.slots\` lists for each slot: the elements outlets render for it.
 */
export function ownChild(given: () => unknown, contexts: Map<unknown, unknown>, reads?: ListedChild["reads"], own?: OwnChild): ((name: string) => Element[]) & { child(): ListedChild | undefined } {
  let child = untrack(() => {
    const value = given();
    return Array.isArray(value) ? (value[0] as ReturnType<typeof childList>).own(value[1] as readonly unknown[], contexts, reads) : undefined;
  });
  // A consumer that builds no list, such as one written in Svelte, has the child join its accepting parent's.
  if (child === undefined && own !== undefined) child = getContext<Accepting | undefined>(ACCEPTING)?.(own, contexts, reads);
  return Object.assign((name: string) => {
    void placedChanged;
    return [...child?.placed.get(name) ?? []].sort((left, right) => left.compareDocumentPosition(right) & 4 ? -1 : 1);
  }, { child: () => child });
}

/**
 * \`<slot of>\`: what outlet \`outlet\` renders for slot \`name\` of the child \`entry\` lists: the snippet the
 * consumer gave and its arguments for the outlet's props, plus the child's contexts and tag;
 * nothing when the consumer gave none. Plain content renders at the first outlet that
 * renders it, and the next takes it over when that outlet goes; a \`<template slot>\` renders at each.
 * ponytail: an outlet that renders before the child's own instance (one placed before the child's root
 * in the parent's default outlet) has no child contexts yet, so its content reads the parent's.
 */
export function childSlot(entry: unknown, name: string, outlet: object, fallback?: Snippet): { readonly snippet: Snippet<[any]>; readonly args: (props: Record<string, unknown>) => unknown; readonly contexts: Map<unknown, unknown> | undefined; readonly tag: string } | undefined {
  const child = entry !== null && typeof entry === "object" ? listedChildren.get(entry) : undefined;
  if (child === undefined) return undefined;
  child.list();
  const slot = Object.hasOwn(child.slots, name) ? child.slots[name] : undefined;
  if (slot === undefined) return undefined;
  const place = childPlace(child, name);
  // A compiled consumer's snippet also takes its locals and the attachment that lists what it renders.
  const args = slot[3] === true ? (props: Record<string, unknown>) => props : (props: Record<string, unknown>) => ({ p: props, s: slot[1], a: place });
  return { snippet: slot[2] ? childPlainFrame(child, name).outlet(outlet, fallback) as Snippet<[any]> : slot[0], args, contexts: child.contexts, tag: child.tag };
}

function childPlace(child: ListedChild, name: string): (element: Element) => () => void {
  return (element: Element): (() => void) => {
    let placed = child.placed.get(name);
    if (placed === undefined) child.placed.set(name, placed = new Set());
    placed.add(element);
    untrack(() => placedChanged++);
    return () => { placed.delete(element); untrack(() => placedChanged++); };
  };
}

/** A scoped slot's snippet; plain children cannot fill it (HR007). */
export function checkedSlot<T>(slot: T | null | undefined, name: string): T | undefined {
  if (slot === null) {
    const message = "Scoped slot \\u0060" + name + "\\u0060 requires a consumer <template slot=\\"" + name + "\\">.";
    throw Object.assign(new Error("HR007: " + message), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR007", message }) });
  }
  return slot;
}

/** An attachment that keeps a DOM property in step with its value. */
export function setProperty(name: string, read: () => unknown) {
  return (element: Element) => {
    let initialized = false;
    $effect(() => {
      const value = read();
      if (value === Symbol.for("html-next.invalid-result")) return;
      // Native scroll setters run while live roots are detached and have no initial layout effect.
      const first = !initialized; initialized = true;
      if (first && (name === "scrollTop" || name === "scrollLeft")) return;
      Reflect.set(element, name, value);
    });
  };
}

/** An attachment that toggles classes and sets style properties from their values, writing only a result that differs from its last. */
export function decorate(decorations: readonly { readonly kind: "class" | "style" | "attribute"; readonly name: string; readonly read: () => unknown }[], options: { scope?: string; hashed?: boolean; ordered?: boolean } = {}) {
  return (element: Element) => {
    const scope = [options.scope, options.hashed ? element.getAttribute("class") : null].filter(Boolean).join(" ");
    if (options.ordered) {
      const previous: unknown[] = [];
      $effect(() => {
        const candidates = decorations.map(decoration => decoration.read());
        for (const [index, candidate] of candidates.entries()) if (candidate === Symbol.for("html-next.no-attribute") && index in previous) { element.removeAttribute(decorations[index]!.name === "style" ? "style" : "class"); delete previous[index]; }
        for (const [index, decoration] of decorations.entries()) {
          const candidate = candidates[index];
          if (candidate === Symbol.for("html-next.no-attribute")) continue;
          const value = candidate === Symbol.for("html-next.invalid-result") && index in previous ? previous[index] : candidate;
          if (value === Symbol.for("html-next.invalid-result")) continue;
          previous[index] = value;
          if (decoration.kind === "class") element.classList.toggle(decoration.name, Boolean(value));
          else if (decoration.kind === "attribute") {
            const attribute = decoration.name === "style" ? "style" : "class";
            const text = attribute === "style" || scope === "" ? value == null ? null : String(value) : value == null ? scope : String(value) + " " + scope;
            if (text == null) element.removeAttribute(attribute); else element.setAttribute(attribute, text);
          } else (element as HTMLElement).style.setProperty(decoration.name, value == null ? "" : String(value));
        }
      });
      return;
    }
    for (const decoration of decorations) {
      let last: unknown;
      $effect(() => {
        const value = decoration.read();
        if (value === Symbol.for("html-next.invalid-result")) return;
        const output = decoration.kind === "class" ? Boolean(value) : value == null ? decoration.kind === "attribute" ? null : "" : String(value);
        if (output === last) return;
        last = output;
        if (decoration.kind === "class") element.classList.toggle(decoration.name, output as boolean);
        else if (decoration.kind === "attribute") {
          const written = scope === "" ? output : output == null ? scope : String(output) + " " + scope;
          if (written == null) element.removeAttribute("class"); else element.setAttribute("class", String(written));
        } else (element as HTMLElement).style.setProperty(decoration.name, output as string);
      });
    }
  };
}

export ${HOST_STATE_TOKENS_SOURCE.trim()}
`;

/** Every name the module exports, which a component's own identifiers must not take. */
export const SVELTE_RENDER_EXPORTS: readonly string[] = [...SOURCE.matchAll(/^export (?:const|function|class) ([\w$]+)/gm)].map((match) => match[1]!).concat("plainSnippet");

export function svelteRenderArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: SVELTE_RENDER_PATH, content: formatSvelteScript(`// Generated by HTML Next ${version} for Svelte 5. Do not edit.\n${SOURCE}`, "render.svelte.ts") });
}
