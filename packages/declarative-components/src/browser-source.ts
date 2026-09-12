import { fail } from "./diagnostics.js";
import { parseComponent } from "./parser.js";
import type { ComponentDefinition } from "./template.js";

/**
 * Adapts a browser-parsed inert carrier to the same source parser and normalized IR used by
 * build tools. `outerHTML` is the browser's normalized serialization, so equivalent normalized
 * input receives the same validation and diagnostics in both environments.
 */
export function parseBrowserComponent(
  carrier: Element,
  source = carrier.ownerDocument.URL,
): ComponentDefinition {
  if (carrier.localName !== "template" || !carrier.hasAttribute("component")) {
    fail("HS001", "A browser component carrier must be a <template component>.", source);
  }
  return parseComponent(carrier.outerHTML, source);
}
