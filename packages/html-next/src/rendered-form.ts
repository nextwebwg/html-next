import { COMPONENT_ATTRIBUTE } from "./component-styles.js";
import { fail } from "./diagnostics.js";
import { decodeHydrationValue } from "./hydration-value.js";

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
  readonly inputs: Readonly<Record<string, { readonly value: unknown; readonly source: "html" | "value"; readonly present: boolean }>>;
  readonly props: Readonly<Record<string, unknown>>;
  readonly state: Readonly<Record<string, unknown>>;
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
          typeof input.present !== "boolean" || input.source !== "html" && input.source !== "value")) {
        fail("HR010", "Malformed rendered component instance record.");
      }
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
