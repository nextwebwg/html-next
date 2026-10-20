import { COMPONENT_ATTRIBUTE } from "./component-styles.js";
import { fail } from "./diagnostics.js";
import { decodeHydrationValue } from "./hydration-value.js";
import type { InputStatus } from "./inputs.js";

/**
 * The rendered form's marks (slot ranges, carried projection). The live runtime and compiled
 * components write the same nodes, so serialization and hydration read either.
 */

const piParsingByDocument = new WeakMap<Document, boolean>();
export function documentParsesInstructions(document: Document): boolean {
  let piParsing = piParsingByDocument.get(document);
  if (piParsing === undefined) {
    const probe = document.createElement("div");
    probe.innerHTML = '<?probe x="1"?>';
    piParsing = probe.firstChild?.nodeType === 7;
    piParsingByDocument.set(document, piParsing);
  }
  return piParsing;
}
/**
 * A rendered-form mark: a processing instruction, or, where the parser does not produce them, the
 * comment it would produce instead, so a lowered DOM and a hydrated DOM hold the same nodes.
 */
export function renderedFormMark(document: Document, target: string, data: string): Node {
  return documentParsesInstructions(document)
    ? document.createProcessingInstruction(target, data)
    : document.createComment(`?${target}${data === "" ? "" : ` ${data}`}?`);
}

/** 1 for the start mark of an `$if`, `$each`, `$with` or `$match` region, -1 for its end, else 0. Both runtimes write these marks (see `buildTemplate`). */
function regionMark(node: Node): number {
  if (node.nodeType !== 8) return 0;
  const data = (node as Comment).data;
  return data === "html-next:start" || data === "html-next:each-start" ? 1 : data === "html-next:end" || data === "html-next:each-end" ? -1 : 0;
}

/**
 * The consumer regions that make up all of a slot's assigned nodes, as [start, end] marks, or
 * undefined when the slot is given anything else.
 */
export function slotRegions(nodes: readonly Node[]): (readonly [Node, Node])[] | undefined {
  const regions: (readonly [Node, Node])[] = [];
  let depth = 0;
  let open: Node | undefined;
  for (const node of nodes) {
    const mark = regionMark(node);
    if (mark === 1) {
      if (depth++ === 0) open = node;
    } else if (mark === -1) {
      if (--depth === 0) regions.push([open!, node]);
    } else if (depth === 0) return undefined;
  }
  return regions.length === 0 || depth !== 0 ? undefined : regions;
}

/**
 * Projected nodes with each region's content as the DOM holds it now, between its marks, and each
 * node's slot (a region's content is its start mark's). A projection records what a region held when
 * it was taken; the region renders, and removes, its own content since.
 */
export function withRegionContent<T>(entries: readonly (readonly [Node, T])[]): [Node, T][] {
  const current: [Node, T][] = [];
  let depth = 0;
  for (const [node, slot] of entries) {
    const mark = regionMark(node);
    if (depth === 0 && mark === 1) {
      let inner = 0;
      for (let next: Node | null = node; next !== null; next = next.nextSibling) {
        current.push([next, slot]);
        const nested = regionMark(next);
        if (nested === 1) inner += 1;
        else if (nested === -1 && --inner === 0) break;
      }
    } else if (depth === 0 && mark === 0) current.push([node, slot]);
    depth += mark;
  }
  return current;
}

/** `withRegionContent` over nodes alone. */
export const currentProjection = (nodes: readonly Node[]): Node[] => withRegionContent(nodes.map((node) => [node, 0] as const)).map(([node]) => node);

/** Each consumer region's slot, told when the region renders, by the region's start mark. */
const regionListeners = new WeakMap<Node, () => void>();

/** A region for a named slot rendered: its slot shows its fallback or its content accordingly. */
export function regionChanged(start: Node): void {
  regionListeners.get(start)?.();
}

/**
 * Shows a slot's fallback while every consumer region it is given renders nothing, and the regions'
 * content otherwise, as a native `<slot>` shows its own children only while nothing is assigned to it.
 * Each region tells its slot when it renders (`regionChanged`); `open`, the slot's start mark, keeps
 * its `fallback` attribute in step. The fallback goes before the first region.
 */
export function switchFallback(open: Node, regions: readonly (readonly [Node, Node])[], fallback: readonly Node[]): void {
  const mark = open as CharacterData;
  const content = mark.data.replace(' fallback=""', "");
  const shown = content.replace(/(slot="[^"]*")/, '$1 fallback=""');
  let showing = mark.data !== content;
  const first = regions[0]![0];
  const sync = (): void => {
    let empty = true;
    for (let index = 0; empty && index < regions.length; index += 1) empty = regions[index]![0].nextSibling === regions[index]![1];
    if (empty === showing) return;
    showing = empty;
    mark.data = empty ? shown : content;
    const parent = first.parentNode;
    for (let index = 0; index < fallback.length; index += 1) {
      const node = fallback[index]!;
      if (empty) parent?.insertBefore(node, first);
      else node.parentNode?.removeChild(node);
    }
  };
  for (const [start] of regions) regionListeners.set(start, sync);
}

export interface HydrationRange {
  readonly slot: string;
  readonly fallback: boolean;
  readonly scoped?: boolean;
  /** The server's marker nodes: [start, end], or [marker] for an empty slot. */
  readonly markers: readonly Node[];
  readonly content: readonly Node[];
}

interface ServerMark { readonly target: string; readonly attributes: Map<string, string> }

function pseudoAttributes(data: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let rest = data.trim();
  const references: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  while (rest !== "") {
    const match = /^([A-Za-z_:][-A-Za-z0-9._:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')(?:\s+|$)/.exec(rest);
    if (match === null || attributes.has(match[1]!)) return new Map();
    const value = (match[2] ?? match[3]!).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, body: string) =>
      body.startsWith("#x") ? String.fromCodePoint(parseInt(body.slice(2), 16))
        : body.startsWith("#") ? String.fromCodePoint(Number(body.slice(1))) : references[body]!);
    attributes.set(match[1]!, value);
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

export function serverMark(node: Node): ServerMark | undefined {
  if (node.nodeType === 7) {
    const pi = node as ProcessingInstruction;
    return { target: pi.target, attributes: pseudoAttributes(pi.data) };
  }
  if (node.nodeType !== 8) return undefined;
  if (documentParsesInstructions(node.ownerDocument!)) return undefined;   // a real comment is never a marker where PIs parse
  const match = /^\?([A-Za-z][-A-Za-z0-9]*)(?:\s+([\s\S]*?))?\s*\??$/.exec((node as Comment).data);
  return match === null ? undefined : { target: match[1]!, attributes: pseudoAttributes(match[2] ?? "") };
}

/**
 * The server range `start` opens for `slot`, read from its siblings. A consumer's `<template slot>`
 * that forwards to its own outlet renders after the consumer hydrated, so the outlet finds its range here.
 */
export function serverRangeAt(start: Node, slot: string): HydrationRange | undefined {
  const mark = serverMark(start);
  if (mark?.attributes.get("slot") !== slot) return undefined;
  if (mark.target === "marker") return { slot, fallback: false, markers: [start], content: [] };
  if (mark.target !== "start") return undefined;
  const content: Node[] = [];
  let nesting = 1;
  for (let node = start.nextSibling; node !== null; node = node.nextSibling) {
    const inner = serverMark(node);
    if (inner?.target === "start") nesting += 1;
    else if (inner?.target === "end" && --nesting === 0) {
      return { slot, fallback: mark.attributes.has("fallback"), scoped: mark.attributes.has("scoped"), markers: [start, node], content };
    }
    content.push(node);
  }
  return undefined;
}

/** The slot ranges a server-rendered root owns, in document order, and its carried projection. */
export function serverRanges(root: Element, consume = true, tag?: string): { ranges: HydrationRange[]; carried: Node[] } | undefined {
  const ranges: HydrationRange[] = [];
  const inRanges = new Set<Node>();
  const lineage = (root.getAttribute(COMPONENT_ATTRIBUTE) ?? "").split(/\s+/);
  const tagIndex = tag === undefined ? -1 : lineage.indexOf(tag);
  // The innermost delegated component wraps the outer component's projection in its own ranges.
  const delegatedDepth = tagIndex < 0 ? 0 : lineage.length - tagIndex - 1;
  const collect = (nodes: readonly Node[], into: HydrationRange[], depth = delegatedDepth): void => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const mark = serverMark(node);
      if (mark?.target === "marker" && mark.attributes.has("slot")) {
        if (depth === 0) into.push({ slot: mark.attributes.get("slot")!, fallback: false, markers: [node], content: [] });
        continue;
      }
      if (mark?.target === "start") {
        let nesting = 1;
        const content: Node[] = [];
        let end: Node | undefined;
        for (index += 1; index < nodes.length; index += 1) {
          const inner = serverMark(nodes[index]!);
          if (inner?.target === "start") nesting += 1;
          else if (inner?.target === "end" && --nesting === 0) { end = nodes[index]; break; }
          content.push(nodes[index]!);
        }
        if (mark.attributes.has("slot")) {
          if (depth > 0) collect(content, into, depth - 1);
          else into.push({ slot: mark.attributes.get("slot")!, fallback: mark.attributes.has("fallback"), scoped: mark.attributes.has("scoped"), markers: end ? [node, end] : [node], content });
          for (const child of content) inRanges.add(child);
        } else collect(content, into, depth);   // a page's own range is transparent
        continue;
      }
      if (!(node instanceof Element)) continue;
      if (node !== root && node.hasAttribute("data-component")) {
        const nested = serverRanges(node, false);
        for (const range of nested?.ranges ?? []) collect(range.content, into, depth);
      } else collect(Array.from(node.childNodes), into, depth);
    }
  };
  collect(Array.from(root.childNodes), ranges);
  // The carrier is the <template> child that follows a `carrier` mark, outside every range.
  const carrier = Array.from(root.children).find((child): child is HTMLTemplateElement =>
    child instanceof HTMLTemplateElement && !inRanges.has(child) &&
    child.previousSibling !== null && serverMark(child.previousSibling)?.target === "carrier");
  if (ranges.length === 0 && carrier === undefined) return undefined;
  const carried: Node[] = [];
  if (carrier !== undefined && consume) {
    for (const child of Array.from(carrier.content.childNodes)) carried.push(root.ownerDocument.adoptNode(child));
    carrier.previousSibling!.remove();
    carrier.remove();
  } else if (carrier !== undefined) carried.push(...Array.from(carrier.content.childNodes));
  return { ranges, carried };
}

export const FORM_DEFAULTS_ATTRIBUTE = "data-html-next-form-defaults";
export const INSTANCE_ATTRIBUTE = "data-html-next-instance";

export interface RenderedInstanceRecord {
  readonly explicit: readonly string[];
  readonly inputs: Readonly<Record<string, {
    readonly value: unknown; readonly source: "html" | "value"; readonly present: boolean;
    readonly provided?: boolean; readonly producer?: boolean;
  }>>;
  readonly availability?: Readonly<Record<string, InputStatus>>;
  /** Only inputs whose source driver requested change identities need counters. */
  readonly revisions?: Readonly<Record<string, number>>;
  readonly props: Readonly<Record<string, unknown>>;
  readonly state: Readonly<Record<string, unknown>>;
  /** One-time state initializers already claimed by a seed or an explicit accepted write. */
  readonly initialized?: readonly string[];
}

/** Caller inputs for a kept instance: null retains caller ownership; omission leaves an active producer alone. */
export function renderedCallerProps(
  record: Pick<RenderedInstanceRecord, "explicit" | "inputs" | "props">,
  names: readonly string[],
  sourceOwned?: (name: string) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(names.flatMap(name => {
    const input = record.inputs[name];
    const supplied = input?.provided ?? (input === undefined ? record.explicit.includes(name) : input.present && !input.producer);
    if (!supplied && sourceOwned?.(name)) return [];
    return [[name, supplied ? input?.value === null ? null : record.props[name] : undefined]];
  }));
}

const renderedInstanceRecords = new WeakMap<Element, Readonly<Record<string, RenderedInstanceRecord>>>();

export function renderedInstanceRecord(element: Element, tag: string): RenderedInstanceRecord | undefined {
  let records = renderedInstanceRecords.get(element);
  if (records === undefined) {
    const serialized = element.getAttribute(INSTANCE_ATTRIBUTE);
    if (serialized === null) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); }
    catch { fail("HR010", "Malformed rendered component instance record."); }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 1) {
      fail("HR010", "Unsupported rendered component instance record.");
    }
    const decoded = decodeHydrationValue(parsed[1]);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      fail("HR010", "Malformed rendered component instance record.");
    }
    records = decoded as Readonly<Record<string, RenderedInstanceRecord>>;
    for (const record of Object.values(records)) {
      if (record === null || typeof record !== "object" || !Array.isArray(record.explicit) ||
        record.explicit.some((name) => typeof name !== "string") ||
        [record.inputs, record.props, record.state].some((value) => value === null || typeof value !== "object" || Array.isArray(value)) ||
        Object.values(record.inputs).some((input) => input === null || typeof input !== "object" ||
          typeof input.present !== "boolean" || input.source !== "html" && input.source !== "value" ||
          input.provided !== undefined && typeof input.provided !== "boolean" ||
          input.producer !== undefined && typeof input.producer !== "boolean")) {
        fail("HR010", "Malformed rendered component instance record.");
      }
      if (record.availability !== undefined) {
        if (record.availability === null || typeof record.availability !== "object" || Array.isArray(record.availability) ||
          Object.values(record.availability).some(status => status === null || typeof status !== "object" ||
            typeof status.ready !== "boolean" || typeof status.pending !== "boolean" || typeof status.stale !== "boolean" ||
            !status.ready && status.stale || status.error !== null && (typeof status.error !== "object" ||
              typeof status.error.name !== "string" || typeof status.error.message !== "string"))) {
          fail("HR010", "Malformed rendered input availability.");
        }
      }
      if (record.revisions !== undefined && (record.revisions === null || typeof record.revisions !== "object" || Array.isArray(record.revisions) ||
        Object.entries(record.revisions).some(([name, revision]) => !Object.hasOwn(record.props, name) || !Number.isSafeInteger(revision) || revision < 0))) {
        fail("HR010", "Malformed rendered input revisions.");
      }
      if (record.initialized !== undefined && (!Array.isArray(record.initialized) || record.initialized.some(name =>
        typeof name !== "string" || !Object.hasOwn(record.state, name)))) fail("HR010", "Malformed rendered state initialization ownership.");
    }
    renderedInstanceRecords.set(element, records);
    element.removeAttribute(INSTANCE_ATTRIBUTE);
  }
  return Object.hasOwn(records, tag) ? records[tag] : undefined;
}

interface SerializedFormDefaults {
  readonly value?: string;
  readonly valuePresent?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
}

export function restoreSerializedFormDefaults(root: Element): void {
  const controls = [root, ...Array.from(root.querySelectorAll(`[${FORM_DEFAULTS_ATTRIBUTE}]`))];
  for (const element of controls) {
    const serialized = element.getAttribute(FORM_DEFAULTS_ATTRIBUTE);
    if (serialized === null) continue;
    element.removeAttribute(FORM_DEFAULTS_ATTRIBUTE);
    let defaults: SerializedFormDefaults;
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      defaults = parsed as SerializedFormDefaults;
    }
    catch { continue; }
    if (element instanceof HTMLInputElement) {
      const value = element.value;
      const checked = element.checked;
      if (typeof defaults.value === "string") {
        element.defaultValue = defaults.value;
        if (defaults.valuePresent === false) element.removeAttribute("value");
      }
      if (typeof defaults.checked === "boolean") element.defaultChecked = defaults.checked;
      element.value = value;
      element.checked = checked;
    } else if (element instanceof HTMLTextAreaElement && typeof defaults.value === "string") {
      const value = element.value;
      element.defaultValue = defaults.value;
      element.value = value;
    } else if (element instanceof HTMLOptionElement && typeof defaults.selected === "boolean") {
      const selected = element.selected;
      element.defaultSelected = defaults.selected;
      element.selected = selected;
    }
  }
}
