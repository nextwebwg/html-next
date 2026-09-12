import { transformValidityStyles } from "./style.js";

/**
 * Add the internal state mirrors that let authors use the proposed `:valid` and `:invalid`
 * surface before browsers expose those pseudo-classes on arbitrary elements.
 */
export function rewriteValiditySelectors(css: string): string {
  return transformValidityStyles(css);
}
