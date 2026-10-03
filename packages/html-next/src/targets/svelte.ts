/** Svelte 5 output from the shared, checked component definition. */
import { fail } from "../diagnostics.js";
import { compileComponentStylesForBuild } from "../component-styles-build.js";
import { kebabCase, componentName } from "../names.js";
import { declarationTypeNode, normalizeType } from "../type-system.js";
import type { ComponentDefinition, HandlerDeclaration, ReactiveDeclaration, TemplateNode } from "../template.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, quote, typeSource } from "./shared.js";
import { Lowering, present, type Scope, type Static, typeOf } from "./vue-lowering.js";

export interface SvelteConversionOptions {
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
}

export interface SvelteConversionOutput {
  readonly component: string;
  readonly css: string;
}

function checkSupported(definition: ComponentDefinition): void {
  for (const declaration of definition.declarations ?? []) {
    if (declaration.kind !== "state" && declaration.kind !== "computed" && declaration.kind !== "handler") {
      fail("HT030", `Svelte conversion does not yet support ${declaration.kind} declarations.`);
    }
    if (declaration.kind === "handler" && declaration.steps.some((step) =>
      step.kind !== "set" || step.guard !== undefined || step.writablePath.length !== 1)) {
      fail("HT030", "Svelte conversion does not yet support guarded, nested, or non-state handler steps.");
    }
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
    if (node.flow !== undefined && !["if", "with", "match", "when", "else"].includes(node.flow.kind) ||
      node.ref !== undefined || node.events?.some((event) => event.modifiers.length > 0)) {
      fail("HT030", "Svelte conversion does not yet support structural flow, event modifiers, or references.");
    }
    if (node.flow?.kind === "match" && node.name !== "template") {
      fail("HT030", "Svelte conversion does not yet support $match on an element wrapper.");
    }
    for (const attribute of node.attributes) {
      if (attribute.kind === "directive" && attribute.name === "html" || attribute.kind === "property" ||
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
  if (node.flow?.kind === "if") {
    if (node.flow.testPlan === undefined) fail("HT030", `Expression \`${node.flow.test}\` could not be converted.`);
    const { flow: _flow, ...body } = node;
    return `{#if ${lowering.condition(node.flow.testPlan.ast, scope)}}${renderNode(body, root, scope, lowering, imports)}{/if}`;
  }
  if (node.flow?.kind === "with") {
    if (node.flow.expressionPlan === undefined) fail("HT030", `Expression \`${node.flow.expr}\` could not be converted.`);
    const { flow: _flow, ...body } = node;
    const value = node.flow.expressionPlan.ast;
    const local: RootScope = {
      ...(scope as RootScope),
      code: new Map([...scope.code, [node.flow.alias, node.flow.alias]]),
      types: new Map([...scope.types, [node.flow.alias, typeOf(value, scope)]]),
    };
    return `{#if true}{@const ${node.flow.alias} = ${lowering.value(value, scope)}}${renderNode(body, root, local, lowering, imports)}{/if}`;
  }
  if (node.flow?.kind === "match") {
    const flow = node.flow;
    const value = flow.expressionPlan?.ast;
    const local: RootScope = flow.alias === undefined ? scope as RootScope : {
      ...(scope as RootScope),
      code: new Map([...scope.code, [flow.alias, flow.alias]]),
      types: new Map([...scope.types, [flow.alias, value === undefined ? { type: { kind: "terminal", name: "unknown" }, nullable: true } : typeOf(value, scope)]]),
    };
    const arms = node.children.filter((child): child is Extract<TemplateNode, { kind: "element" }> => child.kind === "element");
    const cases = arms.map((arm, index) => {
      const armFlow = arm.flow;
      const { flow: _flow, ...body } = arm;
      if (armFlow?.kind === "when") {
        if (armFlow.testPlan === undefined) fail("HT030", `Expression \`${armFlow.test}\` could not be converted.`);
        return `${index === 0 ? "{#if" : "{:else if"} ${lowering.condition(armFlow.testPlan.ast, local)}}${renderNode(body, false, local, lowering, imports)}`;
      }
      if (armFlow?.kind === "else") return `{:else}${renderNode(body, false, local, lowering, imports)}`;
      fail("HT018", "A $match child must be a $when or $else arm.");
    }).join("");
    const block = `${cases}{/if}`;
    if (flow.alias === undefined || value === undefined) return block;
    return `{#if true}{@const ${flow.alias} = ${lowering.value(value, scope)}}${block}{/if}`;
  }
  const contentDirective = node.attributes.find((attribute) => attribute.kind === "directive" && attribute.name === "value");
  const content = contentDirective?.kind === "directive" && contentDirective.expressionPlan !== undefined
    ? `{${lowering.text(contentDirective.expressionPlan.ast, scope)}}`
    : undefined;
  if (node.name === "template") return content ?? node.children.map((child) => renderNode(child, false, scope, lowering, imports)).join("");
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
      if (node.attributes.some((attribute) => attribute.name === `data-${kebabCase(prop)}`)) continue;
      attributes.push(`data-${kebabCase(prop)}={${prop} == null ? undefined : String(${prop})}`);
    }
  }
  attributes.push(...bindings);
  for (const event of node.events ?? []) attributes.push(`on${event.name}={${event.handler}}`);
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const children = content ?? node.children.map((child) => renderNode(child, false, scope, lowering, imports)).join("");
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
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const code = new Map(target.props.map((prop) => [prop.name, prop.name]));
  const types = new Map<string, Static>(target.props.map((prop) => [prop.name, present(normalizeType(prop.contract.type))]));
  const expressionScope: Scope = { code, types };
  for (const declaration of [...states, ...computed]) {
    code.set(declaration.name, declaration.name);
    types.set(declaration.name, declarationTypeNode(declaration.type, declaration.shape) === undefined
      ? declaration.expression === undefined ? { type: { kind: "terminal", name: "unknown" }, nullable: true }
        : typeOf(declaration.expression.ast, expressionScope)
      : present(declarationTypeNode(declaration.type, declaration.shape)!));
  }
  const scope: RootScope = {
    tag: definition.contract.tag,
    props: target.props.map((prop) => prop.name),
    code,
    types,
  };
  const lowering = new Lowering();
  const imports = new Set<string>();
  const markup = renderNode(definition.template, true, scope, lowering, imports);
  const propTypes = target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${typeSource(prop.contract.type)};`).join("\n  ");
  const destructured = target.props.map((prop) =>
    `${prop.name}${"default" in prop.contract ? ` = ${JSON.stringify(prop.contract.default)}` : ""}`).join(", ");
  const stateSources = states.map((state) =>
    `let ${state.name} = $state(${state.expression === undefined ? "undefined" : lowering.value(state.expression.ast, scope)});`);
  const computedSources = computed.map((value) =>
    `let ${value.name} = $derived(${value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, scope)});`);
  const handlerSources = handlers.map((handler) => `function ${handler.name}(): void {\n${handler.steps.map((step) => {
    if (step.kind !== "set") return "";
    return `  ${step.writablePath[0]} = ${lowering.value(step.value.ast, scope)};`;
  }).join("\n")}\n}`);
  const script = [
    '<script lang="ts">',
    'import type { Snippet } from "svelte";',
    ...[...imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.svelte`)};`),
    ...(css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${definition.contract.name}.css`)};`]),
    `type Props = { ${propTypes} children?: Snippet; [key: string]: unknown; };`,
    `let { ${destructured}${destructured === "" ? "" : ", "}children, ...rest }: Props = $props();`,
    ...stateSources,
    ...computedSources,
    ...handlerSources,
    ...lowering.fallbacks(),
    "</script>",
  ].join("\n");
  return { component: `${script}\n${markup}\n`, css };
}
