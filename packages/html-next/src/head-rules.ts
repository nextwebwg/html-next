import type { ComponentDefinition, HeadDeclaration } from "./template.js";

/** The `rel` keywords a `<link>` head declaration may use (components#head-elements). */
export const HEAD_LINK_RELS: ReadonlySet<string> = new Set([
  "preconnect", "dns-prefetch", "preload", "modulepreload", "prefetch",
  "canonical", "alternate", "icon", "manifest",
  "author", "license", "help", "privacy-policy", "terms-of-service",
]);

/** The attributes HTML defines for each head element, besides its bindings. */
export const HEAD_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  title: new Set(),
  meta: new Set(["name", "property", "content", "media"]),
  link: new Set(["rel", "href", "as", "crossorigin", "hreflang", "type", "media", "sizes", "integrity",
    "referrerpolicy", "fetchpriority", "imagesrcset", "imagesizes", "color", "title"]),
};

/** A declared script's standard attributes, copied onto the element the runtime inserts. */
export const SCRIPT_STANDARD_ATTRIBUTES = ["integrity", "crossorigin", "referrerpolicy", "fetchpriority"] as const;

/** Head entries that set policy or identity for the whole document (components#document-authority). */
const AUTHORITY_RELS = new Set(["canonical", "alternate", "icon", "manifest"]);
const AUTHORITY_NAMES = new Set(["robots", "referrer", "viewport", "color-scheme", "theme-color", "application-components"]);

function literal(declaration: Extract<HeadDeclaration, { kind: "meta" | "link" }>, name: string): string | undefined {
  const attribute = declaration.attributes.find((candidate) => candidate.name === name && candidate.kind === "literal");
  return attribute?.kind === "literal" ? attribute.value : undefined;
}

/** What makes a head declaration a document-authority entry, or undefined when it is not one. */
export function documentAuthority(declaration: HeadDeclaration): string | undefined {
  if (declaration.kind === "link") {
    const rel = literal(declaration, "rel")?.trim().toLowerCase();
    return rel !== undefined && AUTHORITY_RELS.has(rel) ? `<link rel="${rel}">` : undefined;
  }
  if (declaration.kind !== "meta") return undefined;
  const name = literal(declaration, "name")?.toLowerCase();
  if (name !== undefined) return AUTHORITY_NAMES.has(name) ? `<meta name="${name}">` : undefined;
  return literal(declaration, "property") === "og:url" ? '<meta property="og:url">' : undefined;
}

/**
 * An imported component's definition without its document-authority entries, which only an
 * application component contributes, and the entries it left out.
 */
export function withoutDocumentAuthority(definition: ComponentDefinition): { readonly definition: ComponentDefinition; readonly ignored: readonly string[] } {
  const ignored = (definition.head ?? []).flatMap((declaration) => documentAuthority(declaration) ?? []);
  if (ignored.length === 0) return { definition, ignored };
  const head = definition.head!.filter((declaration) => documentAuthority(declaration) === undefined);
  const { head: _head, ...rest } = definition;
  return { definition: Object.freeze(head.length === 0 ? rest : { ...rest, head: Object.freeze(head) }), ignored };
}
