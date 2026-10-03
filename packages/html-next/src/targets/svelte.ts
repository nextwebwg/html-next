/** Svelte 5 output from the shared, checked component definition. */
import { fail } from "../diagnostics.js";
import { compileComponentStylesForBuild } from "../component-styles-build.js";
import { kebabCase, componentName } from "../names.js";
import { declarationTypeNode, normalizeType } from "../type-system.js";
import type { ComponentDefinition, ElementNode, HandlerDeclaration, ReactiveDeclaration, TemplateNode } from "../template.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, quote, typeSource } from "./shared.js";
import { Lowering, present, type Scope, type Static, typeOf } from "./vue-lowering.js";

export interface SvelteConversionOptions {
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
  readonly propsSpecifier?: string;
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
    if (node.flow !== undefined && !["if", "with", "match", "when", "else", "each"].includes(node.flow.kind) ||
      node.ref !== undefined || node.events?.some((event) => event.modifiers.length > 0)) {
      fail("HT030", "Svelte conversion does not yet support structural flow, event modifiers, or references.");
    }
    if (node.flow?.kind === "match" && node.name !== "template") {
      fail("HT030", "Svelte conversion does not yet support $match on an element wrapper.");
    }
    for (const attribute of node.attributes) {
      if (attribute.kind === "directive" && attribute.name === "html" || attribute.kind === "property" ||
        attribute.kind === "attribute" && attribute.twoWay === true) {
        fail("HT030", "Svelte conversion does not yet support HTML content, property, or two-way bindings.");
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(definition.template);
}

interface RenderContext {
  readonly imports: Set<string>;
  nextLoop: number;
}

function renderEach(node: ElementNode, scope: Scope, lowering: Lowering, context: RenderContext): string {
  const flow = node.flow;
  if (flow?.kind !== "each" || flow.listPlan === undefined) fail("HT030", "A Svelte list needs a checked $each expression.");
  const listNode = flow.listPlan.ast;
  const listType = typeOf(listNode, scope);
  const itemType: Static = listType.type.kind === "list"
    ? { type: present(listType.type.item).type, nullable: false }
    : { type: { kind: "terminal", name: "unknown" }, nullable: false };
  const indexType: Static = { type: { kind: "terminal", name: "number" }, nullable: false };
  const loopType: Static = { type: { kind: "object", open: false, fields: [
    { name: "index", type: indexType.type, optional: false },
    { name: "first", type: { kind: "terminal", name: "boolean" }, optional: false },
    { name: "last", type: { kind: "terminal", name: "boolean" }, optional: false },
    { name: "count", type: indexType.type, optional: false },
  ] }, nullable: false };
  const row = `htmlNextRow${context.nextLoop++}`;
  const scopeWith = (item: string, index: string, loop: string): Scope => ({
    code: new Map([...scope.code, [flow.item, item], ...(flow.index === undefined ? [] : [[flow.index, index] as const]), ["loop", loop]]),
    types: new Map([...scope.types, [flow.item, itemType], ...(flow.index === undefined ? [] : [[flow.index, indexType] as const]), ["loop", loopType]]),
  });
  const list = lowering.list(listNode, scope, flow.item, {
    ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
    itemScope: scopeWith(flow.item, "index", "loop"),
    sort: (flow.sort ?? "").split(",").map((key) => key.trim()).filter(Boolean),
    ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
  });
  const safeList = listType.type.kind === "list" && listType.nullable ? `(${list} ?? [])` : list;
  const callbackScope = scopeWith("item", "index", "loop");
  const checked = flow.keyPlan === undefined ? safeList : lowering.uniqueKeys(safeList,
    `(item, index, loop) => ${lowering.value(flow.keyPlan.ast, callbackScope)}`);
  const rows = lowering.eachRows(checked);
  const rowScope = scopeWith(`${row}.item`, `${row}.index`, `${row}.loop`);
  const key = flow.keyPlan === undefined ? "" : ` (${lowering.value(flow.keyPlan.ast, rowScope)})`;
  const { flow: _flow, ...body } = node;
  return `{#each ${rows} as ${row}${key}}${renderNode(body, false, rowScope, lowering, context)}{/each}`;
}

function renderNode(node: TemplateNode, root: boolean, scope: Scope, lowering: Lowering,
  context: RenderContext): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    const fallback = (node.fallback ?? []).map((child) => renderNode(child, false, scope, lowering, context)).join("");
    return `{#if children}{@render children()}${fallback === "" ? "" : `{:else}${fallback}`}{/if}`;
  }
  if (node.flow?.kind === "each") return renderEach(node, scope, lowering, context);
  if (node.flow?.kind === "if") {
    if (node.flow.testPlan === undefined) fail("HT030", `Expression \`${node.flow.test}\` could not be converted.`);
    const { flow: _flow, ...body } = node;
    return `{#if ${lowering.condition(node.flow.testPlan.ast, scope)}}${renderNode(body, root, scope, lowering, context)}{/if}`;
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
    return `{#if true}{@const ${node.flow.alias} = ${lowering.value(value, scope)}}${renderNode(body, root, local, lowering, context)}{/if}`;
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
        return `${index === 0 ? "{#if" : "{:else if"} ${lowering.condition(armFlow.testPlan.ast, local)}}${renderNode(body, root, local, lowering, context)}`;
      }
      if (armFlow?.kind === "else") return `{:else}${renderNode(body, root, local, lowering, context)}`;
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
  if (node.name === "template") return content ?? node.children.map((child) => renderNode(child, false, scope, lowering, context)).join("");
  const component = node.name.includes("-");
  if (component) context.imports.add(node.name);
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
      if (attribute.target === "class") bindings.push(`class:${attribute.name}={${lowering.condition(attribute.expressionPlan.ast, scope)}}`);
      else if (attribute.target === "style") bindings.push(`style:${attribute.name}={${lowering.text(attribute.expressionPlan.ast, scope)}}`);
      else bindings.push(`${attribute.name}={${lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name)}}`);
    }
  }
  const attributes = [...literals];
  if (root) {
    attributes.push("{...rest}");
    if ((scope as RootScope).props.length > 0) attributes.push("bind:this={rootElement}");
    if (authoredClass?.kind === "literal") {
      attributes.push(`class={[${quote(authoredClass.value)}, rest.class].filter(Boolean).join(" ")}`);
    }
    if (authoredStyle?.kind === "literal") {
      attributes.push(`style={[${quote(authoredStyle.value)}, rest.style].filter(Boolean).join("; ")}`);
    }
    attributes.push(`data-component=${quote((scope as RootScope).tag)}`);
    for (const prop of (scope as RootScope).props) {
      if (node.attributes.some((attribute) => attribute.name === `data-${kebabCase(prop)}`)) continue;
      const value = scope.code.get(prop) ?? prop;
      attributes.push(`data-${kebabCase(prop)}={${value} == null ? undefined : String(${value})}`);
    }
  }
  attributes.push(...bindings);
  for (const event of node.events ?? []) attributes.push(`on${event.name}={${event.handler}}`);
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const children = content ?? node.children.map((child) => renderNode(child, false, scope, lowering, context)).join("");
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
  const code = new Map(target.props.map((prop) => [prop.name, `checkedProps.${prop.name}`]));
  const types = new Map<string, Static>(target.props.map((prop) => [prop.name, { type: normalizeType(prop.contract.type), nullable: true }]));
  const expressionScope: Scope = { code, types };
  for (const declaration of [...states, ...computed]) {
    code.set(declaration.name, declaration.name);
    const declared = declarationTypeNode(declaration.type, declaration.shape);
    const inferred = declaration.expression === undefined
      ? { type: { kind: "terminal", name: "unknown" }, nullable: true } as Static
      : typeOf(declaration.expression.ast, expressionScope);
    const typed = declared === undefined ? inferred : present(declared);
    types.set(declaration.name, { ...typed, nullable: typed.nullable || declaration.expression === undefined });
  }
  const scope: RootScope = {
    tag: definition.contract.tag,
    props: target.props.map((prop) => prop.name),
    code,
    types,
  };
  const lowering = new Lowering();
  const context: RenderContext = { imports: new Set(), nextLoop: 0 };
  const markup = renderNode(definition.template, true, scope, lowering, context);
  const propTypes = target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${typeSource(prop.contract.type)};`).join("\n  ");
  const destructured = target.props.map((prop) =>
    `${prop.name}: input${prop.name}${"default" in prop.contract ? ` = ${JSON.stringify(prop.contract.default)}` : ""}`).join(", ");
  const hasProps = target.props.length > 0;
  const validityContract = { props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) =>
    [name, { ...prop, type: normalizeType(prop.type) }])) };
  const checkedPropSources = target.props.map((prop) =>
    `    ${quote(prop.name)}: checkedProp<${typeSource(prop.contract.type)}>(input${prop.name}, ${JSON.stringify(normalizeType(prop.contract.type))}, ${prop.contract.required}, ${quote(prop.name)}, acceptedProps, inputAccepted, false),`);
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
    ...(hasProps ? ['import { untrack } from "svelte";'] : []),
    ...(hasProps ? [`import { checkedProp, mountPropValidity, updatePropValidity } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.svelte`)};`),
    ...(css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${definition.contract.name}.css`)};`]),
    `type Props = { ${propTypes} children?: Snippet; [key: string]: unknown; };`,
    `let { ${destructured}${destructured === "" ? "" : ", "}children, ...rest }: Props = $props();`,
    ...(hasProps ? [
      `const acceptedProps: Record<string, unknown> = { ${target.props.map((prop) => `${quote(prop.name)}: ${"default" in prop.contract ? JSON.stringify(prop.contract.default) : "null"}`).join(", ")} };`,
      "const inputAccepted: Record<string, boolean> = {};",
      "let checkedProps = $derived.by(() => ({",
      ...checkedPropSources,
      "}));",
      `const propValidityContract = ${JSON.stringify(validityContract)} as const;`,
      `let propInputValues = $derived({ ...checkedProps, ${target.props.map((prop) => `${quote(prop.name)}: input${prop.name}`).join(", ")} });`,
      "let rootElement = $state<Element | undefined>(undefined);",
      "$effect(() => {",
      "  const element = rootElement;",
      "  if (element === undefined) return;",
      "  return mountPropValidity(element, { contract: propValidityContract, values: untrack(() => propInputValues) });",
      "});",
      "$effect(() => {",
      "  if (rootElement !== undefined) updatePropValidity(rootElement, { contract: propValidityContract, values: propInputValues });",
      "});",
    ] : []),
    ...stateSources,
    ...computedSources,
    ...handlerSources,
    ...lowering.fallbacks(),
    "</script>",
  ].join("\n");
  return { component: `${script}\n${markup}\n`, css };
}
