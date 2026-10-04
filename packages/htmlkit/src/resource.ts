import { parseComponentResource, type ComponentDefinition } from "@nextwebwg/html-next";
import { parseFragment, serializeOuter, type DefaultTreeAdapterMap } from "parse5";
import { HtmlKitError } from "./config.js";

/** Native HTML parsing determines resource nodes; HTML Next owns component syntax. */
export function applicationResource(source: string, file: string) {
  const parsed = parseComponentResource(source, file);
  const configuration = new Map<string, string>();
  const head: string[] = [];
  const fragment = parseFragment(source);
  for (const node of fragment.childNodes) {
    if (!("tagName" in node) || !["meta", "title", "link"].includes(node.tagName)) continue;
    const name = node.attrs.find(attribute => attribute.name === "name")?.value;
    if (node.tagName === "meta" && name?.startsWith("htmlkit:")) {
      if (!["htmlkit:page", "htmlkit:layout"].includes(name)) throw new HtmlKitError(`Unknown configuration metadata ${name}.`, file);
      const content = node.attrs.find(attribute => attribute.name === "content")?.value;
      if (!content || configuration.has(name)) throw new HtmlKitError(`Declare ${name} once with nonempty content.`, file);
      configuration.set(name, content);
    } else if (node.tagName !== "link" || !node.attrs.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/).includes("component")) {
      head.push(serializeOuter(node));
    }
  }
  const propDeclarations = new Map<string, string>();
  for (const node of fragment.childNodes) {
    if (!("tagName" in node)) continue;
    const tag = node.attrs.find(attribute => attribute.name === "component")?.value;
    const children = node.tagName === "template" ? (node as DefaultTreeAdapterMap["template"]).content.childNodes : node.childNodes;
    const defs = children.find(child => "tagName" in child && child.tagName === "defs");
    if (tag !== undefined) propDeclarations.set(tag, defs !== undefined && "childNodes" in defs ?
      defs.childNodes.filter(child => "tagName" in child && child.tagName === "prop").map(child => serializeOuter(child)).join("") : "");
  }
  return { definitions: parsed.definitions, dependencies: parsed.dependencies, configuration, head: head.join(""), propDeclarations };
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
