import { defaultTreeAdapter, html as parse5Html, parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { SAFE_DEFAULT_ELEMENTS, SAFE_GLOBAL_ATTRIBUTES } from "./sanitizer-default.js";

const HTML_NAMESPACE = parse5Html.NS.HTML;
const NAMESPACES: Readonly<Record<string, string>> = {
  [HTML_NAMESPACE]: "html",
  "http://www.w3.org/2000/svg": "svg",
  "http://www.w3.org/1998/Math/MathML": "mathml",
};
const VOID_HTML_ELEMENTS = new Set(["br", "col", "hr", "wbr"]);

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Serialize only surviving, allowlisted nodes; never round-trip untrusted markup through a raw sink. */
function serializeSafe(nodes: readonly DefaultTreeAdapterTypes.ChildNode[]): string {
  return nodes.map((node) => {
    if (node.nodeName === "#text" && "value" in node) return escapeText(node.value);
    if (!("tagName" in node)) return "";
    const open = `<${node.tagName}${node.attrs.map(({ name, value }) => ` ${name}="${escapeAttribute(value)}"`).join("")}>`;
    if (node.namespaceURI === HTML_NAMESPACE && VOID_HTML_ELEMENTS.has(node.tagName)) return open;
    return `${open}${serializeSafe(node.childNodes)}</${node.tagName}>`;
  }).join("");
}

function sanitizeNodes(parent: DefaultTreeAdapterTypes.ParentNode): void {
  parent.childNodes = parent.childNodes.filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (!("tagName" in node)) return true;
    const namespace = NAMESPACES[node.namespaceURI];
    const elements = namespace === undefined ? undefined : SAFE_DEFAULT_ELEMENTS[namespace];
    if (elements === undefined || !Object.hasOwn(elements, node.tagName)) return false;
    const localAttributes = elements[node.tagName] ?? [];
    node.attrs = node.attrs.filter((attribute) => {
      if (attribute.namespace !== undefined ||
        (!SAFE_GLOBAL_ATTRIBUTES.has(attribute.name) && !localAttributes.includes(attribute.name))) return false;
      if (attribute.name === "href" || attribute.name === "cite") {
        try { return new URL(attribute.value, "https://example.invalid/").protocol !== "javascript:"; }
        catch { return true; }
      }
      return true;
    });
    sanitizeNodes(node);
    return true;
  });
}

/** Synchronous server-side `$html` sanitization using the HTML fragment parser. */
export function sanitizeServerHTML(html: string, contextTag = "template"): string {
  const context = defaultTreeAdapter.createElement(contextTag, HTML_NAMESPACE, []);
  const fragment = parseFragment(context, html, {});
  sanitizeNodes(fragment);
  return serializeSafe(fragment.childNodes);
}
