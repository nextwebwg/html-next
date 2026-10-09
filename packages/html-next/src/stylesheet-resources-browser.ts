import { renameComponentPseudoClasses } from "./component-styles.js";
import type { ParsedStylesheet, StylesheetEntry } from "./stylesheet-resources.js";

/** Inert documents retain CSSImportRule without starting resource requests. */
export function parseStylesheetInBrowser(css: string, document: Document): ParsedStylesheet {
  const inert = document.implementation.createHTMLDocument("");
  const style = inert.createElement("style");
  style.textContent = renameComponentPseudoClasses(css);
  inert.head.append(style);
  const imports: StylesheetEntry[] = [];
  const body: string[] = [];
  const rules = Array.from(style.sheet?.cssRules ?? []);
  const lastImport = rules.findLastIndex(rule => rule.type === 3);
  for (const [index, rule] of rules.entries()) {
    if (rule.type === 3) {
      const edge = rule as CSSImportRule;
      imports.push({ specifier: edge.href, conditions: {
        ...(edge.layerName === null ? {} : { layer: edge.layerName }),
        ...(edge.supportsText === null ? {} : { supports: edge.supportsText }),
        ...(edge.media.mediaText === "" ? {} : { media: edge.media.mediaText }),
      } });
    } else if (index < lastImport && /^@layer\s[^{}]*;/i.test(rule.cssText)) imports.push({ css: rule.cssText, index });
    else body.push(rule.cssText);
  }
  return { imports, css: body.join("\n")
    .replace(/:where\(\s*\[--slotted\]\s*\):is\(/g, ":slotted(")
    .replace(/:where\(\s*\[--state\]\s*\):is\(/g, ":host-state(") };
}
