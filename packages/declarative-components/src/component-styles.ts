/**
 * Component style compilation (nextwebwg.org/html-next/styling).
 *
 * A style block applies to its component's region: from the root (`[data-component~="tag"]`) down
 * to nested component roots and projected content. `:host` selects the root, `:host-state()` the root
 * while resolved props and state match, and `:slotted()` projected content at any depth.
 *
 * The browser needs no CSS parser: the three pseudo-classes are renamed into selectors it accepts, it
 * parses the block twice (the component's own markup, and projected content), each copy drops the
 * other's rules, and the remaining selectors are rewritten through the CSS Object Model. Build tools
 * run the same selector rewrite over a CSS parser (`component-styles-build.ts`).
 */
import { fail } from "./diagnostics.js";
import type { ComponentDefinition } from "./template.js";

/** Names a component on its root, and only its root. Delegated roots list every owner. */
export const COMPONENT_ATTRIBUTE = "data-component";
/** Marks each top-level projected node. */
export const PROJECTED_ATTRIBUTE = "data-slotted";

/** The attribute carrying the resolved values a definition's `:host-state()` rules test. */
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

const STATE_TEST = /\[\s*([\w-]+)\s*(?:=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\]\s]+))\s*)?\]/g;

/** `[name]` and `[name="value"]` tests as tokens of the state attribute. */
function stateTokens(tests: string, tag: string, names: Set<string>): string {
  let output = "";
  for (const match of tests.matchAll(STATE_TEST)) {
    const name = match[1]!;
    const value = match[2] ?? match[3] ?? match[4];
    names.add(name);
    output += `[${stateAttribute(tag)}~="${value === undefined ? name : `${name}=${encodeURIComponent(value)}`}"]`;
  }
  return output;
}

/** Type selectors naming components, outside brackets and strings. */
function rewriteComponentTags(selector: string): string {
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
    const startsCompound = previous === undefined || /[\s>+~(,]/.test(previous);
    const tag = startsCompound ? /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\w-]|\()/.exec(selector.slice(index))?.[0] : undefined;
    if (tag !== undefined) {
      output += `:is(${tag}, :where([${COMPONENT_ATTRIBUTE}~="${tag}"]))`;
      index += tag.length - 1;
      continue;
    }
    output += character;
  }
  return output;
}

/**
 * Rewrites one renamed selector for its scope. In the component's own scope `:host` is the scoping
 * root; in the projected-content scope it is the root's selector, since the subject is projected.
 */
export function rewriteComponentSelector(selector: string, tag: string, kind: StyleRuleKind, names: Set<string>): string {
  if (/:scope(?![\w-])/.test(selector)) {
    fail("HY003", `\`:scope\` is not part of component styles; select the root with \`:host\` (in <${tag}>).`);
  }
  const root = `[${COMPONENT_ATTRIBUTE}~="${tag}"]`;
  const host = kind === "own" ? ":scope" : root;
  let output = "";
  let index = 0;
  const state = /:where\(\s*\[--state\]\s*\):is\(/g;
  for (let match = state.exec(selector); match !== null; match = state.exec(selector)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(selector, open);
    output += `${selector.slice(index, match.index)}${host}${stateTokens(selector.slice(open + 1, close), tag, names)}`;
    index = close + 1;
    state.lastIndex = index;
  }
  output += selector.slice(index);
  output = output
    .replace(/:where\(\s*\[--slotted\]\s*\):is\(/g, `:where([${PROJECTED_ATTRIBUTE}], [${PROJECTED_ATTRIBUTE}] *):is(`)
    .replace(/:host(?![\w-])/g, host);
  return rewriteComponentTags(output);
}

/** Wraps the compiled groups in the component's two scopes; `hoisted` rules stay document-wide. */
export function assembleComponentStyles(tag: string, own: string, slotted: string, hoisted: string): string {
  const root = `[${COMPONENT_ATTRIBUTE}~="${tag}"]`;
  return [
    hoisted,
    own.trim() === "" ? "" : `@scope (${root}) to ([${COMPONENT_ATTRIBUTE}], [${PROJECTED_ATTRIBUTE}]) {\n${own}\n}`,
    slotted.trim() === "" ? "" : `@scope (${root}) to ([${COMPONENT_ATTRIBUTE}]) {\n${slotted}\n}`,
  ].filter((part) => part !== "").join("\n");
}

/** Scalars, keywords, enums, and unions of them can be tested; lists, records, and objects cannot. */
function stylableType(type: unknown): boolean {
  if (typeof type === "string") return true;
  if (type === null || typeof type !== "object") return false;
  if ("enum" in type) return true;
  const node = type as { kind?: string; members?: readonly unknown[] };
  if (node.kind === "union") return (node.members ?? []).every(stylableType);
  return node.kind !== "list" && node.kind !== "record" && node.kind !== "object";
}

/** Rejects `:host-state()` tests on names that are not declared props or state of a stylable type. */
export function validateStateNames(definition: ComponentDefinition, names: ReadonlySet<string>, source?: string): void {
  const states = new Set((definition.declarations ?? [])
    .filter((declaration) => declaration.kind === "state")
    .map((declaration) => declaration.name));
  for (const name of names) {
    const prop = definition.contract.props[name];
    if (prop === undefined && !states.has(name)) {
      fail("HY001", `\`:host-state()\` tests \`${name}\`, which is not a declared prop or state.`, source);
    }
    if (prop !== undefined && !stylableType(prop.type)) {
      fail("HY002", `\`:host-state()\` cannot test \`${name}\`, whose type is structured.`, source);
    }
  }
}

export interface CompiledComponentStyles {
  readonly css: string;
  /** The props and state the state attribute must carry, in first-use order. */
  readonly stateNames: readonly string[];
}

type RuleContainer = CSSStyleSheet | CSSGroupingRule;

/** Compiles a style block in a browser through the CSS Object Model. */
export function compileComponentStyles(
  css: string,
  definition: ComponentDefinition,
  document: Document,
  source?: string,
): CompiledComponentStyles {
  const tag = definition.contract.tag;
  if (css.trim() === "") return { css: "", stateNames: [] };
  const Sheet = (document.defaultView ?? globalThis).CSSStyleSheet;
  const renamed = renameComponentPseudoClasses(css);
  const names = new Set<string>();
  const hoisted: string[] = [];

  const view = document.defaultView ?? globalThis;
  const StyleRule = view.CSSStyleRule;
  const GroupingRule = view.CSSGroupingRule;
  const rewriteNested = (rule: CSSStyleRule, kind: StyleRuleKind): void => {
    rule.selectorText = rewriteComponentSelector(rule.selectorText, tag, kind, names);
    for (const child of Array.from(rule.cssRules ?? [])) {
      if (child instanceof StyleRule) rewriteNested(child, kind);
    }
  };
  // Keeps the rules of one kind, rewriting their selectors; grouping rules keep their structure.
  const prune = (container: RuleContainer, want: StyleRuleKind, topLevel: boolean): void => {
    const rules = container.cssRules;
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index]!;
      if (rule instanceof StyleRule) {
        const kind = styleRuleKind(rule.selectorText);
        if (kind === want) rewriteNested(rule, kind);
        else container.deleteRule(index);
      } else if (rule instanceof GroupingRule) {
        prune(rule, want, false);
      } else {
        // Document-wide rules (@keyframes, @font-face, @property, …) are hoisted once, unscoped.
        if (topLevel && want === "own") hoisted.unshift(rule.cssText);
        container.deleteRule(index);
      }
    }
  };
  const compile = (want: StyleRuleKind): string => {
    const sheet = new Sheet();
    sheet.replaceSync(renamed);
    prune(sheet, want, true);
    return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
  };
  const own = compile("own");
  const slotted = compile("slotted");
  validateStateNames(definition, names, source);
  return { css: assembleComponentStyles(tag, own, slotted, hoisted.join("\n")), stateNames: [...names] };
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
