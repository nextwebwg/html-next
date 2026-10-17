import { parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { HtmlKitError } from "./config.js";

interface ComponentMetadata {
  readonly layout?: string;
  readonly label?: string;
  /** hk:order, the page's place among its neighbours, as a number-and-dot prefix gives it. */
  readonly order?: string;
  readonly hidden?: boolean;
  /** hk:render: "server" renders the page on each request; "prerender", the default, at build time. */
  readonly render?: "prerender" | "server";
  /** Extra route patterns for a page, relative to its page directory's prefix. */
  readonly aliases: readonly string[];
  /** The text of a <title> without expressions. */
  readonly title?: string;
}

// HTMLKit metadata was spelled htmlkit:*; name the new spelling rather than ignore it.
function renamed(name: string | undefined, file: string): void {
  if (name?.startsWith("htmlkit:")) throw new HtmlKitError(`HTMLKit metadata uses the hk: prefix; write ${"hk:" + name.slice(8)} instead of ${name}.`, file);
}

/** Native HTML parsing determines resource nodes; HTML Next owns component syntax. */
export function applicationResource(source: string, file: string) {
  const configuration = new Map<string, string>();
  const components = new Map<string, ComponentMetadata>();
  const fragment = parseFragment(source);
  for (const node of fragment.childNodes) {
    if (!("tagName" in node) || !["meta", "title", "link"].includes(node.tagName)) continue;
    const name = node.attrs.find(attribute => attribute.name === "name")?.value;
    renamed(name, file);
    if (node.tagName === "meta" && name === "hk:page") {
      const content = node.attrs.find(attribute => attribute.name === "content")?.value;
      if (!content || configuration.has(name)) throw new HtmlKitError(`Declare ${name} once with nonempty content.`, file);
      configuration.set(name, content);
    } else if (node.tagName !== "link" || !node.attrs.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/).includes("component")) {
      throw new HtmlKitError("Page and layout metadata belongs in its <template component>'s <defs>; only hk:page, which selects the file's page, is outside it.", file);
    }
  }
  for (const node of fragment.childNodes) {
    if (!("tagName" in node)) continue;
    const tag = node.attrs.find(attribute => attribute.name === "component")?.value;
    if (node.tagName !== "template" || tag === undefined) continue;
    const children = (node as DefaultTreeAdapterMap["template"]).content.childNodes;
    const configuration: { layout?: string; label?: string; order?: string; hidden?: boolean; render?: "prerender" | "server"; title?: string } = {};
    const aliases: string[] = [];
    for (const child of children) {
      if ("tagName" in child && ["meta", "title", "link"].includes(child.tagName)) {
        throw new HtmlKitError(`<${child.tagName}> belongs in <${tag}>'s <defs>, where head content and hk: settings are declared.`, file);
      }
    }
    const defs = children.find(child => "tagName" in child && child.tagName === "defs");
    for (const child of defs !== undefined && "childNodes" in defs ? defs.childNodes : []) {
      if (!("tagName" in child)) continue;
      // A static <title> labels the page's folder in navigation trees when hk:label doesn't.
      if (child.tagName === "title") {
        const text = child.childNodes.map(text => "value" in text ? text.value : "").join("").trim();
        if (text !== "" && !text.includes("{")) configuration.title = text;
        continue;
      }
      if (child.tagName !== "meta") continue;
      const name = child.attrs.find(attribute => attribute.name === "name")?.value;
      renamed(name, file);
      if (!name?.startsWith("hk:")) continue;
      const content = child.attrs.find(attribute => attribute.name === "content")?.value;
      if (!content) throw new HtmlKitError(`Declare ${name} with nonempty content.`, file);
      if (name === "hk:alias") { aliases.push(content); continue; }
      const key = ({ "hk:layout": "layout", "hk:label": "label", "hk:order": "order", "hk:navigation": "hidden", "hk:render": "render" } as const)[name];
      if (key === undefined) throw new HtmlKitError(`Component configuration is hk:layout, hk:label, hk:order, hk:navigation, hk:render, or hk:alias; hk:page belongs outside the carrier (${name}).`, file);
      if (configuration[key] !== undefined) throw new HtmlKitError(`Declare ${name} once per component.`, file);
      if (key === "hidden" && content !== "hidden") throw new HtmlKitError('hk:navigation accepts only content="hidden".', file);
      if (key === "order" && !/^\d+$/.test(content)) throw new HtmlKitError("hk:order needs a whole number, such as content=\"3\".", file);
      if (key === "render" && content !== "prerender" && content !== "server") throw new HtmlKitError('hk:render accepts content="prerender" or content="server".', file);
      if (key === "hidden") configuration.hidden = true;
      else if (key === "render") configuration.render = content as "prerender" | "server";
      else configuration[key] = content;
    }
    components.set(tag, { ...configuration, aliases });
  }
  // HTMLKit's own rules first, so their diagnostics name what HTMLKit expects.
  const parsed = parseComponentResource(source, file);
  return { definitions: parsed.definitions.map(withoutSettings), dependencies: parsed.dependencies, configuration, components };
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

/**
 * A definition without its hk: settings, which HTMLKit reads as configuration, so the runtime never
 * adds them to the document head.
 */
export function withoutSettings(definition: ComponentDefinition): ComponentDefinition {
  const head = definition.head?.filter(declaration => declaration.kind !== "meta" ||
    !declaration.attributes.some(attribute => attribute.kind === "literal" && attribute.name === "name" && attribute.value.startsWith("hk:")));
  if (head === undefined || head.length === definition.head!.length) return definition;
  const { head: _head, ...rest } = definition;
  return Object.freeze(head.length === 0 ? rest : { ...rest, head: Object.freeze(head) });
}
