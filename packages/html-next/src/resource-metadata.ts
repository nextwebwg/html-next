/** Resource and direct carrier metadata belong to application tooling, never to registration.
 * Keep it inert and outside the definition model; active and policy-changing source
 * still follows the resource parser's rejection path.
 */
export function isIgnoredResourceMetadata(
  tag: string,
  attributes: readonly { readonly name: string; readonly value: string }[],
): boolean {
  if (tag !== "meta" && tag !== "title" && tag !== "link") return false;
  if (attributes.some(attribute => attribute.name.startsWith("on"))) return false;
  if (tag === "meta" && attributes.some(attribute => attribute.name === "http-equiv")) return false;
  if (tag === "link") {
    const relations = attributes.find(attribute => attribute.name === "rel")?.value.toLowerCase().split(/\s+/) ?? [];
    if (relations.includes("component") || relations.includes("import")) return false;
  }
  return true;
}
