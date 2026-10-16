type Attributes = readonly { readonly name: string; readonly value: string }[];

/**
 * Build metadata for a component resource as a whole (components#resource-contents): a
 * `<meta name content>` whose name contains a colon, such as `app:page`. The loader ignores it, and
 * it is never added to the document. Everything a component adds to the head is a head declaration
 * in its own `<defs>`.
 */
export function isResourceBuildMetadata(tag: string, attributes: Attributes): boolean {
  if (tag !== "meta" || attributes.some((attribute) => attribute.name.startsWith("on"))) return false;
  const names = attributes.map((attribute) => attribute.name);
  return names.includes("content") && names.every((name) => name === "name" || name === "content") &&
    (attributes.find((attribute) => attribute.name === "name")?.value.includes(":") ?? false);
}

/**
 * Metadata elements placed directly in a carrier, outside `<defs>`, which application tooling reads
 * and the component runtime ignores. Inert: active and policy-changing elements are rejected.
 */
export function isIgnoredResourceMetadata(tag: string, attributes: Attributes): boolean {
  if (tag !== "meta" && tag !== "title" && tag !== "link") return false;
  if (attributes.some(attribute => attribute.name.startsWith("on"))) return false;
  if (tag === "meta" && attributes.some(attribute => attribute.name === "http-equiv")) return false;
  if (tag === "link") {
    const relations = attributes.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/) ?? [];
    if (relations.includes("component") || relations.includes("import")) return false;
  }
  return true;
}
