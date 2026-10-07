import { SAFE_DEFAULT_ELEMENTS, SAFE_GLOBAL_ATTRIBUTES } from "./sanitizer-default.js";

const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href"]);
const NAMESPACES: Readonly<Record<string, string>> = {
  "http://www.w3.org/1999/xhtml": "html",
  "http://www.w3.org/2000/svg": "svg",
  "http://www.w3.org/1998/Math/MathML": "mathml",
};

export function hasExecutableUrl(value: string): boolean {
  // ASCII controls and whitespace are deliberately stripped before scheme detection.
  // oxlint-disable-next-line eslint/no-control-regex
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  return /^(?:data|javascript|vbscript):/i.test(normalized);
}

export function isUrlAttribute(name: string): boolean {
  return URL_ATTRIBUTES.has(name.toLowerCase());
}

/** Apply the platform safe-default allowlists to an inert parsed fragment. */
function sanitizeDefault(fragment: DocumentFragment): void {
  const visit = (parent: ParentNode): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 8) {
        child.parentNode?.removeChild(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const namespace = NAMESPACES[element.namespaceURI ?? ""];
      const elements = namespace === undefined ? undefined : SAFE_DEFAULT_ELEMENTS[namespace];
      if (elements === undefined || !Object.hasOwn(elements, element.localName)) {
        element.remove();
        continue;
      }
      const localAttributes = elements[element.localName] ?? [];
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.namespaceURI !== null ||
          (!SAFE_GLOBAL_ATTRIBUTES.has(attribute.localName) && !localAttributes.includes(attribute.localName))) {
          element.removeAttributeNode(attribute);
          continue;
        }
        if (attribute.localName === "href" || attribute.localName === "cite") {
          try {
            if (new URL(attribute.value, "https://example.invalid/").protocol === "javascript:") {
              element.removeAttributeNode(attribute);
            }
          } catch { /* An unparseable URL is not a javascript: URL. */ }
        }
      }
      visit(element);
    }
  };
  visit(fragment);
}

/**
 * Parse into an inert fragment and apply the HTML Sanitizer safe default consistently across engines.
 * Do not call native setHTML(): Firefox currently parses malformed table content differently,
 * which would make server output and hydration depend on the user's browser.
 */
const CONTENT_ONLY = Symbol.for("@nextwebwg/html-next.content-only.v1");

/**
 * Marks an element `$html` inserted: it is content, never a component invocation or definition,
 * whichever bundle (live or generated) inserted it.
 */
export const markContentOnly = (element: Element): void => { (element as Element & { [CONTENT_ONLY]?: true })[CONTENT_ONLY] = true; };
export const isContentOnly = (element: Element): boolean => (element as Element & { [CONTENT_ONLY]?: true })[CONTENT_ONLY] === true;

export function sanitizeFragment(
  html: string,
  document: Document,
  markContentOnly?: (element: Element) => void,
): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeDefault(template.content);
  for (const element of Array.from(template.content.querySelectorAll("*"))) markContentOnly?.(element);
  return template.content;
}
