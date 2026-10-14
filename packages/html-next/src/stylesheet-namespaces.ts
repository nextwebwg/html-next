import { decodeCSS } from "./stylesheet-resources.js";

const IDENT = String.raw`(?:[\w\u0080-\uffff-]|\\(?:[\da-f]{1,6}\s?|[^\r\n\f]))+`;
const IDENT_START = new RegExp(`^${IDENT}`, "i");
const QUALIFIED = new RegExp(`^(${IDENT}|\\*)?\\|(?![=|])`, "i");
const STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;
const ATTRIBUTE = String.raw`\[(?:${STRING}|[^\]"'])*\]`;
const NAMESPACE = new RegExp(String.raw`@namespace\s+(?:(${IDENT})\s+)?(?:(${STRING})|url\(\s*(?:(${STRING})|((?:\\(?:[\da-f]{1,6}\s?|[^\r\n\f])|[^\s)\\])*))\s*\))\s*;`, "gi");

/** Moving only explicit namespace declarations leaves ordinary selectors namespace-neutral. */
export function hoistStylesheetNamespaces(css: string): string {
  if (!/@namespace\b/i.test(css)) return css;
  const declarations = new Set<string>();
  const token = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}|${NAMESPACE.source}`, "gi");
  const body = css.replace(token, match => {
    if (!/^@namespace\s+htmlnextns[0-9a-f]+\s/i.test(match)) return match;
    declarations.add(match);
    return "";
  });
  return [...declarations, body].join("\n");
}

/** Namespace URIs are identifiers, never resource URLs. Encode every code unit to avoid collisions. */
export function stylesheetNamespaceContext(declarations: readonly string[]): {
  readonly preamble: string;
  readonly selector: (value: string, ignoreSubjectDefault?: boolean) => string;
} {
  const prefixes = new Map<string, string>();
  const uris = new Map<string, string>();
  for (const declaration of declarations) {
    NAMESPACE.lastIndex = 0;
    const match = NAMESPACE.exec(declaration.replace(new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}`, "g"), token => token.startsWith("/*") ? " " : token));
    if (match === null) continue;
    const value = match[2] ?? match[3] ?? match[4]!;
    const uri = decodeCSS(value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value);
    const prefix = `htmlnextns${Array.from({ length: uri.length }, (_, index) => uri.charCodeAt(index).toString(16).padStart(4, "0")).join("") || "0"}`;
    prefixes.set(decodeCSS(match[1] ?? ""), prefix);
    uris.set(prefix, uri);
  }
  const rename = (prefix: string): string => prefixes.get(decodeCSS(prefix)) ?? prefix;
  const selector = (value: string, ignoreSubjectDefault = false): string => {
    value = value.replace(new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}`, "g"), token => token.startsWith("/*") ? "" : token);
    // Split only top-level compounds; strings, attributes and functional selectors are opaque here.
    const parts = value.match(new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}|\\(?:[\da-f]{1,6}\s?|[\s\S])|\|\||[^]`, "gi")) ?? [];
    let depth = 0;
    let compound = "";
    let output = "";
    const emit = (subject: boolean): void => {
      if (compound === "") return;
      let rewritten = compound;
      const qualified = QUALIFIED.exec(compound);
      const type = IDENT_START.exec(compound)?.[0] ?? (compound.startsWith("*") ? "*" : undefined);
      if (qualified !== null) rewritten = (qualified[1] === undefined ? "" : rename(qualified[1])) + compound.slice((qualified[1] ?? "").length);
      else if (prefixes.has("") && !compound.startsWith("&") && (!subject || !ignoreSubjectDefault || type !== undefined)) {
        rewritten = `${prefixes.get("")}|${type === undefined ? "*" : ""}${compound}`;
      }
      // Attributes have no default namespace; qualify only explicitly prefixed attribute names.
      rewritten = rewritten.replace(new RegExp(`${STRING}|${ATTRIBUTE}`, "g"), token => token.startsWith("[")
        ? token.replace(new RegExp(String.raw`^\[(\s*)(${IDENT})\|(?![=|])`, "i"), (_match, space: string, prefix: string) => `[${space}${rename(prefix)}|`)
        : token);
      rewritten = rewriteFunctions(rewritten, selector);
      output += rewritten;
      compound = "";
    };
    for (const [index, part] of parts.entries()) {
      if (part.length > 1 && part !== "||") { compound += part; continue; }
      if (part === "(" || part === "[") depth += 1;
      else if (part === ")" || part === "]") depth -= 1;
      if (depth === 0 && (part === "||" || /[\s>+~,]/.test(part))) {
        let next = index;
        while (next < parts.length && /^\s+$/.test(parts[next]!)) next += 1;
        emit(part === "," || next === parts.length || parts[next] === ",");
        output += part;
      } else compound += part;
    }
    emit(true);
    return output;
  };
  return { preamble: [...uris].map(([prefix, uri]) => `@namespace ${prefix} ${quoteCSSString(uri)};`).join("\n"), selector };
}

/** Recurse only into selector-valued functions; contract tests and arbitrary functions stay intact. */
function rewriteFunctions(value: string, selector: (value: string, ignoreSubjectDefault?: boolean) => string): string {
  let output = "";
  let start = 0;
  const functions = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}|${ATTRIBUTE}|:(${IDENT})\(`, "gi");
  for (let match = functions.exec(value); match !== null; match = functions.exec(value)) {
    if (match[1] === undefined) continue;
    const name = decodeCSS(match[1]).toLowerCase();
    if (!["is", "where", "not", "has", "slotted", "nth-child", "nth-last-child"].includes(name)) continue;
    const open = functions.lastIndex;
    const index = closingParenthesis(value, open);
    const argument = value.slice(open, index - 1);
    const nth = name.startsWith("nth-") ? /^(.*?\bof\s+)([\s\S]*)$/i.exec(argument) : null;
    const rewritten = name.startsWith("nth-") ? (nth === null ? argument : nth[1]! + selector(nth[2]!))
      : selector(argument, ["is", "where", "not"].includes(name));
    output += value.slice(start, open) + rewritten + ")";
    start = index;
    functions.lastIndex = index;
  }
  return output + value.slice(start);
}

/** @scope bounds and supports selector() contain selectors rather than declarations. */
export function rewriteNamespacePrelude(value: string, name: string, selector: (value: string) => string): string {
  const scope = name.toLowerCase() === "scope";
  if (!scope && name.toLowerCase() !== "supports") return value;
  const starts = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${STRING}|${scope ? "\\(" : "selector\\("}`, "gi");
  let output = "";
  let start = 0;
  for (let match = starts.exec(value); match !== null; match = starts.exec(value)) {
    if (!match[0].endsWith("(")) continue;
    const open = starts.lastIndex;
    const end = closingParenthesis(value, open);
    output += value.slice(start, open) + selector(value.slice(open, end - 1)) + ")";
    start = end;
    starts.lastIndex = end;
  }
  return output + value.slice(start);
}

/** Find the end of a balanced function without treating quoted or escaped parentheses as syntax. */
function closingParenthesis(value: string, open: number): number {
  let depth = 1;
  let quote = "";
  let index = open;
  for (; index < value.length && depth > 0; index += 1) {
    const character = value[index]!;
    if (character === "\\") { index += 1; continue; }
    if (quote === "" && value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      index = end === -1 ? value.length : end + 1;
      continue;
    }
    if (quote !== "") { if (character === quote) quote = ""; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
  }
  return index;
}

function quoteCSSString(value: string): string {
  return '"' + Array.from(value, character => {
    const code = character.charCodeAt(0);
    return character === '"' || character === "\\" || code < 32 || code === 127 ? `\\${code.toString(16)} ` : character;
  }).join("") + '"';
}
