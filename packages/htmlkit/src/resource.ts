import { parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { parseFragment, serializeOuter, type DefaultTreeAdapterMap } from "parse5";
import { HtmlKitError } from "./config.js";

interface ComponentMetadata {
  readonly layout?: string;
  readonly label?: string;
  /** hk:order, the page's place among its neighbours, as a number-and-dot prefix gives it. */
  readonly order?: string;
  readonly hidden?: boolean;
  /** Extra route patterns for a page, relative to its page directory's prefix. */
  readonly aliases: readonly string[];
  readonly head: string;
  /** Each <script type="application/ld+json">, as validated JSON safe to inline. */
  readonly jsonLd: readonly string[];
  readonly propDeclarations: string;
}

// HTMLKit metadata was spelled htmlkit:*; name the new spelling rather than ignore it.
function renamed(name: string | undefined, file: string): void {
  if (name?.startsWith("htmlkit:")) throw new HtmlKitError(`HTMLKit metadata uses the hk: prefix; write ${"hk:" + name.slice(8)} instead of ${name}.`, file);
}

/** Native HTML parsing determines resource nodes; HTML Next owns component syntax. */
export function applicationResource(source: string, file: string) {
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  // JSON-LD is head data that HTML Next's carrier metadata leaves out, so HTML Next reads the page
  // without it: each script becomes spaces, which keeps diagnostics' lines and columns.
  const jsonLd = new Map<string, string[]>();
  let stripped = source;
  for (const node of fragment.childNodes) {
    const tag = "tagName" in node && node.tagName === "template" ? node.attrs.find(attribute => attribute.name === "component")?.value : undefined;
    if (tag === undefined) continue;
    for (const child of (node as DefaultTreeAdapterMap["template"]).content.childNodes) {
      if (!("tagName" in child) || child.tagName !== "script" || child.attrs.find(attribute => attribute.name === "type")?.value.trim().toLowerCase() !== "application/ld+json") continue;
      const { startLine, startOffset, endOffset } = child.sourceCodeLocation!;
      if (child.attrs.length !== 1) throw new HtmlKitError(`The JSON-LD script at line ${startLine} takes only its type attribute.`, file);
      const text = child.childNodes.map(text => "value" in text ? text.value : "").join("");
      let value: unknown;
      try { value = JSON.parse(text); }
      catch (error) { throw new HtmlKitError(`The JSON-LD script at line ${startLine} is not valid JSON: ${(error as Error).message}`, file); }
      // Escaping < keeps </script> and <!-- in strings from ending or changing the element.
      jsonLd.set(tag, [...jsonLd.get(tag) ?? [], JSON.stringify(value).replaceAll("<", "\\u003c")]);
      stripped = stripped.slice(0, startOffset) + source.slice(startOffset, endOffset).replace(/[^\n]/g, " ") + stripped.slice(endOffset);
    }
  }
  const parsed = parseComponentResource(stripped, file);
  const configuration = new Map<string, string>();
  const components = new Map<string, ComponentMetadata>();
  for (const node of fragment.childNodes) {
    if (!("tagName" in node) || !["meta", "title", "link"].includes(node.tagName)) continue;
    const name = node.attrs.find(attribute => attribute.name === "name")?.value;
    renamed(name, file);
    if (node.tagName === "meta" && name === "hk:page") {
      const content = node.attrs.find(attribute => attribute.name === "content")?.value;
      if (!content || configuration.has(name)) throw new HtmlKitError(`Declare ${name} once with nonempty content.`, file);
      configuration.set(name, content);
    } else if (node.tagName !== "link" || !node.attrs.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/).includes("component")) {
      throw new HtmlKitError('Page and layout metadata belongs inside its owning <template component>; only hk:page selects the file entry outside it.', file);
    }
  }
  for (const node of fragment.childNodes) {
    if (!("tagName" in node)) continue;
    const tag = node.attrs.find(attribute => attribute.name === "component")?.value;
    if (node.tagName !== "template" || tag === undefined) continue;
    const children = (node as DefaultTreeAdapterMap["template"]).content.childNodes;
    const configuration: { layout?: string; label?: string; order?: string; hidden?: boolean } = {};
    const aliases: string[] = [];
    const head: string[] = [];
    for (const child of children) {
      if (!("tagName" in child) || !["meta", "title", "link"].includes(child.tagName)) continue;
      const name = child.attrs.find(attribute => attribute.name === "name")?.value;
      renamed(name, file);
      if (child.tagName === "meta" && name?.startsWith("hk:")) {
        const content = child.attrs.find(attribute => attribute.name === "content")?.value;
        if (!content) throw new HtmlKitError(`Declare ${name} with nonempty content.`, file);
        if (name === "hk:alias") { aliases.push(content); continue; }
        const key = ({ "hk:layout": "layout", "hk:label": "label", "hk:order": "order", "hk:navigation": "hidden" } as const)[name];
        if (key === undefined) throw new HtmlKitError(`Component configuration is hk:layout, hk:label, hk:order, hk:navigation, or hk:alias; hk:page belongs outside the carrier (${name}).`, file);
        if (configuration[key] !== undefined) throw new HtmlKitError(`Declare ${name} once per component.`, file);
        if (key === "hidden" && content !== "hidden") throw new HtmlKitError('hk:navigation accepts only content="hidden".', file);
        if (key === "order" && !/^\d+$/.test(content)) throw new HtmlKitError("hk:order needs a whole number, such as content=\"3\".", file);
        if (key === "hidden") configuration.hidden = true; else configuration[key] = content;
      } else head.push(serializeOuter(child));
    }
    const defs = children.find(child => "tagName" in child && child.tagName === "defs");
    const propDeclarations = defs !== undefined && "childNodes" in defs ?
      defs.childNodes.filter(child => "tagName" in child && child.tagName === "prop").map(child => serializeOuter(child)).join("") : "";
    components.set(tag, { ...configuration, aliases, head: head.join(""), jsonLd: jsonLd.get(tag) ?? [], propDeclarations });
  }
  return { definitions: parsed.definitions, dependencies: parsed.dependencies, configuration, components, source: stripped };
}

export function pageDefinition(resource: ReturnType<typeof applicationResource>, file: string): ComponentDefinition {
  const selected = resource.configuration.get("hk:page");
  if (selected === undefined && resource.definitions.length !== 1) {
    throw new HtmlKitError("Multiple components require <meta name=\"hk:page\" content=\"page-name\">.", file);
  }
  const definition = selected === undefined ? resource.definitions[0] : resource.definitions.find(value => value.contract.tag === selected);
  if (definition === undefined) throw new HtmlKitError(`Unknown page component ${selected}.`, file);
  return definition;
}
