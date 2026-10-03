/** Svelte 5 output from the shared, checked component definition. */
import { fail } from "../diagnostics.js";
import { compileComponentStylesForBuild } from "../component-styles-build.js";
import { kebabCase, componentName } from "../names.js";
import { normalizeType } from "../type-system.js";
import type { ComponentDefinition, TemplateNode } from "../template.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, quote, typeSource } from "./shared.js";
import { Lowering, present, type Scope } from "./vue-lowering.js";

export interface SvelteConversionOptions {
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
}

export interface SvelteConversionOutput {
  readonly component: string;
  readonly css: string;
}

function checkSupported(definition: ComponentDefinition): void {
  if ((definition.declarations?.length ?? 0) > 0) {
    fail("HT030", "Svelte conversion does not yet support component declarations.");
  }
  if (definition.controller !== undefined) {
    fail("HT030", "Svelte conversion does not yet support controllers.");
  }
  const visit = (node: TemplateNode): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") {
      if (node.name !== undefined || node.nameExpression !== undefined || node.flow !== undefined ||
        (node.props?.length ?? 0) > 0) fail("HT030", "Svelte conversion does not yet support named or scoped slots.");
      for (const child of node.fallback ?? []) visit(child);
      return;
    }
    if (node.flow !== undefined || (node.events?.length ?? 0) > 0 || node.ref !== undefined) {
      fail("HT030", "Svelte conversion does not yet support structural flow, event handlers, or references.");
    }
    for (const attribute of node.attributes) {
      if (attribute.kind === "directive" || attribute.kind === "property" ||
        attribute.kind === "attribute" && (attribute.twoWay === true || attribute.target !== undefined)) {
        fail("HT030", "Svelte conversion does not yet support content, property, class, style, or two-way bindings.");
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(definition.template);
}

function renderNode(node: TemplateNode, root: boolean, scope: Scope, lowering: Lowering,
  imports: Set<string>): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    const fallback = (node.fallback ?? []).map((child) => renderNode(child, false, scope, lowering, imports)).join("");
    return `{#if children}{@render children()}${fallback === "" ? "" : `{:else}${fallback}`}{/if}`;
  }
  if (node.name === "template") {
    return node.children.map((child) => renderNode(child, false, scope, lowering, imports)).join("");
  }
  const component = node.name.includes("-");
  if (component) imports.add(node.name);
  const name = component ? componentName(node.name) : node.name;
  const literals: string[] = [];
  const bindings: string[] = [];
  const authoredClass = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "class") : undefined;
  const authoredStyle = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "style") : undefined;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      if (root && (attribute.name === "class" || attribute.name === "style")) continue;
      literals.push(`${attribute.name}=${quote(attribute.value)}`);
      continue;
    }
    if (attribute.kind === "attribute") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Expression \`${attribute.expression}\` could not be converted.`);
      bindings.push(`${attribute.name}={${lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name)}}`);
    }
  }
  const attributes = [...literals];
  if (root) {
    attributes.push("{...rest}");
    if (authoredClass?.kind === "literal") {
      attributes.push(`class={[${quote(authoredClass.value)}, rest.class].filter(Boolean).join(" ")}`);
    }
    if (authoredStyle?.kind === "literal") {
      attributes.push(`style={[${quote(authoredStyle.value)}, rest.style].filter(Boolean).join("; ")}`);
    }
    attributes.push(`data-component=${quote((scope as RootScope).tag)}`);
    for (const prop of (scope as RootScope).props) {
      attributes.push(`data-${kebabCase(prop)}={${prop} == null ? undefined : String(${prop})}`);
    }
  }
  attributes.push(...bindings);
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const children = node.children.map((child) => renderNode(child, false, scope, lowering, imports)).join("");
  return `${open}${children}</${name}>`;
}

interface RootScope extends Scope {
  readonly tag: string;
  readonly props: readonly string[];
}

export function generateSvelteOutput(definition: ComponentDefinition, options: SvelteConversionOptions = {}): SvelteConversionOutput {
  checkSupported(definition);
  const target = targetComponent(definition);
  const css = compileComponentStylesForBuild(definition.css, definition).css;
  const scope: RootScope = {
    tag: definition.contract.tag,
    props: target.props.map((prop) => prop.name),
    code: new Map(target.props.map((prop) => [prop.name, prop.name])),
    types: new Map(target.props.map((prop) => [prop.name, present(normalizeType(prop.contract.type))])),
  };
  const lowering = new Lowering();
  const imports = new Set<string>();
  const markup = renderNode(definition.template, true, scope, lowering, imports);
  const propTypes = target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${typeSource(prop.contract.type)};`).join("\n  ");
  const destructured = target.props.map((prop) =>
    `${prop.name}${"default" in prop.contract ? ` = ${JSON.stringify(prop.contract.default)}` : ""}`).join(", ");
  const script = [
    '<script lang="ts">',
    'import type { Snippet } from "svelte";',
    ...[...imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.svelte`)};`),
    ...(css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${definition.contract.name}.css`)};`]),
    `type Props = { ${propTypes} children?: Snippet; [key: string]: unknown; };`,
    `let { ${destructured}${destructured === "" ? "" : ", "}children, ...rest }: Props = $props();`,
    ...lowering.fallbacks(),
    "</script>",
  ].join("\n");
  return { component: `${script}\n${markup}\n`, css };
}
