import { parseComponent, type ComponentDefinition } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { HtmlKitError } from "./config.js";
import { defaultHeadElements } from "./document.js";
import type { applicationResource } from "./resource.js";
import type { HeadElement, LoaderResult, RenderedHead } from "./types.js";

function identity(element: HeadElement): string | undefined {
  const attrs = element.attributes;
  if (element.tag === "meta") {
    if (attrs.charset !== undefined) return "charset";
    const name = attrs.name ?? attrs.property;
    // Social image arrays and their structured properties preserve authored order.
    if (name?.toLowerCase().startsWith("og:image")) return "meta:property:og:image";
    return name === undefined ? undefined : `meta:${attrs.name === undefined ? "property" : "name"}:${name.toLowerCase()}`;
  }
  const relations = attrs.rel?.toLowerCase().split(/\s+/) ?? [];
  if (relations.includes("canonical")) return "canonical";
  if (relations.includes("alternate") && attrs.hreflang !== undefined) return `alternate:${attrs.hreflang}:${attrs.type ?? ""}:${attrs.media ?? ""}`;
  return undefined;
}

export async function renderHead(resource: ReturnType<typeof applicationResource>, definition: ComponentDefinition,
  result: LoaderResult, previous: RenderedHead, url: string,
  invoke: (definition: ComponentDefinition, result: LoaderResult) => string): Promise<RenderedHead> {
  let title = previous.title;
  let description = previous.description;
  const elements = [...(previous.elements ?? defaultHeadElements)];
  const metadata = resource.components.get(definition.contract.tag)!;
  if (metadata.head !== "") {
    // Reuse the ordinary parser, declared prop contracts, serializer and DOM renderer.
    // No state, data reads, controllers, or browser subscriptions enter this head scope.
    // Component bodies exclude head elements. Inert spans carry the same attribute/text
    // bindings through the renderer, then become native metadata after evaluation.
    const fragment = parseFragment(metadata.head);
    for (const node of fragment.childNodes) {
      if (!("tagName" in node)) continue;
      node.attrs.push({ name: "data-hk-head", value: node.tagName });
      node.tagName = "span";
      node.nodeName = "span";
    }
    const headDefinition = parseComponent(`<template component="hk-head"><defs>${metadata.propDeclarations}</defs><div>${serialize(fragment)}</div></template>`, definition.source.file);
    const rendered = await renderComponents(invoke(headDefinition, { props: result.props ?? {} }), { definitions: [headDefinition], url });
    const root = parseFragment(rendered.html).childNodes.find(node => "tagName" in node);
    if (root === undefined || !("childNodes" in root)) throw new HtmlKitError("Head rendering produced no root.", definition.source.file);
    const text = (node: DefaultTreeAdapterMap["node"]): string => "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
    const current: HeadElement[] = [];
    for (const node of root.childNodes) {
      if (!("tagName" in node)) continue;
      const tag = node.attrs.find(attribute => attribute.name === "data-hk-head")?.value;
      if (tag === "title") { title = text(node); continue; }
      if (tag !== "meta" && tag !== "link") throw new HtmlKitError("Head content must render title, meta, or link elements.", definition.source.file);
      const attributes = Object.fromEntries(node.attrs.filter(attribute => attribute.name !== "data-hk-head").map(attribute => [attribute.name, attribute.value]));
      if (Object.keys(attributes).some(name => name.startsWith("on")) || (tag === "meta" && attributes["http-equiv"] !== undefined)) {
        throw new HtmlKitError("Head metadata cannot activate event handlers or http-equiv policies.", definition.source.file);
      }
      if (tag === "meta" && attributes.name?.toLowerCase() === "description") { description = attributes.content ?? ""; continue; }
      current.push({ tag, attributes });
    }
    const singletons = new Set<string>();
    for (let i = current.length - 1; i >= 0; i--) {
      const key = identity(current[i]!);
      if (key === undefined || key === "meta:property:og:image") continue;
      if (singletons.has(key)) current.splice(i, 1);
      else singletons.add(key);
    }
    const replaced = new Set(current.flatMap(element => identity(element) ?? []));
    for (let i = elements.length - 1; i >= 0; i--) if (replaced.has(identity(elements[i]!) ?? "")) elements.splice(i, 1);
    elements.push(...current);
  }
  // Only PageHead fields: an untyped loader's extra head keys must not reach the document assembler.
  const loaded = Object.entries(result.head ?? {}).filter(([name]) => name === "title" || name === "description" || name === "lang");
  return { ...previous, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...Object.fromEntries(loaded),
    elements };
}
