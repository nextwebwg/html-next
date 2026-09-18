export type ComponentStyleMode = "scope" | "attribute";

export interface ComponentStyleOptions {
  readonly mode?: ComponentStyleMode;
  readonly rootElement?: string;
}

export const COMPONENT_PROVENANCE_ATTRIBUTE = "data-component";
export const COMPONENT_ROOT_ATTRIBUTE = "data-component-root";
export const PROJECTED_ROOT_ATTRIBUTE = "data-slotted";

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

const SELECTOR_FUNCTIONS = new Set(["has", "is", "not", "where"]);

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value);
}

function matchingParenthesis(value: string, opening: number): number {
  let depth = 1;
  let quote: "\"" | "'" | undefined;
  let brackets = 0;
  for (let index = opening + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end === -1) return value.length - 1;
      index = end + 1;
      continue;
    }
    if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (brackets === 0 && character === "(") depth += 1;
    else if (brackets === 0 && character === ")" && --depth === 0) return index;
  }
  return value.length - 1;
}

function splitSelectorList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
    } else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (brackets === 0 && character === "(") parentheses += 1;
    else if (brackets === 0 && character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (brackets === 0 && parentheses === 0 && character === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function lastCompoundStart(selector: string): number {
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "/" && selector[index + 1] === "*") {
      const end = selector.indexOf("*/", index + 2);
      if (end === -1) return start;
      index = end + 1;
    } else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (brackets === 0 && character === "(") parentheses += 1;
    else if (brackets === 0 && character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (brackets === 0 && parentheses === 0) {
      if (character === ">" || character === "+" || character === "~") {
        start = index + 1;
      } else if (/\s/.test(character)) {
        let next = index;
        while (next + 1 < selector.length && /\s/.test(selector[next + 1]!)) next += 1;
        if (selector[next + 1] !== undefined && !/[>+~]/.test(selector[next + 1]!)) start = next + 1;
        index = next;
      }
    }
  }
  while (start < selector.length && /\s/.test(selector[start]!)) start += 1;
  return start;
}

function pseudoElementIndex(compound: string): number {
  let parentheses = 0;
  let brackets = 0;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < compound.length - 1; index += 1) {
    const character = compound[index]!;
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (brackets === 0 && character === "(") parentheses += 1;
    else if (brackets === 0 && character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (brackets === 0 && parentheses === 0 && character === ":" && compound[index + 1] === ":") {
      return index;
    }
  }
  return compound.length;
}

function addSubjectProvenance(selector: string, owner: string): string {
  const token = `:where([${COMPONENT_PROVENANCE_ATTRIBUTE}~="${owner}"])`;
  const end = selector.search(/\s*$/);
  const body = selector.slice(0, end);
  const trailing = selector.slice(end);
  const start = lastCompoundStart(body);
  const compound = body.slice(start);
  if (compound.includes(token)) return selector;
  const pseudo = pseudoElementIndex(compound);
  return `${body.slice(0, start)}${compound.slice(0, pseudo)}${token}${compound.slice(pseudo)}${trailing}`;
}

function rewriteSelectorSyntax(
  selector: string,
  owner: string | undefined,
  mode: ComponentStyleMode | undefined,
  rootElement: string | undefined,
): string {
  let output = "";
  let compoundStart = true;
  for (let index = 0; index < selector.length;) {
    const character = selector[index]!;
    if (character === "\"" || character === "'") {
      const quote = character;
      let end = index + 1;
      while (end < selector.length) {
        if (selector[end] === "\\") end += 2;
        else if (selector[end++] === quote) break;
      }
      output += selector.slice(index, end);
      index = end;
      continue;
    }
    if (character === "/" && selector[index + 1] === "*") {
      const found = selector.indexOf("*/", index + 2);
      const end = found === -1 ? selector.length : found + 2;
      output += selector.slice(index, end);
      index = end;
      continue;
    }
    if (character === "[") {
      let end = index + 1;
      let quote: "\"" | "'" | undefined;
      while (end < selector.length) {
        const current = selector[end]!;
        if (quote !== undefined) {
          if (current === "\\") end += 2;
          else {
            if (current === quote) quote = undefined;
            end += 1;
          }
        } else if (current === "\"" || current === "'") {
          quote = current;
          end += 1;
        } else if (current === "]") {
          end += 1;
          break;
        } else end += 1;
      }
      output += selector.slice(index, end);
      index = end;
      compoundStart = false;
      continue;
    }
    if (character === ":") {
      let nameEnd = index + 1;
      while (isIdentifierCharacter(selector[nameEnd])) nameEnd += 1;
      const name = selector.slice(index + 1, nameEnd).toLowerCase();
      let validityMatched = false;
      for (const [pseudo, mirror] of VALIDITY_PSEUDOS) {
        if (selector.startsWith(mirror, index)) {
          output += mirror;
          index += mirror.length;
          compoundStart = false;
          validityMatched = true;
          break;
        }
        if (selector.startsWith(pseudo, index) && !isIdentifierCharacter(selector[index + pseudo.length])) {
          output += mirror;
          index += pseudo.length;
          compoundStart = false;
          validityMatched = true;
          break;
        }
      }
      if (validityMatched) continue;
      if (name === "scope" && owner !== undefined && mode === "attribute") {
        output += `:is(:where([${COMPONENT_ROOT_ATTRIBUTE}~="${owner}"]), ${owner})`;
        index = nameEnd;
        compoundStart = false;
        continue;
      }
      if (selector[nameEnd] === "(") {
        const end = matchingParenthesis(selector, nameEnd);
        const body = selector.slice(nameEnd + 1, end);
        const rewritten = SELECTOR_FUNCTIONS.has(name)
          ? rewriteSelectorList(body, owner, mode, rootElement, name === "has" && owner !== undefined)
          : body;
        output += `${selector.slice(index, nameEnd + 1)}${rewritten})`;
        index = end + 1;
      } else {
        output += selector.slice(index, nameEnd);
        index = nameEnd;
      }
      compoundStart = false;
      continue;
    }
    if (compoundStart && /[A-Za-z]/.test(character)) {
      let end = index + 1;
      while (isIdentifierCharacter(selector[end])) end += 1;
      const name = selector.slice(index, end);
      const typeSelector = name.includes("-")
        ? `:is(:where([${COMPONENT_ROOT_ATTRIBUTE}~="${name.toLowerCase()}"]), ${name})`
        : name;
      output += mode === "scope" && name.toLowerCase() === rootElement?.toLowerCase()
        ? `:is(${typeSelector}, :where(:scope))`
        : typeSelector;
      index = end;
      compoundStart = false;
      continue;
    }
    output += character;
    index += 1;
    if (character === "," || character === ">" || character === "+" || character === "~" || /\s/.test(character)) {
      compoundStart = true;
    } else if (character !== "|") {
      compoundStart = false;
    }
  }
  return output;
}

function rewriteSelectorList(
  selectors: string,
  owner: string | undefined,
  mode: ComponentStyleMode | undefined,
  rootElement: string | undefined,
  addProvenance: boolean,
): string {
  return splitSelectorList(selectors).map((part) => {
    const leading = /^\s*/.exec(part)![0];
    const trailing = /\s*$/.exec(part)![0];
    const body = part.slice(leading.length, part.length - trailing.length);
    if (body === "") return part;
    const rewritten = rewriteSelectorSyntax(body, owner, mode, rootElement);
    return `${leading}${addProvenance && owner !== undefined ? addSubjectProvenance(rewritten, owner) : rewritten}${trailing}`;
  }).join(",");
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
    if (character === "\"" || character === "'") quote = character;
    else if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) return css.length - 1;
      index = end + 1;
    } else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return css.length - 1;
}

function rewriteRuleList(
  css: string,
  owner: string | undefined,
  mode: ComponentStyleMode | undefined,
  rootElement?: string,
): string {
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
    if (character === "\"" || character === "'") quote = character;
    else if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
    } else if (character === "(") parentheses += 1;
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
      const nextPrelude = atRule === undefined
        ? rewriteSelectorList(
            prelude,
            owner,
            mode,
            rootElement,
            owner !== undefined && mode === "attribute",
          )
        : prelude;
      const nextBody = atRule === undefined || GROUPING_AT_RULES.has(atRule)
        ? rewriteRuleList(body, owner, mode, rootElement)
        : body;
      output += `${nextPrelude}{${nextBody}}`;
      index = blockEnd;
      ruleStart = blockEnd + 1;
    }
  }
  return output + css.slice(ruleStart);
}

/** Mirror proposed validity selectors without changing selector scope. */
export function transformValidityStyles(css: string): string {
  return rewriteRuleList(css, undefined, undefined, undefined);
}

/** Split top-level rules into those whose selector opts into projected content and the rest. */
function partitionSlotted(css: string): { normal: string; slotted: string } {
  let normal = "";
  let slotted = "";
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
    if (character === "\"" || character === "'") quote = character;
    else if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
    } else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && character === ";") {
      normal += css.slice(ruleStart, index + 1);
      ruleStart = index + 1;
    } else if (parentheses === 0 && brackets === 0 && character === "{") {
      const blockEnd = findBlockEnd(css, index);
      const prelude = css.slice(ruleStart, index);
      const rule = css.slice(ruleStart, blockEnd + 1);
      if (!/^\s*@/.test(prelude) && prelude.includes(":slotted(")) slotted += rule;
      else normal += rule;
      index = blockEnd;
      ruleStart = blockEnd + 1;
    }
  }
  return { normal: normal + css.slice(ruleStart), slotted };
}

/** Anchor one `:slotted(arg)` to a projected region rooted at `rootSel` as a self-contained selector. */
function slottedSubject(arg: string, rootSel: string): string {
  const trimmed = arg.trim();
  if (trimmed.startsWith(">")) {
    const rest = trimmed.slice(1).trim();
    return rest === "" || rest === "*"
      ? `${rootSel} [${PROJECTED_ROOT_ATTRIBUTE}]`
      : `${rootSel} [${PROJECTED_ROOT_ATTRIBUTE}]:is(${rest})`;
  }
  const region = `:where([${PROJECTED_ROOT_ATTRIBUTE}], [${PROJECTED_ROOT_ATTRIBUTE}] *)`;
  return trimmed === "" || trimmed === "*" ? `${rootSel} ${region}` : `${rootSel} ${region}:is(${trimmed})`;
}

/** Replace every `:slotted(...)` in one selector with its anchored light-DOM form. A leading
 *  `:scope<conds>` state condition on the root folds into the projected anchor. */
function rewriteSlottedSelector(selector: string, owner: string): string {
  const root = `[${COMPONENT_ROOT_ATTRIBUTE}~="${owner}"]`;
  const scoped = /^\s*:scope((?:\[[^\]]*\]|[.:#][\w-]+)*)\s+(?=:slotted\()/.exec(selector);
  const rootSel = scoped ? `${root}${scoped[1]}` : root;
  const body = scoped ? selector.slice(scoped[0].length) : selector;
  let output = "";
  let index = 0;
  for (;;) {
    const at = body.indexOf(":slotted(", index);
    if (at === -1) { output += body.slice(index); return output; }
    output += body.slice(index, at);
    const open = at + ":slotted".length;
    const close = matchingParenthesis(body, open);
    output += slottedSubject(body.slice(open + 1, close), rootSel);
    index = close + 1;
  }
}

/** Rewrite the projected-content rules extracted by partitionSlotted. They are self-scoped, so
 *  they are emitted outside the component's `@scope`, whose lower limit excludes projected roots. */
function rewriteSlottedRuleList(css: string, owner: string): string {
  let output = "";
  let ruleStart = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      const blockEnd = findBlockEnd(css, index);
      const prelude = css.slice(ruleStart, index);
      const body = css.slice(index + 1, blockEnd);
      const selectors = splitSelectorList(prelude)
        .map((part) => rewriteSlottedSelector(part, owner)).join(",");
      output += `${selectors}{${body}}`;
      index = blockEnd;
      ruleStart = blockEnd + 1;
    }
  }
  return output + css.slice(ruleStart);
}

/**
 * Compile one component style block. Native scope uses DOM boundaries; the fallback uses
 * the same authored-provenance tokens that converters emit. `:slotted()` rules opt into the
 * component's projected content and compile to self-contained selectors outside the scope.
 */
export function transformComponentStyles(
  css: string,
  owner: string,
  options: ComponentStyleOptions = {},
): string {
  if (css === "") return "";
  const mode = options.mode ?? "attribute";
  const { normal, slotted } = partitionSlotted(css);
  const normalRules = rewriteRuleList(normal, owner, mode, options.rootElement);
  const scoped = normalRules.trim() === ""
    ? ""
    : mode === "attribute"
      ? normalRules
      : `@scope ([${COMPONENT_ROOT_ATTRIBUTE}~="${owner}"]) to (:scope [${COMPONENT_ROOT_ATTRIBUTE}] > *, [${PROJECTED_ROOT_ATTRIBUTE}]) {\n${normalRules}\n}`;
  const slottedRules = slotted.trim() === "" ? "" : rewriteSlottedRuleList(slotted, owner);
  return [scoped, slottedRules].filter((part) => part !== "").join("\n");
}

/** Rewrites custom-element and validity selectors in application/global CSS without scoping them. */
export function transformGlobalStyles(css: string): string {
  return rewriteRuleList(css, undefined, undefined);
}

export function componentStyleMode(document: Document): ComponentStyleMode {
  return "CSSScopeRule" in (document.defaultView ?? {}) ? "scope" : "attribute";
}

export function addAttributeToken(element: Element, attribute: string, token: string): void {
  const tokens = new Set((element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean));
  tokens.add(token);
  element.setAttribute(attribute, [...tokens].join(" "));
}

export function stampAuthoredElement(element: Element, owner: string): void {
  addAttributeToken(element, COMPONENT_PROVENANCE_ATTRIBUTE, owner);
}

export function stampComponentRoot(element: Element, owner: string): void {
  stampAuthoredElement(element, owner);
  addAttributeToken(element, COMPONENT_ROOT_ATTRIBUTE, owner);
}

export function markProjectedRoot(node: Node): void {
  if (node.nodeType === 1) {
    (node as Element).setAttribute(PROJECTED_ROOT_ATTRIBUTE, "");
  }
}
