/**
 * `componentRegistry`: creating and updating components from code
 * (https://nextwebwg.org/declarative-components/javascript#component-registry).
 *
 * Modeled on `customElements`. Every HTML Next bundle on a page (the live runtime, compiled modules
 * and framework helpers) keeps its definitions in one record on the document, so code can create
 * any registered component whichever bundle defined it. Each bundle registers how it creates and
 * updates its own instances; the methods here only route to them. Nothing reads `document` until a
 * method is called, so importing this module on a server is safe.
 */

/** A registered definition. Only its tag is specified. */
export interface ComponentDefinition {
  readonly tag: string;
}

export interface ComponentInit<Props = Readonly<Record<string, unknown>>> {
  /** The instance's props, as an invocation's attributes would set them. */
  readonly props?: Props;
  /** The nodes an invocation would contain: a fragment, or nodes and strings, as append() takes. */
  readonly content?: DocumentFragment | Iterable<Node | string>;
}

declare global {
  /** Each component adds its tag here, as HTMLElementTagNameMap does for createElement. */
  interface ComponentTagMap {}
}

type Props = Readonly<Record<string, unknown>>;

/** One registration; its shape is shared by every bundle, so its keys stay stable. */
export interface RegistryEntry {
  readonly d: ComponentDefinition;
  /** The declared prop names. */
  readonly p: readonly string[];
  /** Creates an instance's native root from checked props and its child nodes. */
  readonly c: (props: Props, nodes: readonly Node[]) => Element;
  /** What `define` compares to decide it is the same definition: its carrier, or a compiled factory. */
  readonly k: unknown;
}

/** An instance's prop channel, which checks the names and applies the inputs. */
export type PropChannel = (props: Props) => void;

interface RegistryRecord {
  readonly d: Map<string, RegistryEntry>;
  readonly w: Map<string, readonly [Promise<ComponentDefinition>, (definition: ComponentDefinition) => void]>;
  /** Each bundle's lookup of an instance's prop channel. */
  readonly i: Set<(element: Element) => PropChannel | undefined>;
  /** The live runtime's `define` and `upgrade`, present only where a live runtime is. */
  f?: (carrier: HTMLTemplateElement) => void;
  u?: (root: Node) => void;
  /** The live runtime's rendering of a `<template slot>` no compiled consumer registered. */
  t?: (carrier: HTMLTemplateElement, names: readonly string[]) => unknown;
}

const runtimeKey = Symbol.for("@nextwebwg/html-next.runtime.v1");

export function registryRecord(root: Document = document): RegistryRecord {
  const state = (root as Document & { [runtimeKey]?: { c?: RegistryRecord } })[runtimeKey] ??= {};
  return state.c ??= { d: new Map(), w: new Map(), i: new Set() };
}

export const domError = (message: string, name: string): DOMException => new DOMException(message, name);

const customElementOf = (root: Document, tag: string): unknown => root.defaultView?.customElements?.get(tag);

/**
 * Registers `entry` and resolves whoever waits for its tag. An existing registration stays unless
 * `replace` is set: the live runtime replaces a definition with a different one, and a compiled
 * module replaces another compiled module's, as evaluating a changed module does.
 */
export function registerEntry(root: Document, entry: RegistryEntry, replace: boolean): void {
  const record = registryRecord(root);
  const tag = entry.d.tag;
  if (record.d.has(tag) && !replace) return;
  record.d.set(tag, entry);
  record.w.get(tag)?.[1](entry.d);
  record.w.delete(tag);
}

/** `define`'s step 3, and step 4's test: true when `tag` is already registered by this same definition. */
export function checkDefinable(root: Document, tag: string, key: unknown, same?: (entry: RegistryEntry) => boolean): boolean {
  if (customElementOf(root, tag) !== undefined) throw domError(`<${tag}> is a registered custom element.`, "NotSupportedError");
  const existing = registryRecord(root).d.get(tag);
  return existing !== undefined && (existing.k === key || same?.(existing) === true);
}

/** The `TypeError` of `create` step 4 and `update` step 2, for a prop the definition does not declare. */
export function checkProps(names: readonly string[], props: Props, tag: string): void {
  for (const name of Object.keys(props)) {
    if (!names.includes(name)) throw new TypeError(`<${tag}> declares no prop \`${name}\`.`);
  }
}

/**
 * The registry. Its members are static operations that never read `this`, so
 * `const { create, update } = componentRegistry` works.
 */
export class ComponentRegistry {
  /** Register the definition a `<template component>` carries. */
  define(carrier: HTMLTemplateElement): void {
    if ((carrier as Element | null)?.localName !== "template" || !("content" in carrier) || !carrier.hasAttribute("component")) {
      throw new TypeError("define() takes a <template component> element.");
    }
    const define = registryRecord(carrier.ownerDocument).f;
    if (define === undefined) {
      throw domError("Defining from a <template component> requires the live runtime, which reads definitions.", "NotSupportedError");
    }
    define(carrier);
  }

  /** The definition registered for `tag`, or undefined. */
  get(tag: string): ComponentDefinition | undefined {
    return registryRecord().d.get(tag)?.d;
  }

  /** Resolves with the definition once `tag` is registered. */
  whenDefined(tag: string): Promise<ComponentDefinition> {
    const record = registryRecord();
    const entry = record.d.get(tag);
    if (entry !== undefined) return Promise.resolve(entry.d);
    let waiting = record.w.get(tag);
    if (waiting === undefined) {
      let resolve!: (definition: ComponentDefinition) => void;
      const defined = new Promise<ComponentDefinition>((done) => { resolve = done; });
      // The platform's own name check: `customElements.whenDefined` rejects an invalid custom element
      // name with a `SyntaxError`, and otherwise its promise is left to wait.
      const registry = document.defaultView?.customElements;
      const named = registry === undefined ? defined
        : Promise.race([registry.whenDefined(tag).then(() => defined), defined]);
      waiting = [named, resolve];
      record.w.set(tag, waiting);
    }
    return waiting[0];
  }

  /** Lower the authored invocations inside `root` now. */
  upgrade(root: Node): void {
    registryRecord(root.ownerDocument ?? root as Document).u?.(root);
  }

  /** Create an instance of `tag`: its native root, not yet connected. */
  create<K extends keyof ComponentTagMap>(tag: K, init?: ComponentInit<ComponentTagMap[K] extends { props: infer P } ? P : Props>): ComponentTagMap[K] extends { element: infer E } ? E : Element;
  create(tag: string, init?: ComponentInit): Element;
  create(tag: string, init: ComponentInit = {}): Element {
    if (customElementOf(document, tag) !== undefined) throw domError(`<${tag}> is a registered custom element.`, "NotSupportedError");
    const entry = registryRecord().d.get(tag);
    if (entry === undefined) throw domError(`No definition is registered for <${tag}>.`, "NotFoundError");
    const content = init.content ?? [];
    const nodes = content instanceof DocumentFragment ? [...content.childNodes]
      : Array.from(content, (item) => typeof item === "string" ? document.createTextNode(item) : item);
    const props = init.props ?? {};
    checkProps(entry.p, props, tag);
    return entry.c(props, nodes);
  }

  /** Set props on an instance, as attributes on an invocation or framework props would. */
  update(element: Element, props: Props): void {
    for (const lookup of registryRecord(element.ownerDocument).i) {
      const channel = lookup(element);
      if (channel !== undefined) return channel(props);
    }
    throw new TypeError("update() takes the native root of a component instance.");
  }
}

/** The document's registry, shared by every HTML Next bundle on the page. */
export const componentRegistry = /* @__PURE__ */ new ComponentRegistry();
