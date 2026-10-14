import { stylesheetNamespaceContext, rewriteNamespacePrelude } from "./stylesheet-namespaces.js";
import postcss from "postcss";
import { decodeCSS, type ParsedStylesheet, type StylesheetImport, type StylesheetEntry } from "./stylesheet-resources.js";

/** Small import-prelude reader; PostCSS owns stylesheet and at-rule parsing. */
function importPrelude(params: string): StylesheetImport | undefined {
  let rest = params.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, match => match.startsWith("/*") ? " " : match).trim();
  const href = /^(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^\s)\\])*))\s*\))/i.exec(rest);
  if (href === null) return undefined;
  const specifier = decodeCSS(href[1] ?? href[2] ?? href[3] ?? href[4] ?? href[5]!);
  rest = rest.slice(href[0].length).trim();
  const conditions: { layer?: string; supports?: string; media?: string } = {};
  const consumeFunction = (name: string): string | undefined => {
    if (!rest.toLowerCase().startsWith(`${name}(`)) return undefined;
    let depth = 1;
    let index = name.length + 1;
    let quote = "";
    for (; index < rest.length && depth > 0; index += 1) {
      const character = rest[index]!;
      if (character === "\\") { index += 1; continue; }
      if (quote !== "") { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth !== 0) return undefined;
    const value = rest.slice(name.length + 1, index - 1);
    rest = rest.slice(index).trim();
    return value;
  };
  if (/^layer(?:\s|$)/i.test(rest)) { conditions.layer = ""; rest = rest.slice(5).trim(); }
  else { const layer = consumeFunction("layer"); if (layer !== undefined) { if (layer.trim() === "") return undefined; conditions.layer = layer; } }
  const supports = consumeFunction("supports");
  if (supports !== undefined) { if (supports.trim() === "") return undefined; conditions.supports = supports; }
  if (rest !== "") conditions.media = rest;
  return { specifier, conditions };
}

export function parseStylesheetForBuild(css: string): ParsedStylesheet {
  const root = postcss.parse(css);
  const imports: StylesheetEntry[] = [];
  let allowed = true;
  const lastImport = root.nodes.findLastIndex(node => node.type === "atrule" && node.name.toLowerCase() === "import");
  root.each((node, index) => {
    if (node.type === "comment") return;
    if (node.type === "atrule" && node.name.toLowerCase() === "import") {
      const edge = allowed && node.nodes === undefined ? importPrelude(node.params) : undefined;
      if (edge !== undefined) imports.push(edge);
      node.remove();
    } else if (allowed && index < lastImport && node.type === "atrule" && node.name.toLowerCase() === "layer" && node.nodes === undefined) {
      imports.push({ css: `${node.toString()};`, index });
      node.remove();
    } else if (!(node.type === "atrule" && (node.name.toLowerCase() === "charset" || (node.name.toLowerCase() === "layer" && node.nodes === undefined)))) allowed = false;
  });
  return { css: normalizeStylesheetNamespacesForBuild(root.toString()), imports };
}

/** Normalize each sheet before combining it with a different namespace environment. */
export function normalizeStylesheetNamespacesForBuild(css: string): string {
  if (!/@namespace\b/i.test(css)) return css;
  const root = postcss.parse(css);
  let allowed = true;
  const declarations = root.nodes.filter(node => {
    if (node.type === "comment") return false;
    if (node.type === "atrule" && node.name.toLowerCase() === "namespace") {
      if (allowed) return true;
      node.remove();
      return false;
    }
    if (!(node.type === "atrule" && ["charset", "import"].includes(node.name.toLowerCase()))) allowed = false;
    return false;
  });
  const context = stylesheetNamespaceContext(declarations.map(node => node.toString() + ";"));
  for (const node of declarations) node.remove();
  root.walkRules(rule => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
    rule.selector = context.selector(rule.selector);
  });
  root.walkAtRules(rule => { rule.params = rewriteNamespacePrelude(rule.params, rule.name, context.selector); });
  return context.preamble + "\n" + root.toString();
}
