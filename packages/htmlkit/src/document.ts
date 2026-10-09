import type { HeadElement, RenderedHead, RenderedPage } from "./types.js";
export const defaultHeadElements: readonly HeadElement[] = [
  { tag: "meta", attributes: { charset: "utf-8" } },
  { tag: "meta", attributes: { name: "viewport", content: "width=device-width, initial-scale=1" } },
];
/** A page's browser delivery: stylesheet and module URLs, which the serving adapter supplies. */
export interface PageAssets { readonly styles: readonly string[]; readonly modules: readonly string[] }
export function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function documentHTML(body: string, head: RenderedHead, assets: PageAssets = { styles: [], modules: [] }): string {
  const elements = head.elements ?? defaultHeadElements;
  const charset = elements.filter(element => element.tag === "meta" && element.attributes.charset !== undefined);
  const html = (list: readonly HeadElement[]) =>
    list.map(element => `<${element.tag}${Object.entries(element.attributes).map(([name, value]) => ` ${name}="${escapeHTML(value)}"`).join("")}>`).join("");
  // The head script precedes stylesheets, which would otherwise delay it until they load.
  return `<!doctype html>\n<html lang="${escapeHTML(head.lang ?? "en")}"><head>${html(charset)}` +
    (head.script === undefined ? "" : `<script>${head.script}</script>`) + html(elements.filter(element => !charset.includes(element))) +
    `<title>${escapeHTML(head.title ?? "HTMLKit")}</title>` +
    (head.description === undefined ? "" : `<meta name="description" content="${escapeHTML(head.description)}">`) +
    assets.styles.map(href => `<link rel="stylesheet" href="${escapeHTML(href)}">`).join("") +
    assets.modules.map(src => `<script type="module" src="${escapeHTML(src)}"></script>`).join("") +
    `</head><body>${body}</body></html>`;
}

/**
 * A page's payload URL: its route path under the reserved _htmlkit/pages/ tree, which no route or
 * public file may use, so it never collides with an application's own files.
 */
export function payloadPath(base: string, pathname: string): string {
  return `${base}_htmlkit/pages/${pathname.slice(base.length)}payload.json`;
}

/** Whether JSON carries a value exactly: no undefined, -0, non-finite numbers, or shared or opaque objects. */
function exact(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || seen.has(value) ||
    !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  return (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => exact(item, seen));
}

/**
 * What the browser needs to render a page in place: the document's head, its delivery, and each
 * layer's invocation and initial state, exactly as the server rendered them. The page's component
 * definitions are in its module. Undefined when JSON cannot carry the state exactly; such a page
 * navigates by its HTML instead.
 */
export function pagePayload(page: RenderedPage, assets: PageAssets) {
  if (page.status !== 200 || !page.layers.every(layer => layer.state === undefined || exact(layer.state, new Set()))) return undefined;
  const { lang = "en", title = "HTMLKit", description, elements = defaultHeadElements } = page.head;
  return { version: 1, head: { lang, title, ...(description === undefined ? {} : { description }), elements },
    styles: assets.styles, modules: assets.modules, layers: page.layers };
}
