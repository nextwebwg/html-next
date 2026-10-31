import { COMPONENT_ROOT_SELECTOR, componentOwnerSelector } from "./component-identity.js";
import { normalizeStylesheetNamespacesForBuild } from "./stylesheet-resources-build.js";
import { hoistStylesheetNamespaces } from "./stylesheet-namespaces.js";
/**
 * Component style compilation for build tools, which have no DOM. It performs the same rename,
 * two-copy prune, and selector rewrite as the browser (`component-styles.ts`), over postcss.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

import {
  adopterGraph,
  assembleComponentStyles,
  authoredSelector,
  assertResolvedStylesheet,
  componentStyleNameResolver,
  guardComponentPseudoElements,
  projectingHost,
  guardProjectingSelector,
  projectingScope,
  projectsIntoComponents,
  COMPONENT_STYLE_BOUNDARIES,
  type CompiledComponentStyles,
  type ComponentPseudoClass,
  type ComponentStyleGraph,
  complexSelectors,
  foreignStateResolver,
  nestedRootDiagnostic,
  nestedRootSubject,
  renameComponentPseudoClasses,
  rewriteComponentSelector,
  styleRuleKind,
  type StyleRuleKind,
  testedStatesField,
} from "./component-styles.js";
import { getDomInterface } from "./platform.js";
import type { HtmlDiagnostic } from "./diagnostics.js";
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
  graph?: ComponentStyleGraph,
): CompiledComponentStyles {
  const compiled = compileStyles(css, definition, source, adopters, includeBoundaryReset, graph);
  return adopters === undefined ? withImportedStateNames(compiled, definition, graph) : compiled;
}

function withImportedStateNames(compiled: CompiledComponentStyles, definition: ComponentDefinition, graph?: ComponentStyleGraph): CompiledComponentStyles {
  const imports = (definition.stylesheets ?? []).map(sheet => compileStyles(sheet.css, definition, sheet.url, undefined, true, graph));
  if (imports.length === 0) return compiled;
  const tested = new Map<string, Set<string>>();
  for (const { testedStates } of [...imports, compiled]) {
    for (const [tag, names] of Object.entries(testedStates ?? {})) {
      const set = tested.get(tag) ?? new Set<string>();
      for (const name of names) set.add(name);
      tested.set(tag, set);
    }
  }
  return { ...compiled, stateNames: [...new Set([...imports.flatMap(({ stateNames }) => stateNames), ...compiled.stateNames])], ...testedStatesField(tested) };
}

/** One shared body, with selector tests resolved independently for every adopting contract. */
export function compileSharedComponentStylesForBuild(css: string, adopters: readonly ComponentDefinition[], source?: string, includeBoundaryReset = true,
  graph?: ComponentStyleGraph): CompiledComponentStyles {
  if (adopters.length === 0) return { css: "", stateNames: [] };
  return compileStyles(css, adopters[0]!, source, adopters, includeBoundaryReset, graph);
}

/**
 * HY007 warnings for a graph: each rule whose subject is a component's root, which the styles that
 * select it never match. Rules whose selectors hold `&` are relative to a parent and are skipped.
 */
export function nestedRootStyleWarnings(definitions: readonly ComponentDefinition[]): HtmlDiagnostic[] {
  const tags = new Set(definitions.map((definition) => definition.contract.tag));
  const warnings: HtmlDiagnostic[] = [];
  for (const definition of definitions) {
    const sheets = [{ css: definition.css, source: definition.source.file },
      ...(definition.stylesheets ?? []).map((sheet) => ({ css: sheet.css, source: sheet.url }))];
    for (const { css, source } of sheets) {
      if (css.trim() === "") continue;
      let root: postcss.Root;
      // Malformed styles report their own errors when they compile.
      try { root = postcss.parse(renameComponentPseudoClasses(normalizeStylesheetNamespacesForBuild(css))); } catch { continue; }
      root.walkRules((rule) => {
        const parent = rule.parent;
        if ((parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) || rule.selector.includes("&")) return;
        for (const complex of complexSelectors(rule.selector)) {
          const tag = nestedRootSubject(complex, tags);
          if (tag !== undefined) warnings.push(nestedRootDiagnostic(definition.contract.tag, authoredSelector(complex), tag, source));
        }
      });
    }
  }
  return warnings;
}

/** The component graph of a closed set of definitions, by tag. */
export function definitionGraph(definitions: Iterable<ComponentDefinition>): ComponentStyleGraph {
  return new Map([...definitions].map((definition) => [definition.contract.tag, definition] as const));
}

/** Delivers a closed graph in definition order, interleaving imports and local overrides. */
export function compileComponentGraphStylesForBuild(definitions: readonly ComponentDefinition[],
  graph: ComponentStyleGraph = definitionGraph(definitions)): string {
  const groups = collectSharedStylesheets(definitions);
  const css: string[] = [];
  for (const definition of definitions) {
    for (const group of groups.filter(group => group.adopters[0] === definition)) {
      css.push(wrapStylesheetConditions(compileSharedComponentStylesForBuild(group.stylesheet.css, group.adopters, group.stylesheet.url, false, graph).css, group.stylesheet.conditions));
    }
    css.push(compileComponentStylesForBuild(definition.css, definition, undefined, undefined, false, graph).css);
  }
  const body = css.filter(part => part !== "").join("\n");
  return hoistStylesheetNamespaces(body === "" ? "" : COMPONENT_STYLE_BOUNDARIES + "\n" + body);
}

/** Converted roots have one target identity; consume canonical/legacy CSS together here. */
function normalizeConversionStyleIdentities(css: string, identity: "component" | "class" | "attribute"): string {
  const boundary = identity === "component" ? "[component]" : `[${VUE_ROOT_ATTRIBUTE}]`;
  const ownerSelector = (tag: string, namespace = ""): string => identity === "class" ? tagClassSelector(tag, namespace)
    : `${namespace === "" ? "" : namespace + "*"}[${identity === "attribute" ? tag : `component~="${tag}"`}]`;
  function normalizeSelector(selector: string): string {
    let result = "";
    for (let index = 0; index < selector.length;) {
      const start = index;
      if (selector.startsWith(COMPONENT_ROOT_SELECTOR, index)) {
        result += boundary; index += COMPONENT_ROOT_SELECTOR.length; continue;
      }
      // Collapse the shared canonical/legacy selector as one unit, including namespace prefixes.
      const owner = /^:is\(([^[]*)\[component~="([a-z][a-z0-9-]*)"\]/.exec(selector.slice(index));
      if (owner !== null) {
        const namespace = owner[1] === "" ? "" : owner[1]!.slice(0, -1);
        const compatible = componentOwnerSelector(owner[2]!, namespace);
        if (selector.startsWith(compatible, index)) {
          result += ownerSelector(owner[2]!, namespace); index += compatible.length; continue;
        }
      }
      if (selector[index] === "\\") { result += selector.slice(index, index + 2); index += 2; continue; }
      if (selector[index] === '"' || selector[index] === "'") {
        const delimiter = selector[index++];
        while (index < selector.length) { if (selector[index++] === "\\") index++; else if (selector[index - 1] === delimiter) break; }
      } else if (selector[index] === "[") {
        index++;
        let delimiter = "";
        while (index < selector.length) {
          const character = selector[index++];
          if (character === "\\") { index++; continue; }
          if (delimiter !== "") { if (character === delimiter) delimiter = ""; }
          else if (character === '"' || character === "'") delimiter = character;
          else if (character === "]") break;
        }
        const attribute = selector.slice(start, index);
        const named = /^\[(?:data-)?component~="([a-z][a-z0-9-]*)"\]$/.exec(attribute);
        if (named !== null) { result += ownerSelector(named[1]!); continue; }
        if (attribute === "[component]" || attribute === "[data-component]") { result += boundary; continue; }
      } else index++;
      result += selector.slice(start, index);
    }
    return result;
  }
  const root = postcss.parse(css);
  root.walkRules(rule => { rule.selector = normalizeSelector(rule.selector); });
  root.walkAtRules("scope", rule => { rule.params = normalizeSelector(rule.params); });
  return root.toString();
}

/** Native-style framework output shares the same identity normalization as class-scoped output. */
export function compileComponentStylesForConversion(css: string, definition: ComponentDefinition, graph?: ComponentStyleGraph): CompiledComponentStyles {
  const compiled = compileComponentStylesForBuild(css, definition, undefined, undefined, true, graph);
  return { ...compiled, css: normalizeConversionStyleIdentities(compiled.css, "component") };
}

export function compileComponentGraphStylesForConversion(definitions: readonly ComponentDefinition[], identity: "component" | "attribute" = "component",
  graph: ComponentStyleGraph = definitionGraph(definitions)): string {
  return normalizeConversionStyleIdentities(compileComponentGraphStylesForBuild(definitions, graph), identity);
}

function compileStyles(css: string, definition: ComponentDefinition, source?: string,
  adopters: readonly ComponentDefinition[] = [definition], includeBoundaryReset = true, graph: ComponentStyleGraph = adopterGraph(adopters)): CompiledComponentStyles {
  if (css.trim() === "") return { css: "", stateNames: [] };
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const tested = new Map<string, Set<string>>();
  const foreign = foreignStateResolver(graph, tested, source);
  const renamed = renameComponentPseudoClasses(normalizeStylesheetNamespacesForBuild(css));
  const names = new Set<string>();
  const hoisted: string[] = [];
  const owners = adopters.map(owner => ({ owner, names: new Set<string>(), canonical: componentStyleNameResolver(owner, source) }));

  const tagList = adopters.map(owner => owner.contract.tag);
  let projecting = false;
  const selector = (input: string): string => {
    const rewritten = [...new Set(owners.map(({ owner, names: ownerNames, canonical }) =>
      rewriteComponentSelector(input, owner.contract.tag, projecting ? projectingHost(owner.contract.tag)
        : `:scope:where(${componentOwnerSelector(owner.contract.tag)})`, ownerNames, canonical, undefined, undefined, foreign)))].join(", ");
    return styleRuleKind(input) !== "own" ? rewritten
      : projecting ? guardProjectingSelector(rewritten, tagList, tagList.map(projectingHost)) : guardComponentPseudoElements(rewritten);
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
  projecting = adopters.some(owner => projectsIntoComponents(owner.template));
  const hoistedCount = hoisted.length;
  const projected = projecting ? compile("own") : "";
  hoisted.length = hoistedCount;
  for (const owner of owners) for (const name of owner.names) names.add(name);
  return { css: assembleComponentStyles(tagList, own, slotted, hoisted.join("\n"), includeBoundaryReset, projected), stateNames: Array.from(names),
    ...(adopters.length <= 1 ? {} : { stateNamesByTag: Object.fromEntries(owners.map(({ owner, names: ownerNames }) => [owner.contract.tag, [...ownerNames]])) }),
    ...testedStatesField(tested) };
}

const testedByDefinition = new WeakMap<ComponentDefinition, { readonly graph: string; readonly tested: Readonly<Record<string, readonly string[]>> }>();

/** The states a definition's own styles and imports test on component roots, by tag, compiled once per graph. */
function testedStates(definition: ComponentDefinition, graph: ComponentStyleGraph): Readonly<Record<string, readonly string[]>> {
  const key = [...graph.keys()].sort().join(" ");
  const cached = testedByDefinition.get(definition);
  if (cached?.graph === key) return cached.tested;
  const tested = compileComponentStylesForBuild(definition.css, definition, undefined, undefined, true, graph).testedStates ?? {};
  testedByDefinition.set(definition, { graph: key, tested });
  return tested;
}

/**
 * The props and state a component's root carries in its state attribute: those its own styles test,
 * then those any stylesheet in the graph tests on it with a `:state()` condition, so another
 * component's styles see its state.
 */
export function componentStateNames(definition: ComponentDefinition, graph: ComponentStyleGraph = adopterGraph([definition])): readonly string[] {
  const tag = definition.contract.tag;
  const names = new Set(compileComponentStylesForBuild(definition.css, definition, undefined, undefined, true, graph).stateNames);
  for (const other of new Set([definition, ...graph.values()])) {
    for (const name of testedStates(other, graph)[tag] ?? []) names.add(name);
  }
  return [...names];
}

/** Every converted Vue component's root, which bounds every other component's styles. */
export const VUE_ROOT_ATTRIBUTE = "data-hn";

/** The attribute a converted Vue component's styles select its own markup by. */
function vueOwnerAttribute(tag: string): string {
  return `${VUE_ROOT_ATTRIBUTE}-${tag}`;
}

/**
 * Styles for a converted Vue component. The converter scopes them as the live runtime does, with
 * the live runtime's selectors: a native scope rooted at the root's tag class and bounded by every
 * converted component's root, `[data-hn]`. In a component with slots the scope also holds content a
 * consumer projects, so the component's own markup carries `data-hn-<tag>`: a selector's subject
 * tests it in `:where()`, which keeps the selector's specificity, and `:slotted()` selects what lacks
 * it. Without slots, nothing is projected, and `:slotted()` selects nothing. `:host` is `:scope`,
 * and a component selected by tag is its class in `:where()`, which keeps the type selector's
 * specificity, as the live runtime's `:where([component~="…"])` does.
 *
 * They are emitted as `<style scoped>`, since Vite drops the scoped styles of a component a build
 * leaves out, with each selector in `:global()`, which Vue's scoped styles keep as written. Vue
 * moves the declarations of a rule that holds nested rules into a first nested `& { … }`, which it
 * scopes; the converter puts each run of them in a nested `&` rule of its own, where it stands.
 */
export function compileComponentStylesForVue(
  css: string,
  definition: ComponentDefinition,
  source?: string,
  graph?: ComponentStyleGraph,
): CompiledComponentStyles {
  const projects = (definition.slots?.length ?? 0) > 0;
  const attribute = vueOwnerAttribute(definition.contract.tag);
  const owner = `[${attribute.replace(/[^\w-]/g, (character) => `\\${character}`)}]`;
  const compiled = compileClassScopedStyles(css, definition, source, ["slotted", "state"], (selector) => postcss.list.comma(selector).map((complex) => {
    if (complex.includes(SLOTTED)) return `:global(${complex.replaceAll(SLOTTED, projects ? `:where(:not(${owner}))` : ":not(*)")})`;
    if (!projects) return `:global(${complex})`;
    const { pseudo } = subjectCompound(complex);
    return `:global(${complex.slice(0, pseudo)}:where(${owner})${complex.slice(pseudo)})`;
  }).join(", "), (root) => root.walkRules((rule) => {
    if (!rule.nodes.some((node) => node.type === "rule")) return;
    for (const parent of [rule, ...rule.nodes.filter((node) => node.type === "atrule")]) {
      // Each run of declarations keeps its place, as the browser's nested declarations do.
      let run: Rule | undefined;
      for (const node of parent.nodes?.slice() ?? []) {
        if (node.type !== "decl" && node.type !== "comment") { run = undefined; continue; }
        if (run === undefined) node.before(run = postcss.rule({ selector: "&", raws: { between: " " } }));
        run.append(node);
      }
    }
  }), () => `[${VUE_ROOT_ATTRIBUTE}]`, graph);
  return projects && compiled.components !== undefined ? { ...compiled, owner: attribute } : compiled;
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
  graph?: ComponentStyleGraph,
): CompiledComponentStyles {
  const projects = (definition.slots?.length ?? 0) > 0;
  const owner = projects && usesHtml(definition.template) ? `[${SVELTE_OWNER_ATTRIBUTE}~="${definition.contract.tag}"]` : undefined;
  const slotted = new Set<object>();
  let hashed = false;
  let descends = false;
  const compiled = compileClassScopedStyles(css, definition, source, ["slotted", "state"], (selector, rule) => {
    if (selector.includes(SLOTTED) || (rule.parent !== undefined && slotted.has(rule.parent))) slotted.add(rule);
    return postcss.list.comma(selector.replaceAll(SLOTTED, "")).map((complex) => {
      const scoped = svelteSelector(complex, !projects ? undefined : slotted.has(rule) ? "projected" : "own", owner);
      hashed ||= scoped.tested;
      descends ||= !scoped.root;
      return scoped.selector;
    }).join(", ");
  }, (root) => root.walkAtRules(/keyframes$/i, (rule) => {
    if (/^[\w-]+$/.test(rule.params)) rule.params = `-global-${rule.params}`;
  }),
  // A nested or projected component's root bounds the scope, as `[data-hn]` does in Vue; with neither, nothing does.
  () => descends && ((definition.slots?.length ?? 0) > 0 || componentTags(definition.template).size > 0) && `[${VUE_ROOT_ATTRIBUTE}]`, graph);
  return hashed ? { ...compiled, hashed } : compiled;
}

const SLOTTED = ":where([--slotted])";

function compileClassScopedStyles(css: string, definition: ComponentDefinition, source: string | undefined,
  renames: readonly ComponentPseudoClass[], target: (selector: string, rule: Rule) => string,
  prepare?: (root: postcss.Root) => void, limited = (): boolean | string => true, graph: ComponentStyleGraph = adopterGraph([definition])): CompiledComponentStyles {
  const tag = definition.contract.tag;
  if (css.trim() === "") return withImportedStateNames({ css: "", stateNames: [] }, definition, graph);
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const tested = new Map<string, Set<string>>();
  const foreign = foreignStateResolver(graph, tested, source);
  const names = new Set<string>();
  const canonical = componentStyleNameResolver(definition, source);
  const renamed = renameComponentPseudoClasses(normalizeStylesheetNamespacesForBuild(css), renames);
  const root = postcss.parse(renamed);
  prepare?.(root);
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
    rule.selector = target(rewriteComponentSelector(rule.selector, tag, ":scope", names, canonical, "[--slotted]", (name, namespace) => `:where(${tagClassSelector(name, namespace)})`, foreign), rule);
  });
  // The own rules again, for the markup the component projects into the components it invokes (`assembleComponentStyles`).
  const projecting = projectsIntoComponents(definition.template) ? postcss.atRule({ name: "scope", params: projectingScope([tag], `[${VUE_ROOT_ATTRIBUTE}]`) }) : undefined;
  if (projecting !== undefined) {
    const copy = postcss.parse(renamed);
    prepare?.(copy);
    copy.walkRules((rule) => {
      const parent = rule.parent;
      if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
      if (styleRuleKind(rule.selector) === "slotted") { rule.remove(); return; }
      rule.selector = target(guardProjectingSelector(rewriteComponentSelector(rule.selector, tag, `:where(${tagClassSelector(tag)})`, new Set(), canonical,
        "[--slotted]", (name, namespace) => `:where(${tagClassSelector(name, namespace)})`, foreign), [tag], [`:where(${tagClassSelector(tag)})`], `[${VUE_ROOT_ATTRIBUTE}]`), rule);
    });
    for (const node of copy.nodes.slice()) {
      if (node.type === "rule" || (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()))) projecting.append(node);
    }
  }
  const limit = limited();
  const limits = limit === false ? [] : [...componentTags(definition.template)];
  const scope = postcss.atRule({ name: "scope", params: typeof limit === "string"
    ? `(${tagClassSelector(tag)}) to (${limit})` : classScope(definition.contract.tag, limits) });
  for (const node of root.nodes.slice()) {
    if (node.type === "rule" || (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()))) {
      scope.append(node);
    }
  }
  if (scope.nodes === undefined || scope.nodes.length === 0) {
    return withImportedStateNames({ css: normalizeConversionStyleIdentities(root.toString().trim(), "class"), stateNames: Array.from(names), ...testedStatesField(tested) }, definition, graph);
  }
  root.append(scope);
  if (projecting?.nodes !== undefined && projecting.nodes.length > 0) root.append(projecting);
  return withImportedStateNames({ css: normalizeConversionStyleIdentities(root.toString().trim(), "class"), stateNames: Array.from(names), components: limits, ...testedStatesField(tested) }, definition, graph);
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
