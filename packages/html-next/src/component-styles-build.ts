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
  type CompiledComponentStyles,
  renameComponentPseudoClasses,
  rewriteComponentSelector,
  styleRuleKind,
  type StyleRuleKind,
} from "./component-styles.js";
import type { ComponentDefinition } from "./template.js";
import { collectSharedStylesheets, wrapStylesheetConditions } from "./stylesheet-resources.js";

/** At-rules whose block holds style rules; name-defining rules keep their authored context. */
const GROUPING = new Set(["media", "supports", "container", "layer", "scope", "starting-style"]);

export const SVELTE_OWNER_ATTRIBUTE = "data-html-next-owner";

export function compileComponentStylesForBuild(
  css: string,
  definition: ComponentDefinition,
  source?: string,
  adopters?: readonly ComponentDefinition[],
): CompiledComponentStyles {
  const compiled = compileStyles(css, definition, source, undefined, adopters);
  return adopters === undefined ? withImportedStateNames(compiled, definition) : compiled;
}

function withImportedStateNames(compiled: CompiledComponentStyles, definition: ComponentDefinition): CompiledComponentStyles {
  const imported = (definition.stylesheets ?? []).flatMap(sheet => compileStyles(sheet.css, definition, sheet.url).stateNames);
  return { ...compiled, stateNames: [...new Set([...imported, ...compiled.stateNames])] };
}

/** One shared body, with selector tests resolved independently for every adopting contract. */
export function compileSharedComponentStylesForBuild(css: string, adopters: readonly ComponentDefinition[], source?: string): CompiledComponentStyles {
  if (adopters.length === 0) return { css: "", stateNames: [] };
  return compileStyles(css, adopters[0]!, source, undefined, adopters);
}

/** Delivers a closed graph in definition order, interleaving imports and local overrides. */
export function compileComponentGraphStylesForBuild(definitions: readonly ComponentDefinition[]): string {
  const groups = collectSharedStylesheets(definitions);
  const css: string[] = [];
  for (const definition of definitions) {
    for (const group of groups.filter(group => group.adopters[0] === definition)) {
      css.push(wrapStylesheetConditions(compileSharedComponentStylesForBuild(group.stylesheet.css, group.adopters, group.stylesheet.url).css, group.stylesheet.conditions));
    }
    css.push(compileComponentStylesForBuild(definition.css, definition).css);
  }
  return css.filter(part => part !== "").join("\n");
}

/** Snippets are opaque on the server, so scope by authored ownership instead of mutating them. */
export function compileComponentStylesForSvelte(css: string, definition: ComponentDefinition): CompiledComponentStyles {
  const projected = (definition.slots?.length ?? 0) === 0 ? undefined
    : `:not([${SVELTE_OWNER_ATTRIBUTE}~="${definition.contract.tag}"])`;
  return withImportedStateNames(compileStyles(css, definition, undefined, projected), definition);
}

function compileStyles(css: string, definition: ComponentDefinition, source?: string,
  projected?: string, adopters: readonly ComponentDefinition[] = [definition]): CompiledComponentStyles {
  if (css.trim() === "") return { css: "", stateNames: [] };
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const renamed = renameComponentPseudoClasses(css);
  const names = new Set<string>();
  const hoisted: string[] = [];
  const owners = adopters.map(owner => ({ owner, names: new Set<string>(), canonical: componentStyleNameResolver(owner, source) }));

  const selector = (input: string): string => {
    const rewritten = [...new Set(owners.map(({ owner, names: ownerNames, canonical }) =>
      rewriteComponentSelector(input, owner.contract.tag, `:scope:where([${COMPONENT_ATTRIBUTE}~="${owner.contract.tag}"])`, ownerNames, canonical, projected)))].join(", ");
    return projected === undefined && styleRuleKind(input) === "own" ? guardComponentPseudoElements(rewritten) : rewritten;
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
  return { css: assembleComponentStyles(adopters.map(owner => owner.contract.tag), own, slotted, hoisted.join("\n"), projected), stateNames: Array.from(names),
    ...(adopters.length <= 1 ? {} : { stateNamesByTag: Object.fromEntries(owners.map(({ owner, names: ownerNames }) => [owner.contract.tag, [...ownerNames]])) }) };
}

/**
 * Styles for a converted Vue component, emitted as `<style scoped>`. Vue's scoping already bounds
 * the region: projected content carries the consumer's scope, and Vue's own `:slotted()` reaches it.
 * A native scope preserves the descendant-only meaning of ordinary selectors and excludes nested
 * component roots. Explicit host selectors become `:scope`; Vue still owns slot scoping.
 */
export function compileComponentStylesForVue(
  css: string,
  definition: ComponentDefinition,
  source?: string,
): CompiledComponentStyles {
  const tag = definition.contract.tag;
  if (css.trim() === "") return withImportedStateNames({ css: "", stateNames: [] }, definition);
  assertResolvedStylesheet(css, source ?? definition.source.file);
  const names = new Set<string>();
  const canonical = componentStyleNameResolver(definition, source);
  const root = postcss.parse(renameComponentPseudoClasses(css, ["host-state"]));
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
    rule.selector = rewriteComponentSelector(rule.selector, tag, ":scope", names, canonical);
  });
  const scope = postcss.atRule({ name: "scope", params: `([${COMPONENT_ATTRIBUTE}~="${tag}"]) to ([${COMPONENT_ATTRIBUTE}])` });
  for (const node of root.nodes.slice()) {
    if (node.type === "rule" || (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()))) {
      scope.append(node);
    }
  }
  if (scope.nodes?.length) root.append(scope);
  return withImportedStateNames({ css: root.toString().trim(), stateNames: Array.from(names) }, definition);
}
