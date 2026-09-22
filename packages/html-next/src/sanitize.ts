const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href"]);
const BLOCKED_HTML_ELEMENTS = new Set(["base", "embed", "iframe", "link", "meta", "object", "script", "style", "template"]);
const BLOCKED_HTML_ATTRIBUTES = new Set(["srcdoc", "style"]);

export function hasExecutableUrl(value: string): boolean {
  // ASCII controls and whitespace are deliberately stripped before scheme detection.
  // oxlint-disable-next-line eslint/no-control-regex
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  return /^(?:data|javascript|vbscript):/i.test(normalized);
}

export function isUrlAttribute(name: string): boolean {
  return URL_ATTRIBUTES.has(name.toLowerCase());
}

/**
 * Parses content into an inert fragment and removes active embedding, executable attributes,
 * raw document sinks, style injection, and executable URL schemes before the fragment is live.
 */
export function sanitizeFragment(
  html: string,
  document: Document,
  markContentOnly?: (element: Element) => void,
): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    markContentOnly?.(element);
    if (BLOCKED_HTML_ELEMENTS.has(element.localName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || BLOCKED_HTML_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
      } else if (isUrlAttribute(name) && hasExecutableUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.content;
}
