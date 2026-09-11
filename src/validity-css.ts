const VALIDITY_PSEUDOS = [
  [":user-invalid", ":is(:user-invalid, [data-user-invalid])"],
  [":invalid", ":is(:invalid, [data-invalid])"],
  [":valid", ":is(:valid, [data-valid])"],
] as const;

const GROUPING_AT_RULES = new Set([
  "container",
  "document",
  "layer",
  "media",
  "scope",
  "starting-style",
  "supports",
]);

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value);
}

function rewriteSelector(selector: string): string {
  let output = "";
  let quote: "\"" | "'" | undefined;

  for (let index = 0; index < selector.length;) {
    const character = selector[index]!;
    if (quote !== undefined) {
      output += character;
      if (character === "\\" && index + 1 < selector.length) {
        output += selector[index + 1]!;
        index += 2;
        continue;
      }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && selector[index + 1] === "*") {
      const end = selector.indexOf("*/", index + 2);
      const next = end === -1 ? selector.length : end + 2;
      output += selector.slice(index, next);
      index = next;
      continue;
    }

    let replacement: string | undefined;
    let matchedLength = 0;
    if (character === ":" && selector[index - 1] !== "\\") {
      for (const [pseudo, mirror] of VALIDITY_PSEUDOS) {
        if (
          selector.startsWith(pseudo, index) &&
          !isIdentifierCharacter(selector[index + pseudo.length])
        ) {
          replacement = mirror;
          matchedLength = pseudo.length;
          break;
        }
      }
    }

    if (replacement !== undefined) {
      output += replacement;
      index += matchedLength;
    } else {
      output += character;
      index += 1;
    }
  }
  return output;
}

function findBlockEnd(css: string, openingBrace: number): number {
  let depth = 1;
  let quote: "\"" | "'" | undefined;

  for (let index = openingBrace + 1; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) return css.length - 1;
      index = end + 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return css.length - 1;
}

function rewriteRuleList(css: string): string {
  let output = "";
  let ruleStart = 0;
  let quote: "\"" | "'" | undefined;
  let parentheses = 0;
  let brackets = 0;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && character === ";") {
      output += css.slice(ruleStart, index + 1);
      ruleStart = index + 1;
    } else if (parentheses === 0 && brackets === 0 && character === "{") {
      const blockEnd = findBlockEnd(css, index);
      const prelude = css.slice(ruleStart, index);
      const body = css.slice(index + 1, blockEnd);
      const atRule = /^\s*@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
      const nextPrelude = atRule === undefined ? rewriteSelector(prelude) : prelude;
      const nextBody = atRule !== undefined && GROUPING_AT_RULES.has(atRule)
        ? rewriteRuleList(body)
        : body;
      output += `${nextPrelude}{${nextBody}}`;
      index = blockEnd;
      ruleStart = blockEnd + 1;
    }
  }
  return output + css.slice(ruleStart);
}

/**
 * Add the internal state mirrors that let authors use the proposed `:valid` and `:invalid`
 * surface before browsers expose those pseudo-classes on arbitrary elements.
 */
export function rewriteValiditySelectors(css: string): string {
  return rewriteRuleList(css);
}
