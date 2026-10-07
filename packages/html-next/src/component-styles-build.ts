/**
 * Component style compilation for build tools, which have no DOM. It performs the same rename,
 * two-copy prune, and selector rewrite as the browser (`component-styles.ts`), over postcss.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

import {
  assembleComponentStyles,
  componentStyleNameResolver,
  COMPONENT_ATTRIBUTE,
  type CompiledComponentStyles,
  renameComponentPseudoClasses,
  rewriteComponentSelector,
  styleRuleKind,
  type StyleRuleKind,
} from "./component-styles.js";
import type { ComponentDefinition } from "./template.js";

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
 * The generated root carries `data-component` and the state attribute, so `:host` and
 * `:host-state()` become attribute selectors on it.
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
    rule.selector = rewriteComponentSelector(rule.selector, tag, `[${COMPONENT_ATTRIBUTE}~="${tag}"]`, names, canonical);
  });
  return { css: root.toString().trim(), stateNames: Array.from(names) };
}
