import { parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { parseFragment, serializeOuter, type DefaultTreeAdapterMap } from "parse5";
import { HtmlKitError } from "./config.js";

interface ComponentMetadata {
  readonly layout?: string;
  readonly label?: string;
  readonly hidden?: boolean;
  /** Extra route patterns for a page, relative to its page directory's prefix. */
  readonly aliases: readonly string[];
  readonly head: string;
  readonly propDeclarations: string;
}

/** Native HTML parsing determines resource nodes; HTML Next owns component syntax. */
export function applicationResource(source: string, file: string) {
  const parsed = parseComponentResource(source, file);
  const configuration = new Map<string, string>();
  const components = new Map<string, ComponentMetadata>();
  const fragment = parseFragment(source);
  for (const node of fragment.childNodes) {
    if (!("tagName" in node) || !["meta", "title", "link"].includes(node.tagName)) continue;
    const name = node.attrs.find(attribute => attribute.name === "name")?.value;
    if (node.tagName === "meta" && name === "htmlkit:page") {
      const content = node.attrs.find(attribute => attribute.name === "content")?.value;
      if (!content || configuration.has(name)) throw new HtmlKitError(`Declare ${name} once with nonempty content.`, file);
      configuration.set(name, content);
    } else if (node.tagName !== "link" || !node.attrs.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/).includes("component")) {
      throw new HtmlKitError('Page and layout metadata belongs inside its owning <template component>; only htmlkit:page selects the file entry outside it.', file);
    }
  }
  for (const node of fragment.childNodes) {
    if (!("tagName" in node)) continue;
    const tag = node.attrs.find(attribute => attribute.name === "component")?.value;
    if (node.tagName !== "template" || tag === undefined) continue;
    const children = (node as DefaultTreeAdapterMap["template"]).content.childNodes;
    const configuration: { layout?: string; label?: string; hidden?: boolean } = {};
    const aliases: string[] = [];
    const head: string[] = [];
    for (const child of children) {
      if (!("tagName" in child) || !["meta", "title", "link"].includes(child.tagName)) continue;
      const name = child.attrs.find(attribute => attribute.name === "name")?.value;
      if (child.tagName === "meta" && name?.startsWith("htmlkit:")) {
        const content = child.attrs.find(attribute => attribute.name === "content")?.value;
        if (!content) throw new HtmlKitError(`Declare ${name} with nonempty content.`, file);
        if (name === "htmlkit:alias") { aliases.push(content); continue; }
        const key = ({ "htmlkit:layout": "layout", "htmlkit:label": "label", "htmlkit:navigation": "hidden" } as const)[name];
        if (key === undefined) throw new HtmlKitError(`Component configuration is htmlkit:layout, htmlkit:label, htmlkit:navigation, or htmlkit:alias; htmlkit:page belongs outside the carrier (${name}).`, file);
        if (configuration[key] !== undefined) throw new HtmlKitError(`Declare ${name} once per component.`, file);
        if (key === "hidden" && content !== "hidden") throw new HtmlKitError('htmlkit:navigation accepts only content="hidden".', file);
        if (key === "hidden") configuration.hidden = true; else configuration[key] = content;
      } else head.push(serializeOuter(child));
    }
    const defs = children.find(child => "tagName" in child && child.tagName === "defs");
    const propDeclarations = defs !== undefined && "childNodes" in defs ?
      defs.childNodes.filter(child => "tagName" in child && child.tagName === "prop").map(child => serializeOuter(child)).join("") : "";
    components.set(tag, { ...configuration, aliases, head: head.join(""), propDeclarations });
  }
  return { definitions: parsed.definitions, dependencies: parsed.dependencies, configuration, components };
}

export function pageDefinition(resource: ReturnType<typeof applicationResource>, file: string): ComponentDefinition {
  const selected = resource.configuration.get("htmlkit:page");
  if (selected === undefined && resource.definitions.length !== 1) {
    throw new HtmlKitError("Multiple components require <meta name=\"htmlkit:page\" content=\"page-name\">.", file);
  }
  const definition = selected === undefined ? resource.definitions[0] : resource.definitions.find(value => value.contract.tag === selected);
  if (definition === undefined) throw new HtmlKitError(`Unknown page component ${selected}.`, file);
  return definition;
}
