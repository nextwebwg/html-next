/**
 * Component style compilation for build tools, which have no DOM. It performs the same rename,
 * two-copy prune, and selector rewrite as the browser (`component-styles.ts`), over postcss.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

import {
  assembleComponentStyles,
  componentStyleNameResolver,
  type CompiledComponentStyles,
  renameComponentPseudoClasses,
  rewriteComponentSelector,
  styleRuleKind,
  type StyleRuleKind,
} from "./component-styles.js";
import { getDomInterface } from "./platform.js";
import type { ComponentDefinition, TemplateNode } from "./template.js";

/** At-rules whose block holds style rules; everything else is document-wide and hoisted. */
const GROUPING = new Set(["media", "supports", "container", "layer", "scope", "starting-style"]);

export const SVELTE_OWNER_ATTRIBUTE = "data-html-next-owner";

export function compileComponentStylesForBuild(
  css: string,
  definition: ComponentDefinition,
  source?: string,
): CompiledComponentStyles {
  return compileStyles(css, definition, source);
}

/** Snippets are opaque on the server, so scope by authored ownership instead of mutating them. */
export function compileComponentStylesForSvelte(css: string, definition: ComponentDefinition): CompiledComponentStyles {
  const projected = (definition.slots?.length ?? 0) === 0 ? undefined
    : `:not([${SVELTE_OWNER_ATTRIBUTE}~="${definition.contract.tag}"])`;
  return compileStyles(css, definition, undefined, projected);
}

function compileStyles(css: string, definition: ComponentDefinition, source?: string,
  projected?: string): CompiledComponentStyles {
  const tag = definition.contract.tag;
  if (css.trim() === "") return { css: "", stateNames: [] };
  const renamed = renameComponentPseudoClasses(css);
  const names = new Set<string>();
  const hoisted: string[] = [];
  const canonical = componentStyleNameResolver(definition, source);

  const rewrite = (rule: Rule): void => {
    rule.selector = rewriteComponentSelector(rule.selector, tag, ":scope", names, canonical, projected);
    rule.walkRules((nested) => {
      nested.selector = rewriteComponentSelector(nested.selector, tag, ":scope", names, canonical, projected);
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
        // PostCSS serializes a detached statement without its parent's trailing semicolon.
        if (topLevel && want === "own") hoisted.push(node.toString() + (node.nodes === undefined ? ";" : ""));
        node.remove();
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
  return { css: assembleComponentStyles(tag, own, slotted, hoisted.join("\n"), projected), stateNames: Array.from(names) };
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
  const tag = definition.contract.tag;
  if (css.trim() === "") return { css: "", stateNames: [] };
  const names = new Set<string>();
  const canonical = componentStyleNameResolver(definition, source);
  const root = postcss.parse(renameComponentPseudoClasses(css, ["host-state"]));
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
    rule.selector = rewriteComponentSelector(rule.selector, tag, ":scope", names, canonical, undefined, vueHostSelector);
  });
  const scope = postcss.atRule({ name: "scope", params: vueScope(definition) });
  for (const node of root.nodes.slice()) {
    if (node.type === "rule" || (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()))) {
      scope.append(node);
    }
  }
  if (scope.nodes === undefined || scope.nodes.length === 0) return { css: root.toString().trim(), stateNames: Array.from(names) };
  root.append(scope);
  return { css: root.toString().trim(), stateNames: Array.from(names), components: [...componentTags(definition.template)] };
}

/** The component's scope: its root, down to the roots of the components its template invokes. */
function vueScope(definition: ComponentDefinition): string {
  const limits = [...componentTags(definition.template)].map(vueHostSelector);
  return `(${vueHostSelector(definition.contract.tag)})${limits.length === 0 ? "" : ` to (${limits.join(", ")})`}`;
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

/** In Vue, a component's root is selected by its tag as a class. */
export function vueHostSelector(tag: string): string {
  return `.${tag.replace(/[^\w-]/g, (character) => `\\${character}`)}`;
}
