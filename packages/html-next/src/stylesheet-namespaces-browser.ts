import { hoistStylesheetNamespaces, rewriteNamespacePrelude, stylesheetNamespaceContext } from "./stylesheet-namespaces.js";

/** CSSOM owns parsing; only selector namespace qualification remains a source transform. */
export function normalizeStylesheetNamespacesInBrowser(css: string, document: Document): string {
  if (!/@namespace\b/i.test(css)) return css;
  const Sheet = (document.defaultView ?? globalThis).CSSStyleSheet;
  const sheet = new Sheet();
  sheet.replaceSync(hoistStylesheetNamespaces(css));
  const rules = [...sheet.cssRules];
  const context = stylesheetNamespaceContext(rules.filter(rule => rule.type === 10).map(rule => rule.cssText));
  const serialize = (rule: CSSRule): string => {
    if (rule.type === 10) return "";
    const nested = rule as CSSRule & { cssRules?: CSSRuleList; selectorText?: string; style?: CSSStyleDeclaration };
    const head = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^{"'])*/.exec(rule.cssText)![0];
    if (nested.selectorText !== undefined) {
      return `${context.selector(nested.selectorText)} { ${nested.style?.cssText ?? ""} ${[...(nested.cssRules ?? [])].map(serialize).join("\n")} }`;
    }
    if (nested.cssRules !== undefined && !/^@(?:-\w+-)?keyframes\b/i.test(head)) {
      const name = /^@(\S+)\s*/.exec(head);
      const prelude = name === null ? head : name[0] + rewriteNamespacePrelude(head.slice(name[0].length), name[1]!, context.selector);
      return `${prelude} { ${[...nested.cssRules].map(serialize).join("\n")} }`;
    }
    return rule.cssText;
  };
  return context.preamble + "\n" + rules.map(serialize).join("\n");
}
