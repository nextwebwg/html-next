import { normalizeStylesheetNamespacesForBuild } from "./stylesheet-resources-build.js";
import { hoistStylesheetNamespaces } from "./stylesheet-namespaces.js";
/**
 * Component style compilation for build tools, which have no DOM. It performs the same rename,
 * two-copy prune, and selector rewrite as the browser (`component-styles.ts`), over postcss.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

import {
  assembleComponentStyles,
  assertResolvedStylesheet,
  componentStyleNameResolver,
  guardComponentPseudoElements,
  COMPONENT_ATTRIBUTE,
  COMPONENT_STYLE_BOUNDARIES,
  type CompiledComponentStyles,
  renameComponentPseudoClasses,
  rewriteComponentSelector,
  styleRuleKind,
  type StyleRuleKind,
} from "./component-styles.js";
import { getDomInterface } from "./platform.js";
import type { ComponentDefinition, TemplateNode } from "./template.js";
import { collectSharedStylesheets, wrapStylesheetConditions } from "./stylesheet-resources.js";

/** At-rules whose block holds style rules; name-defining rules keep their authored context. */
const GROUPING = new Set(["media", "supports", "container", "layer", "scope", "starting-style"]);

export const SVELTE_OWNER_ATTRIBUTE = "data-html-next-owner";

export function compileComponentStylesForBuild(
  css: string,
  definition: ComponentDefinition,
  source?: string,
  adopters?: readonly ComponentDefinition[],
  includeBoundaryReset = true,
): CompiledComponentStyles {
  const compiled = compileStyles(css, definition, source, adopters, includeBoundaryReset);
  return adopters === undefined ? withImportedStateNames(compiled, definition) : compiled;
}

function withImportedStateNames(compiled: CompiledComponentStyles, definition: ComponentDefinition): CompiledComponentStyles {
  const imported = (definition.stylesheets ?? []).flatMap(sheet => compileStyles(sheet.css, definition, sheet.url).stateNames);
  return { ...compiled, stateNames: [...new Set([...imported, ...compiled.stateNames])] };
}

/** One shared body, with selector tests resolved independently for every adopting contract. */
export function compileSharedComponentStylesForBuild(css: string, adopters: readonly ComponentDefinition[], source?: string, includeBoundaryReset = true): CompiledComponentStyles {
  if (adopters.length === 0) return { css: "", stateNames: [] };
  return compileStyles(css, adopters[0]!, source, adopters, includeBoundaryReset);
}

/** Delivers a closed graph in definition order, interleaving imports and local overrides. */
export function compileComponentGraphStylesForBuild(definitions: readonly ComponentDefinition[]): string {
  const groups = collectSharedStylesheets(definitions);
  const css: string[] = [];
  for (const definition of definitions) {
    for (const group of groups.filter(group => group.adopters[0] === definition)) {
      css.push(wrapStylesheetConditions(compileSharedComponentStylesForBuild(group.stylesheet.css, group.adopters, group.stylesheet.url, false).css, group.stylesheet.conditions));
    }
    css.push(compileComponentStylesForBuild(definition.css, definition, undefined, undefined, false).css);
  }
  const body = css.filter(part => part !== "").join("\n");
  return hoistStylesheetNamespaces(body === "" ? "" : COMPONENT_STYLE_BOUNDARIES + "\n" + body);
}

function compileStyles(css: string, definition: ComponentDefinition, source?: string,
  adopters: readonly ComponentDefinition[] = [definition], includeBoundaryReset = true): CompiledComponentStyles {
  if (css.trim() === "") return { css: "", stateNames: [] };
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const renamed = renameComponentPseudoClasses(normalizeStylesheetNamespacesForBuild(css));
  const names = new Set<string>();
  const hoisted: string[] = [];
  const owners = adopters.map(owner => ({ owner, names: new Set<string>(), canonical: componentStyleNameResolver(owner, source) }));

  const selector = (input: string): string => {
    const rewritten = [...new Set(owners.map(({ owner, names: ownerNames, canonical }) =>
      rewriteComponentSelector(input, owner.contract.tag, `:scope:where([${COMPONENT_ATTRIBUTE}~="${owner.contract.tag}"])`, ownerNames, canonical)))].join(", ");
    return styleRuleKind(input) === "own" ? guardComponentPseudoElements(rewritten) : rewritten;
  };

  const rewrite = (rule: Rule): void => {
    rule.selector = selector(rule.selector);
    rule.walkRules((nested) => {
      nested.selector = selector(nested.selector);
    });
  };
  const prune = (container: Container<ChildNode>, want: StyleRuleKind, topLevel: boolean): void => {
    container.each((node) => {
      if (node.type === "rule") {
        if (styleRuleKind(node.selector) === want) rewrite(node);
        else node.remove();
      } else if (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()) && node.nodes !== undefined) {
        prune(node as AtRule, want, false);
      } else if (node.type === "atrule") {
        if (!["namespace", "charset", "import"].includes(node.name.toLowerCase()) && want === "own") return;
        // PostCSS serializes a detached statement without its parent's trailing semicolon.
        if (topLevel && want === "own") hoisted.push(node.toString() + (node.nodes === undefined ? ";" : ""));
        if (topLevel || want !== "own") node.remove();
      } else if (node.type === "decl") {
        node.remove();
      }
    });
  };
  const compile = (want: StyleRuleKind): string => {
    const root = postcss.parse(renamed);
    prune(root, want, true);
    return root.toString().trim();
  };
  const own = compile("own");
  const slotted = compile("slotted");
  for (const owner of owners) for (const name of owner.names) names.add(name);
  return { css: assembleComponentStyles(adopters.map(owner => owner.contract.tag), own, slotted, hoisted.join("\n"), includeBoundaryReset), stateNames: Array.from(names),
    ...(adopters.length <= 1 ? {} : { stateNamesByTag: Object.fromEntries(owners.map(({ owner, names: ownerNames }) => [owner.contract.tag, [...ownerNames]])) }) };
}

/**
 * Styles for a converted Vue component, emitted as `<style scoped>`. Vue's scoping already bounds
 * the region: projected content carries the consumer's scope, and Vue's own `:slotted()` reaches it.
 * A native scope keeps ordinary selectors to the component's own descendants and stops at nested
 * component roots, as in the default build, through classes: the root carries its tag, and each
 * component the template invokes carries its own, which Vue passes to that component's root.
 * `:host` is `:scope`, and a component selected by tag is its class.
 */
export function compileComponentStylesForVue(
  css: string,
  definition: ComponentDefinition,
  source?: string,
): CompiledComponentStyles {
  return compileClassScopedStyles(css, definition, source, ["host-state"], (selector) => selector);
}

/**
 * Styles for a converted Svelte component, emitted as its `<style>`, in Vue's native scope. Each
 * selector is `:global()`, so Svelte keeps rules for markup it cannot see, such as sanitized HTML.
 * In a component with slots the scope also holds content a consumer projects, which Svelte's hash
 * class tells apart: Svelte puts it on the component's own markup, and projected content carries the
 * consumer's. There a subject carries one test Svelte scopes: `:where(*)` for the component's own
 * markup (or the owner attribute, for its sanitized HTML), and `:not(:scope, * *)` for what
 * `:slotted()` selects, which is neither. A `:host` subject is the scope root and needs no test, and
 * the scope has limits only when a subject can be below it. Keyframes keep their names.
 */
export function compileComponentStylesForSvelte(
  css: string,
  definition: ComponentDefinition,
  source?: string,
): CompiledComponentStyles {
  const projects = (definition.slots?.length ?? 0) > 0;
  const owner = projects && usesHtml(definition.template) ? `[${SVELTE_OWNER_ATTRIBUTE}~="${definition.contract.tag}"]` : undefined;
  const slotted = new Set<object>();
  let hashed = false;
  let descends = false;
  const compiled = compileClassScopedStyles(css, definition, source, ["slotted", "host-state"], (selector, rule) => {
    if (selector.includes(SLOTTED) || (rule.parent !== undefined && slotted.has(rule.parent))) slotted.add(rule);
    return postcss.list.comma(selector.replaceAll(SLOTTED, "")).map((complex) => {
      const scoped = svelteSelector(complex, !projects ? undefined : slotted.has(rule) ? "projected" : "own", owner);
      hashed ||= scoped.tested;
      descends ||= !scoped.root;
      return scoped.selector;
    }).join(", ");
  }, (root) => root.walkAtRules(/keyframes$/i, (rule) => {
    if (/^[\w-]+$/.test(rule.params)) rule.params = `-global-${rule.params}`;
  }), () => descends);
  return hashed ? { ...compiled, hashed } : compiled;
}

const SLOTTED = ":where([--slotted])";

function compileClassScopedStyles(css: string, definition: ComponentDefinition, source: string | undefined,
  renames: readonly ("slotted" | "host-state")[], target: (selector: string, rule: Rule) => string,
  prepare?: (root: postcss.Root) => void, limited = (): boolean => true): CompiledComponentStyles {
  const tag = definition.contract.tag;
  if (css.trim() === "") return withImportedStateNames({ css: "", stateNames: [] }, definition);
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const names = new Set<string>();
  const canonical = componentStyleNameResolver(definition, source);
  const root = postcss.parse(renameComponentPseudoClasses(normalizeStylesheetNamespacesForBuild(css), renames));
  prepare?.(root);
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
    rule.selector = target(rewriteComponentSelector(rule.selector, tag, ":scope", names, canonical, "[--slotted]", tagClassSelector), rule);
  });
  const limits = limited() ? [...componentTags(definition.template)] : [];
  const scope = postcss.atRule({ name: "scope", params: classScope(definition.contract.tag, limits) });
  for (const node of root.nodes.slice()) {
    if (node.type === "rule" || (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()))) {
      scope.append(node);
    }
  }
  if (scope.nodes === undefined || scope.nodes.length === 0) {
    return withImportedStateNames({ css: root.toString().trim(), stateNames: Array.from(names) }, definition);
  }
  root.append(scope);
  return withImportedStateNames({ css: root.toString().trim(), stateNames: Array.from(names), components: limits }, definition);
}

/** One complex selector as `:global()`, with any test of its subject's ownership before its pseudo-element. */
function svelteSelector(complex: string, owned: "own" | "projected" | undefined, owner: string | undefined): { selector: string; tested: boolean; root: boolean } {
  const { start, pseudo } = subjectCompound(complex);
  const subject = complex.slice(start, pseudo);
  const root = /:scope(?![\w-])/.test(subject);
  const test = owned === "projected" ? `:not(:scope, * *${owner === undefined ? "" : `, ${owner}`})`
    : owned === undefined || root ? "" : `:where(*${owner === undefined ? "" : `, :global(${owner})`})`;
  return { selector: `:global(${complex.slice(0, pseudo)}${subject === "" ? "*" : ""})${test}${complex.slice(pseudo)}`, tested: test !== "", root };
}

/** Where a complex selector's last compound starts, and where its pseudo-element starts (or its end). */
function subjectCompound(selector: string): { start: number; pseudo: number } {
  let start = 0;
  let pseudo = -1;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    if (character === "\\") { index += 1; continue; }
    if (quote !== "") { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (depth > 0) continue;
    else if (/[\s>+~]/.test(character)) { start = index + 1; pseudo = -1; }
    else if (character === ":" && pseudo === -1 && /^::|^:(?:before|after|first-line|first-letter)(?![\w-])/i.test(selector.slice(index))) pseudo = index;
  }
  return { start, pseudo: pseudo === -1 ? selector.length : pseudo };
}

/** Whether a template renders sanitized HTML (`$html`), slot fallbacks included. */
function usesHtml(node: TemplateNode): boolean {
  if (node.kind === "text") return false;
  if (node.kind === "slot") return (node.fallback ?? []).some(usesHtml);
  return node.attributes.some((attribute) => attribute.kind === "directive" && attribute.name === "html") || node.children.some(usesHtml);
}

/** The component's scope: its root, down to the roots of the components it invokes that limit it. */
function classScope(tag: string, limits: readonly string[]): string {
  return `(${tagClassSelector(tag)})${limits.length === 0 ? "" : ` to (${limits.map((name) => tagClassSelector(name)).join(", ")})`}`;
}

/** Components a template invokes, slot fallbacks included. */
function componentTags(node: TemplateNode, tags = new Set<string>()): Set<string> {
  if (node.kind === "text") return tags;
  if (node.kind === "slot") node.fallback?.forEach((child) => componentTags(child, tags));
  else {
    if (node.name.includes("-") && getDomInterface(node.name) === undefined) tags.add(node.name);
    node.children.forEach((child) => componentTags(child, tags));
  }
  return tags;
}

/** In Vue and Svelte, a component's root is selected by its tag as a class; `namespace` keeps an authored `n|` prefix. */
export function tagClassSelector(tag: string, namespace = ""): string {
  return `${namespace === "" ? "" : namespace + "*"}.${tag.replace(/[^\w-]/g, (character) => `\\${character}`)}`;
}
