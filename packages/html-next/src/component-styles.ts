import { normalizeStylesheetNamespacesInBrowser } from "./stylesheet-namespaces-browser.js";
/**
 * Component style compilation (nextwebwg.org/html-next/styling).
 *
 * A style block applies to its component's region: from the root (`[data-component~="tag"]`) down
 * to nested component roots and projected content. `:host` selects the root, `:host-state()` the root
 * while resolved state matches, `:host([prop])` resolved props, and `:slotted()` projected content
 * at any depth.
 *
 * The browser needs no CSS parser: the three pseudo-classes are renamed into selectors it accepts, it
 * parses the block twice (the component's own markup, and projected content), each copy drops the
 * other's rules, and the remaining selectors are rewritten through the CSS Object Model. Build tools
 * run the same selector rewrite over a CSS parser (`component-styles-build.ts`).
 */
import { fail } from "./diagnostics.js";
import type { ComponentDefinition } from "./template.js";
import { parseTypeExpression } from "./type-system.js";
import { rewriteValiditySelectors } from "./validity-css.js";

/** Names a component on its root, and only its root. Delegated roots list every owner. */
export const COMPONENT_ATTRIBUTE = "data-component";
/** Marks each top-level projected node. */
export const PROJECTED_ATTRIBUTE = "data-slotted";

// A private inherited value keeps Firefox SVG styles inside their scope limits.
// Roots override the normal reset even when their authored sheet is in a cascade layer.
const SCOPE_OWNER = "--html-next-scope-owner";
export const COMPONENT_STYLE_BOUNDARIES = `@supports (-moz-appearance: none) {
:where([data-component], [data-slotted]) { --html-next-scope-owner: boundary; }
:where([data-slotted]:not([data-component])) { --html-next-scope-owner: projected !important; }
}`;

export function addAttributeToken(element: Element, attribute: string, token: string): void {
  const tokens = new Set((element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean));
  tokens.add(token);
  element.setAttribute(attribute, Array.from(tokens).join(" "));
}

export function markProjectedRoot(node: Node): void {
  if (node.nodeType === 1) (node as Element).setAttribute(PROJECTED_ATTRIBUTE, "");
}

/** The attribute carrying the resolved prop and state values a definition's rules test. */
export function stateAttribute(tag: string): string {
  return `data-${tag}-state`;
}

export type StyleRuleKind = "own" | "slotted";

const SENTINEL = { slotted: "[--slotted]", state: "[--state]" } as const;
const RENAMABLE = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|:(slotted|host-state)\(/g;

/**
 * Renames `:slotted(` and `:host-state(` into valid selectors, skipping comments and strings. A
 * target that has its own `:slotted()` (Vue) renames only `:host-state(`.
 */
export function renameComponentPseudoClasses(css: string, kinds: readonly ("slotted" | "host-state")[] = ["slotted", "host-state"]): string {
  return css.replace(RENAMABLE, (match, kind: "slotted" | "host-state" | undefined) =>
    kind === undefined || !kinds.includes(kind) ? match : `:where(${kind === "slotted" ? SENTINEL.slotted : SENTINEL.state}):is(`);
}

/** Constructed sheets discard imports, so synchronous compilation must diagnose them first. */
export function assertResolvedStylesheet(css: string, source?: string): void {
  const rules = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, "");
  if (/@import\b/i.test(rules)) {
    fail("HY004", "Resolve component stylesheet imports with loadNodeComponents() or startBrowserComponents() before synchronous style compilation.", source);
  }
}

/** Whether a renamed selector belongs to projected content rather than the component's own markup. */
export function styleRuleKind(selector: string): StyleRuleKind {
  return /:where\(\s*\[--slotted\]\s*\)/.test(selector) ? "slotted" : "own";
}

/** Index of the parenthesis that closes the one opened at `open`, skipping strings. */
function closingParenthesis(value: string, open: number): number {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\"" || character === "'") {
      const end = value.indexOf(character, index + 1);
      index = end === -1 ? value.length : end;
    } else if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  return value.length;
}

const ATTRIBUTE_TEST = /\[(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]"'])*\]/g;
const STATE_TEST = /^\[\s*([\w-]+)\s*(?:=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\]\s]+))\s*)?\]$/;
type StyleTestKind = "prop" | "state";
type StyleNameResolver = (name: string, kind: StyleTestKind) => string;

/** `[name]` and `[name="value"]` tests as tokens of the state attribute. */
function stateTokens(tests: string, tag: string, names: Set<string>, canonical: StyleNameResolver,
  kind: StyleTestKind): string {
  const selector = kind === "prop" ? ":host()" : ":host-state()";
  if (kind === "state" && tests.replace(ATTRIBUTE_TEST, "").trim() !== "") {
    fail("HY002", `\`${selector}\` supports only presence and equality tests on declared values.`);
  }
  const output = tests.replace(ATTRIBUTE_TEST, (test) => {
    const match = STATE_TEST.exec(test);
    if (match === null) fail("HY002", `\`${selector}\` supports only presence and equality tests on declared values.`);
    const name = canonical(match[1]!, kind);
    const value = match[2] ?? match[3] ?? match[4];
    names.add(name);
    return `[${stateAttribute(tag)}~="${value === undefined ? name : `${name}=${encodeURIComponent(value)}`}"]`;
  });
  return kind === "state" ? output.replace(/\s+/g, "") : output;
}

/**
 * What a component's root is in the default build: its `data-component` owner list. `namespace` is
 * the type selector's authored prefix (`n|`), which the root test keeps.
 */
const componentOwner = (tag: string, namespace = ""): string =>
  `:where(${namespace === "" ? "" : namespace + "*"}[${COMPONENT_ATTRIBUTE}~="${tag}"])`;

/** Type selectors naming components, outside brackets and strings. */
function rewriteComponentTags(selector: string, componentRoot: (tag: string, namespace: string) => string): string {
  let output = "";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "[") {
      const end = selector.indexOf("]", index);
      const stop = end === -1 ? selector.length : end + 1;
      output += selector.slice(index, stop);
      index = stop - 1;
      continue;
    }
    const previous = output.at(-1);
    const namespace = previous === "|" ? /(?:[\w-]+|\*)?\|$/.exec(output)?.[0] : undefined;
    const startsCompound = previous === undefined || /[\s>+~(,]/.test(previous) || namespace !== undefined;
    const tag = startsCompound ? /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\w-]|\()/.exec(selector.slice(index))?.[0] : undefined;
    if (tag !== undefined) {
      if (namespace !== undefined) output = output.slice(0, -namespace.length);
      output += `:is(${namespace ?? ""}${tag}, ${componentRoot(tag, namespace ?? "")})`;
      index += tag.length - 1;
      continue;
    }
    output += character;
  }
  return output;
}

/**
 * Rewrites one renamed selector. `host` is what `:host` becomes: `:scope` inside the component's
 * `@scope` rules (both of them are rooted at the component root), or an explicit root selector
 * supplied by another build target.
 */
export function rewriteComponentSelector(
  selector: string,
  tag: string,
  host: string,
  names: Set<string>,
  canonical: StyleNameResolver = (name) => name,
  projected: string = `[${PROJECTED_ATTRIBUTE}], [${PROJECTED_ATTRIBUTE}] *`,
  componentRoot: (tag: string, namespace: string) => string = componentOwner,
): string {
  if (/:scope(?![\w-])/.test(selector)) {
    fail("HY003", `\`:scope\` is not part of component styles; select the root with \`:host\` (in <${tag}>).`);
  }
  let output = "";
  let index = 0;
  const resolved = /:where\(\s*\[--state\]\s*\):is\(|:host\(/g;
  for (let match = resolved.exec(selector); match !== null; match = resolved.exec(selector)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(selector, open);
    const kind = match[0] === ":host(" ? "prop" : "state";
    output += `${selector.slice(index, match.index)}${host}${stateTokens(selector.slice(open + 1, close), tag, names, canonical, kind)}`;
    index = close + 1;
    resolved.lastIndex = index;
  }
  output += selector.slice(index);
  output = output
    .replace(/:where\(\s*\[--slotted\]\s*\):is\(/g, `:where(${projected}):is(`)
    .replace(/:host(?![\w-])/g, host);
  return rewriteComponentTags(rewriteValiditySelectors(output), componentRoot);
}

/** Firefox can leak a selector list containing pseudo-elements through an @scope limit. */
export function guardComponentPseudoElements(selector: string): string {
  if (!selector.includes("::")) return selector;
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let pseudo = -1;
  let subject = 0;
  const emit = (end: number): void => {
    const at = pseudo === -1 ? end : pseudo;
    const guard = /:scope(?![\w-])/.test(selector.slice(subject, at)) ? ""
      : `:where(:not([${COMPONENT_ATTRIBUTE}], [${PROJECTED_ATTRIBUTE}]))`;
    const prefix = selector.slice(start, at);
    parts.push((pseudo === -1 ? prefix.trimEnd() : prefix) + guard + selector.slice(at, end));
    start = end + 1;
    pseudo = -1;
    subject = end + 1;
  };
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "\\") { index += 1; continue; }
    if (quote !== "") { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (depth === 0 && character === ":" && selector[index + 1] === ":" && pseudo === -1) pseudo = index;
    else if (depth === 0 && character === ",") emit(index);
    else if (depth === 0 && /[\s>+~]/.test(character)) subject = index + 1;
  }
  emit(selector.length);
  return parts.join(", ");
}

/** Wraps the compiled groups in the component's two scopes; `hoisted` rules stay document-wide. */
export function assembleComponentStyles(tag: string | readonly string[], own: string, slotted: string, hoisted: string,
  projectedBoundary = `[${PROJECTED_ATTRIBUTE}]`, includeBoundaryReset = true): string {
  const tags = typeof tag === "string" ? [tag] : tag;
  const root = tags.map(name => `[${COMPONENT_ATTRIBUTE}~="${name}"]`).join(", ");
  const scoped = own.trim() !== "" || slotted.trim() !== "";
  const identities = tags.map(name => `[${COMPONENT_ATTRIBUTE}~="${name}"] { ${SCOPE_OWNER}: "${name}" !important; }`).join("\n");
  const projected = projectedBoundary === `[${PROJECTED_ATTRIBUTE}]` ? ""
    : `@scope (${root}) to ([${COMPONENT_ATTRIBUTE}]) { :where(${projectedBoundary}) { ${SCOPE_OWNER}: projected !important; } }`;
  return [
    hoisted,
    scoped && includeBoundaryReset ? COMPONENT_STYLE_BOUNDARIES : "",
    scoped ? `@supports (-moz-appearance: none) {\n${identities}${projected === "" ? "" : "\n" + projected}\n}` : "",
    own.trim() === "" ? "" : `@scope (${root}) to ([${COMPONENT_ATTRIBUTE}], ${projectedBoundary}) {\n${own}\n}`,
    slotted.trim() === "" ? "" : `@scope (${root}) to ([${COMPONENT_ATTRIBUTE}]) {\n${slotted}\n}`,
  ].filter((part) => part !== "").join("\n");
}

/** Scalars, keywords, and unions of them can be tested; lists, records, and objects cannot. */
function stylableType(type: unknown): boolean {
  if (typeof type === "string") return !["event", "function", "unknown", "trusted-html", "trusted-script"].includes(type);
  if (type === null || typeof type !== "object") return false;
  const node = type as { kind?: string; name?: string; members?: readonly unknown[]; options?: readonly { type: unknown }[] };
  if (node.kind === "terminal") return stylableType(node.name);
  if (node.kind === "union") return (node.members ?? []).every(stylableType);
  if (node.kind === "constrained") return stylableType((type as { base: unknown }).base);
  if (node.kind === "selected") return (node.options ?? []).every((option) => stylableType(option.type));
  return node.kind === "keyword";
}

/** Resolves declared-value tests and checks their prop/state namespace and scalar type. */
export function componentStyleNameResolver(definition: ComponentDefinition, source?: string,
  ignoreCase = false): StyleNameResolver {
  const states = new Map<string, unknown>();
  for (const declaration of definition.declarations ?? []) {
    if (declaration.kind === "state" || declaration.kind === "computed") {
      const expression = declaration.expression?.ast;
      const structure = expression?.kind === "array" || expression?.kind === "object" ? expression : undefined;
      states.set(declaration.name, declaration.shape ?? declaration.type ?? structure);
    }
  }
  // CSSOM serializes attribute names in lowercase; resolve them back to their authored names.
  const declared = ignoreCase ? new Map([
    ...Object.keys(definition.contract.props), ...states.keys(),
  ].map((name) => [name.toLowerCase(), name])) : undefined;
  return (input, kind) => {
    const name = declared?.get(input.toLowerCase()) ?? input;
    const selector = kind === "prop" ? ":host()" : ":host-state()";
    const prop = definition.contract.props[name];
    if (kind === "prop" ? prop === undefined : !states.has(name)) {
      const hint = kind === "state" && prop !== undefined ? ` Select the prop with \`:host([${name}])\`.` : "";
      fail("HY001", `\`${selector}\` tests \`${name}\`, which is not a declared ${kind === "prop" ? "prop" : "mutable or computed state"}.${hint}`, source);
    }
    const type = kind === "prop" ? prop!.type : states.get(name);
    if (type !== undefined && !stylableType(typeof type === "string" ? parseTypeExpression(type) : type)) {
      fail("HY002", `\`${selector}\` cannot test \`${name}\`, whose type is not scalar.`, source);
    }
    return name;
  };
}

export interface CompiledComponentStyles {
  readonly css: string;
  /** The props and state the state attribute must carry, in first-use order. */
  readonly stateNames: readonly string[];
  readonly stateNamesByTag?: Readonly<Record<string, readonly string[]>>;
  /** Vue: the components the template invokes, which bound the scope and carry their tag as a class. */
  readonly components?: readonly string[];
}

type RuleContainer = CSSStyleSheet | CSSGroupingRule;

/** Compiles a style block in a browser through the CSS Object Model. */
export function compileComponentStyles(
  css: string,
  definition: ComponentDefinition,
  document: Document,
  source?: string,
  adopters: readonly ComponentDefinition[] = [definition],
  includeBoundaryReset = true,
): CompiledComponentStyles {
  if (css.trim() === "") return { css: "", stateNames: [] };
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const Sheet = (document.defaultView ?? globalThis).CSSStyleSheet;
  const renamed = normalizeStylesheetNamespacesInBrowser(renameComponentPseudoClasses(css), document);
  const names = new Set<string>();
  const hoisted: string[] = [];

  const view = document.defaultView ?? globalThis;
  const StyleRule = view.CSSStyleRule;
  const GroupingRule = view.CSSGroupingRule;
  const owners = adopters.map(owner => ({ owner, names: new Set<string>(), canonical: componentStyleNameResolver(owner, source, true) }));
  const rewriteNested = (rule: CSSStyleRule): void => {
    const rewritten = [...new Set(owners.map(({ owner, names: ownerNames, canonical }) =>
      rewriteComponentSelector(rule.selectorText, owner.contract.tag, `:scope:where([${COMPONENT_ATTRIBUTE}~="${owner.contract.tag}"])`, ownerNames, canonical)))].join(", ");
    rule.selectorText = styleRuleKind(rule.selectorText) === "own" ? guardComponentPseudoElements(rewritten) : rewritten;
    for (const child of Array.from(rule.cssRules ?? [])) {
      if (child instanceof StyleRule) rewriteNested(child);
    }
  };
  // Keeps the rules of one kind, rewriting their selectors; grouping rules keep their structure.
  const prune = (container: RuleContainer, want: StyleRuleKind, topLevel: boolean): void => {
    // In source order, so state names are collected in first-use order, as build tools collect them.
    const rules = container.cssRules;
    for (let index = 0; index < rules.length;) {
      const rule = rules[index]!;
      if (rule.type === 10) {
        if (topLevel && want === "own") hoisted.push(rule.cssText);
        index += 1;
      } else if (rule instanceof StyleRule) {
        if (styleRuleKind(rule.selectorText) === want) {
          rewriteNested(rule);
          index += 1;
        } else container.deleteRule(index);
      } else if (rule instanceof GroupingRule) {
        prune(rule, want, false);
        index += 1;
      } else {
        if (!/^@(namespace|charset|import)\b/i.test(rule.cssText) && want === "own") { index += 1; continue; }
        // Only stylesheet preambles are hoisted; name-defining rules retain their context.
        if (want === "own" && !topLevel) index += 1;
        else {
          if (topLevel && want === "own") hoisted.push(rule.cssText);
          container.deleteRule(index);
        }
      }
    }
  };
  const compile = (want: StyleRuleKind): string => {
    const sheet = new Sheet();
    sheet.replaceSync(renamed);
    prune(sheet, want, true);
    return Array.from(sheet.cssRules).filter(rule => rule.type !== 10).map(rule => rule.cssText).join("\n");
  };
  const own = compile("own");
  const slotted = compile("slotted");
  for (const owner of owners) for (const name of owner.names) names.add(name);
  return { css: assembleComponentStyles(adopters.map(owner => owner.contract.tag), own, slotted, hoisted.join("\n"), undefined, includeBoundaryReset), stateNames: Array.from(names),
    ...(adopters.length <= 1 ? {} : { stateNamesByTag: Object.fromEntries(owners.map(({ owner, names: ownerNames }) => [owner.contract.tag, [...ownerNames]])) }) };
}

/** The state attribute's tokens for the current values: `name` while truthy, `name=value` for text. */
export function stateAttributeValue(names: readonly string[], read: (name: string) => unknown): string {
  const tokens: string[] = [];
  for (const name of names) {
    const value = read(name);
    const truthy = value === true || (typeof value === "string" && value.length > 0) ||
      (typeof value === "number" && value !== 0 && !Number.isNaN(value));
    if (truthy) tokens.push(name);
    if (typeof value === "string" || typeof value === "number") tokens.push(`${name}=${encodeURIComponent(String(value))}`);
  }
  return tokens.join(" ");
}
