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
