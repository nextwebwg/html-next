/**
 * Component style compilation for build tools, which have no DOM. It performs the same rename,
 * two-copy prune, and selector rewrite as the browser (`component-styles.ts`), over postcss.
 */
import postcss, { type AtRule, type ChildNode, type Container, type Rule } from "postcss";

import {
  assembleComponentStyles,
  type CompiledComponentStyles,
  renameComponentPseudoClasses,
  rewriteComponentSelector,
  styleRuleKind,
  type StyleRuleKind,
  validateStateNames,
} from "./component-styles.js";
import type { ComponentDefinition } from "./template.js";

/** At-rules whose block holds style rules; everything else is document-wide and hoisted. */
const GROUPING = new Set(["media", "supports", "container", "layer", "scope", "starting-style"]);

export function compileComponentStylesForBuild(
  css: string,
  definition: ComponentDefinition,
  source?: string,
): CompiledComponentStyles {
  const tag = definition.contract.tag;
  if (css.trim() === "") return { css: "", stateNames: [] };
  const renamed = renameComponentPseudoClasses(css);
  const names = new Set<string>();
  const hoisted: string[] = [];

  const rewrite = (rule: Rule, kind: StyleRuleKind): void => {
    rule.selector = rewriteComponentSelector(rule.selector, tag, kind, names);
    rule.walkRules((nested) => {
      nested.selector = rewriteComponentSelector(nested.selector, tag, kind, names);
    });
  };
  const prune = (container: Container<ChildNode>, want: StyleRuleKind, topLevel: boolean): void => {
    container.each((node) => {
      if (node.type === "rule") {
        const kind = styleRuleKind(node.selector);
        if (kind === want) rewrite(node, kind);
        else node.remove();
      } else if (node.type === "atrule" && GROUPING.has(node.name.toLowerCase()) && node.nodes !== undefined) {
        prune(node as AtRule, want, false);
      } else if (node.type === "atrule") {
        if (topLevel && want === "own") hoisted.push(node.toString());
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
  validateStateNames(definition, names, source);
  return { css: assembleComponentStyles(tag, own, slotted, hoisted.join("\n")), stateNames: [...names] };
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
  const root = postcss.parse(renameComponentPseudoClasses(css, ["host-state"]));
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return;
    rule.selector = rewriteComponentSelector(rule.selector, tag, "slotted", names);
  });
  validateStateNames(definition, names, source);
  return { css: root.toString().trim(), stateNames: [...names] };
}
