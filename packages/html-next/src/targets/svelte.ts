/** Svelte 5 output from the shared, checked component definition. */
import { fail } from "../diagnostics.js";
import { compileComponentStylesForSvelte, SVELTE_OWNER_ATTRIBUTE } from "../component-styles-build.js";
import { kebabCase, componentName } from "../names.js";
import { declarationTypeNode, normalizeType, parseTypedValue } from "../type-system.js";
import type { ComponentDefinition, DataDeclaration, ElementNode, HandlerDeclaration, ReactiveDeclaration, TemplateNode } from "../template.js";
import type { PropContract } from "../types.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, quote, svgAttributeName, propTypeSource, typeSource } from "./shared.js";
import { Lowering, mayProduceInvalidResult, present, type Scope, type Static, typeOf } from "./vue-lowering.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";

export interface SvelteConversionOptions {
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
  readonly propsSpecifier?: string;
  readonly htmlSpecifier?: string;
  readonly propContractsByTag?: ReadonlyMap<string, Readonly<Record<string, PropContract>>>;
}

export interface SvelteConversionOutput {
  readonly component: string;
  readonly css: string;
  readonly usesHtml: boolean;
}

function nativeControlBinding(tag: string, name: string): boolean {
  return ["input", "textarea", "select"].includes(tag) &&
    (name === "value" || name === "checked" && tag === "input");
}

function checkSupported(definition: ComponentDefinition): void {
  for (const prop of Object.values(definition.contract.props)) {
    if (prop.select !== undefined && definition.contract.props[prop.select.from] === undefined) {
      fail("HT030", "Svelte conversion does not yet support props selected by component state.");
    }
  }
  for (const declaration of definition.declarations ?? []) {
    if (declaration.kind === "data" && declaration.source !== undefined) {
      fail("HT030", "Svelte conversion does not yet support data sources.");
    }
    if (!["state", "computed", "handler", "data"].includes(declaration.kind)) {
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
      // Svelte's native boolean attribute path also sets the reflected disabled property.
      if (attribute.kind === "property" && attribute.name !== "disabled" ||
        attribute.kind === "attribute" && attribute.twoWay === true && (
          node.name.includes("-") ||
          ["input", "textarea", "select"].includes(node.name) && !nativeControlBinding(node.name, attribute.name) ||
          attribute.writablePath?.length !== 1 || typeof attribute.writablePath[0] !== "string"
        )) {
        fail("HT030", "Svelte conversion does not yet support property or two-way bindings on this element.");
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(definition.template);
}

interface RenderContext {
  readonly imports: Set<string>;
  readonly propContractsByTag?: SvelteConversionOptions["propContractsByTag"];
  readonly styleOwner?: string;
  nextLoop: number;
  htmlSites: number;
  readonly localHtmlSites: Set<number>;
  readonly retentions: Map<number, { readonly initial?: string }>;
  readonly localRetentions: Set<number>;
  usesAttributeBinding: boolean;
  readonly bindingHelperName: string;
  readonly bindingValueName: string;
  readonly rootAttributeBindings: Set<string>;
}

function retained(context: RenderContext, source: string, initial: string): string {
  const site = context.retentions.size;
  context.retentions.set(site, { initial });
  return `retained${site}(${source})`;
}

function retainedStructural(context: RenderContext, source: string): string {
  const site = context.retentions.size;
  context.retentions.set(site, {});
  return `retained${site}(${source})`;
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
  const listSource = lowering.value(listNode, scope);
  const stableSource = mayProduceInvalidResult(listNode, scope) ? retained(context, listSource, "[] as any[]") : listSource;
  const list = lowering.list(listNode, scope, flow.item, {
    ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
    itemScope: scopeWith(flow.item, "index", "loop"),
    sort: (flow.sort ?? "").split(",").map((key) => key.trim()).filter(Boolean),
    ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
  }, stableSource);
  const safeList = listType.type.kind === "list" && listType.nullable ? `(${list} ?? [])` : list;
  const callbackScope = scopeWith("item", "index", "loop");
  const checked = flow.keyPlan === undefined ? safeList : lowering.uniqueKeys(safeList,
    `(item, index, loop) => ${lowering.value(flow.keyPlan.ast, callbackScope)}`);
  const rows = lowering.eachRows(checked);
  const rowScope = scopeWith(`${row}.item`, `${row}.index`, `${row}.loop`);
  const key = flow.keyPlan === undefined ? "" : ` (${lowering.value(flow.keyPlan.ast, rowScope)})`;
  const { flow: _flow, ...body } = node;
  const firstHtmlSite = context.htmlSites;
  const firstRetention = context.retentions.size;
  const markup = renderNode(body, false, rowScope, lowering, context);
  const localHtml = Array.from({ length: context.htmlSites - firstHtmlSite }, (_, index) => firstHtmlSite + index)
    .filter((site) => !context.localHtmlSites.has(site));
  for (const site of localHtml) context.localHtmlSites.add(site);
  const localRetentions = [...context.retentions].filter(([site]) => site >= firstRetention && !context.localRetentions.has(site));
  for (const [site] of localRetentions) context.localRetentions.add(site);
  const declarations = [
    ...localHtml.map((site) => `{@const htmlSite${site} = retainedSanitizedHtml(${context.styleOwner === undefined ? "" : quote(context.styleOwner)})}`),
    ...localRetentions.map(([site, entry]) => `{@const retained${site} = ${entry.initial === undefined ? "retainedStructuralValue()" : `retainedValue(${entry.initial})`}}`),
  ].join("");
  return `{#each ${rows} as ${row}${key}}${declarations}${markup}{/each}`;
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
    const test = node.flow.testPlan.ast;
    const condition = lowering.condition(test, scope);
    return `{#if ${mayProduceInvalidResult(test, scope) ? retained(context, condition, "false") : condition}}${renderNode(body, root, scope, lowering, context)}{/if}`;
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
    const source = lowering.value(value, scope);
    const markup = renderNode(body, root, local, lowering, context);
    if (!mayProduceInvalidResult(value, scope)) return `{#if true}{@const ${node.flow.alias} = ${source}}${markup}{/if}`;
    const site = context.retentions.size;
    const result = `htmlNextStructural${site}`;
    const retainedSource = retainedStructural(context, source);
    return `{#if true}{@const ${result} = ${retainedSource}}{#if ${result}.ready}{@const ${node.flow.alias} = ${result}.value}${markup}{/if}{/if}`;
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
        const test = armFlow.testPlan.ast;
        const condition = lowering.condition(test, local);
        return `${index === 0 ? "{#if" : "{:else if"} ${mayProduceInvalidResult(test, local) ? retained(context, condition, "false") : condition}}${renderNode(body, root, local, lowering, context)}`;
      }
      if (armFlow?.kind === "else") return `{:else}${renderNode(body, root, local, lowering, context)}`;
      fail("HT018", "A $match child must be a $when or $else arm.");
    }).join("");
    const block = `${cases}{/if}`;
    if (flow.alias === undefined || value === undefined) return block;
    const source = lowering.value(value, scope);
    if (!mayProduceInvalidResult(value, scope)) return `{#if true}{@const ${flow.alias} = ${source}}${block}{/if}`;
    const site = context.retentions.size;
    const result = `htmlNextStructural${site}`;
    const retainedSource = retainedStructural(context, source);
    return `{#if true}{@const ${result} = ${retainedSource}}{#if ${result}.ready}{@const ${flow.alias} = ${result}.value}${block}{/if}{/if}`;
  }
  const contentDirective = node.attributes.find((attribute) => attribute.kind === "directive");
  let content: string | undefined;
  if (contentDirective?.kind === "directive" && contentDirective.expressionPlan !== undefined) {
    const value = lowering.text(contentDirective.expressionPlan.ast, scope);
    content = contentDirective.name === "html"
      ? `{@html htmlSite${context.htmlSites++}(${value})}`
      : `{${value}}`;
  }
  if (node.name === "template") return content ?? node.children.map((child) => renderNode(child, false, scope, lowering, context)).join("");
  const component = node.name.includes("-");
  if (component) context.imports.add(node.name);
  const name = component ? componentName(node.name) : node.name;
  const childProps = component ? context.propContractsByTag?.get(node.name) : undefined;
  const childProp = (attributeName: string): readonly [string, PropContract] | undefined =>
    Object.entries(childProps ?? {}).find(([prop]) => prop.toLowerCase() === attributeName || kebabCase(prop) === attributeName);
  const literals: string[] = [];
  const bindings: string[] = [];
  const controlledNames = new Set(node.attributes.filter((attribute) => attribute.kind === "property" ||
    attribute.kind === "attribute" && attribute.twoWay && !nativeControlBinding(node.name, attribute.name))
    .map((attribute) => attribute.name));
  const authoredClass = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "class") : undefined;
  const authoredStyle = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "style") : undefined;
  const rootScope = root ? scope as RootScope : undefined;
  const reflectedNames = new Set(rootScope?.props.map((prop) => `data-${kebabCase(prop)}`) ?? []);
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      if (controlledNames.has(attribute.name)) continue;
      if (root && (attribute.name === "class" || attribute.name === "style" || reflectedNames.has(attribute.name))) continue;
      const declared = childProp(attribute.name);
      if (declared === undefined) literals.push(`${attribute.name}=${quote(attribute.value)}`);
      else {
        const [prop, contract] = declared;
        const typeNode = normalizeType(contract.type);
        const parsed = attribute.value === "" && typeNode.kind === "terminal" && typeNode.name === "boolean"
          ? { ok: true as const, value: true }
          : parseTypedValue(attribute.value, contract.type, "$", "html");
        literals.push(`${prop}={${parsed.ok ? JSON.stringify(parsed.value) : quote(attribute.value)}}`);
      }
      continue;
    }
    if (attribute.kind === "attribute") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Expression \`${attribute.expression}\` could not be converted.`);
      if (root && reflectedNames.has(attribute.name) && attribute.twoWay !== true) continue;
      if (attribute.twoWay === true) {
        if (nativeControlBinding(node.name, attribute.name)) bindings.push(`bind:${attribute.name}={${attribute.writablePath![0]}}`);
        else {
          // Ordinary elements reflect the attribute, and feed their native value back on input.
          context.usesAttributeBinding = true;
          const name = svgAttributeName(attribute.name);
          const value = lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name);
          // Svelte optimizes value= into a property write even on <output>. Keep the
          // server attribute declarative, and use only setAttribute/removeAttribute on the client.
          bindings.push(`{...(typeof document === 'undefined' ? { ${quote(name)}: ${value} } : {})}`);
          bindings.push(`{@attach ${context.bindingHelperName}(${quote(name)}, () => ${value}, (${context.bindingValueName}: any) => { ${attribute.writablePath![0]} = ${context.bindingValueName}; })}`);
          if (root) context.rootAttributeBindings.add(attribute.name);
        }
      }
      else if (attribute.target === "class") bindings.push(`class:${attribute.name}={${lowering.condition(attribute.expressionPlan.ast, scope)}}`);
      else if (attribute.target === "style") bindings.push(`style:${attribute.name}={${lowering.text(attribute.expressionPlan.ast, scope)}}`);
      else if (childProp(attribute.name) !== undefined) bindings.push(`${childProp(attribute.name)![0]}={${lowering.value(attribute.expressionPlan.ast, scope)}}`);
      else bindings.push(`${component ? attribute.name : svgAttributeName(attribute.name)}={${lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name)}}`);
    }
    if (attribute.kind === "property") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Expression \`${attribute.expression}\` could not be converted.`);
      bindings.push(`${attribute.name}={${lowering.value(attribute.expressionPlan.ast, scope)}}`);
    }
  }
  const attributes = [...literals];
  if (root) {
    attributes.push("{...rootAttrs}");
    attributes.push("bind:this={rootElement}");
    if (authoredClass?.kind === "literal") {
      attributes.push(`class={[${quote(authoredClass.value)}, rest.class].filter(Boolean).join(" ")}`);
    }
    if (authoredStyle?.kind === "literal") {
      attributes.push(`style={[${quote(authoredStyle.value)}, rest.style].filter(Boolean).join("; ")}`);
    }
    attributes.push(`data-component=${quote((scope as RootScope).tag)}`);
    if ((scope as RootScope).stateNames.length > 0) attributes.push(`data-${(scope as RootScope).tag}-state={hostState || undefined}`);
    for (const prop of rootScope!.props) {
      const name = `data-${kebabCase(prop)}`;
      const authored = node.attributes.find((attribute) => attribute.name === name);
      const bound = authored?.kind === "attribute";
      const fallback = authored?.kind === "literal" ? quote(authored.value) : "undefined";
      const type = normalizeType(rootScope!.propContracts[prop]!.type);
      const separator = type.kind === "separated-list" ? quote(type.separator === "space" ? " " : ", ") : undefined;
      const value = scope.code.get(prop) ?? prop;
      const serialized = separator === undefined
        ? `typeof ${value} === "object" ? JSON.stringify(${value}) : String(${value})`
        : `Array.isArray(${value}) ? ${value}.join(${separator}) : String(${value})`;
      attributes.push(`${name}={${!bound ? `input${prop} == null ? ${fallback} : ` : ""}${value} == null ? undefined : (${serialized})}`);
    }
  }
  attributes.push(...bindings);
  if (!component && context.styleOwner !== undefined) attributes.push(`${SVELTE_OWNER_ATTRIBUTE}=${quote(context.styleOwner)}`);
  for (const event of node.events ?? []) attributes.push(`on${event.name}={${event.handler}}`);
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const children = content ?? node.children.map((child) => renderNode(child, false, scope, lowering, context)).join("");
  return `${open}${children}</${name}>`;
}

interface RootScope extends Scope {
  readonly tag: string;
  readonly props: readonly string[];
  readonly propContracts: Readonly<Record<string, PropContract>>;
  readonly stateNames: readonly string[];
}

export function generateSvelteOutput(definition: ComponentDefinition, options: SvelteConversionOptions = {}): SvelteConversionOutput {
  checkSupported(definition);
  const target = targetComponent(definition);
  const styles = compileComponentStylesForSvelte(definition.css, definition);
  const css = styles.css;
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const data = declarations.filter((declaration): declaration is DataDeclaration => declaration.kind === "data");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const code = new Map(target.props.map((prop) => [prop.name, `checkedProps.${prop.name}`]));
  const types = new Map<string, Static>(target.props.map((prop) => [prop.name, { type: normalizeType(prop.contract.type), nullable: true }]));
  const expressionScope: Scope = { code, types };
  const dataNames = new Map<DataDeclaration, string>();
  const taken = new Set([...code.keys(), ...declarations.map((declaration) => declaration.name)]);
  const freshIdentifier = (base: string): string => {
    let name = base;
    let suffix = 2;
    while (taken.has(name)) name = `${base}${suffix++}`;
    taken.add(name);
    return name;
  };
  for (const declaration of data) {
    const name = freshIdentifier(`htmlNextData${dataNames.size}`);
    dataNames.set(declaration, name);
    code.set(declaration.name, name);
    types.set(declaration.name, { type: { kind: "object", open: false, fields: [
      { name: "pending", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "value", type: { kind: "terminal", name: "unknown" }, optional: false },
      { name: "error", type: { kind: "terminal", name: "unknown" }, optional: false },
      { name: "ok", type: { kind: "terminal", name: "boolean" }, optional: false },
    ] }, nullable: false });
  }
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
    propContracts: definition.contract.props,
    stateNames: styles.stateNames,
    code,
    types,
  };
  const lowering = new Lowering();
  const context: RenderContext = { imports: new Set(), propContractsByTag: options.propContractsByTag,
    ...(css !== "" && (definition.slots?.length ?? 0) > 0 ? { styleOwner: definition.contract.tag } : {}),
    nextLoop: 0, htmlSites: 0, localHtmlSites: new Set(), retentions: new Map(), localRetentions: new Set(),
    usesAttributeBinding: false, bindingHelperName: freshIdentifier("boundAttribute"),
    bindingValueName: freshIdentifier("boundValue"), rootAttributeBindings: new Set() };
  const markup = renderNode(definition.template, true, scope, lowering, context);
  const propTypes = target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${propTypeSource(prop.contract)};`).join("\n  ");
  const destructured = target.props.map((prop) => `${prop.name}: input${prop.name}`).join(", ");
  const hasProps = target.props.length > 0;
  const selectors = [...new Set(target.props.flatMap((prop) => prop.contract.select === undefined ? [] : [prop.contract.select.from]))];
  const validityContract = { props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) =>
    [name, { ...prop, type: prop.select === undefined ? normalizeType(prop.type)
      : { kind: "union" as const, members: prop.select.options.map((option) => option.type) } }])) };
  const inputSource = (name: string): string => {
    const prop = definition.contract.props[name]!;
    return "default" in prop ? `(input${name} === undefined ? ${JSON.stringify(prop.default)} : input${name})` : `input${name}`;
  };
  const checkedPropSources = target.props.map((prop) => {
    const select = prop.contract.select;
    const type = select === undefined ? JSON.stringify(normalizeType(prop.contract.type))
      : `selectedPropNode(${inputSource(select.from)}, ${JSON.stringify(select.options)})`;
    const source = inputSource(prop.name);
    return `    ${quote(prop.name)}: checkedProp<${typeSource(prop.contract.type)}>(${source}, ${type}, ${prop.contract.required}, ${quote(prop.name)}, acceptedProps, inputAccepted, false),`;
  });
  const stateSources = states.map((state) =>
    `let ${state.name} = $state(${state.expression === undefined ? "undefined" : lowering.value(state.expression.ast, scope)});`);
  const computedSources = computed.map((value) => {
    const expression = value.expression?.ast;
    const source = expression === undefined ? "undefined" : lowering.value(expression, scope);
    return `let ${value.name} = $derived(${expression !== undefined && mayProduceInvalidResult(expression, scope)
      ? retained(context, source, "undefined as any") : source});`;
  });
  const handlerSources = handlers.map((handler) => `function ${handler.name}(): void {\n${handler.steps.map((step) => {
    if (step.kind !== "set") return "";
    return `  ${step.writablePath[0]} = ${lowering.value(step.value.ast, scope)};`;
  }).join("\n")}\n}`);
  const script = [
    '<script lang="ts">',
    'import type { Snippet } from "svelte";',
    ...(hasProps ? ['import { untrack } from "svelte";'] : []),
    ...(context.htmlSites === 0 ? [] : [`import { retainedSanitizedHtml } from ${quote(options.htmlSpecifier ?? "./html")};`]),
    ...(hasProps ? [`import { checkedProp, mountPropValidity, updatePropValidity${selectors.length === 0 ? "" : ", selectedPropNode"} } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.svelte`)};`),
    ...(css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${definition.contract.name}.css`)};`]),
    `type Props = { ${propTypes} children?: Snippet; [key: string]: unknown; };`,
    `let { ${destructured}${destructured === "" ? "" : ", "}children, ...rest }: Props = $props();`,
    // Svelte's spread path normalizes these names through an inherited object property.
    // Keep ordinary passthrough attrs native to Svelte; write only these names with the DOM API.
    `const rootAttrs = $derived.by(() => { const attrs = { ...rest }; ${[...context.rootAttributeBindings].map((name) => `delete attrs[${quote(name)}];`).join(" ")} if (typeof document !== 'undefined') { delete attrs.constructor; delete attrs.__proto__; } return attrs; });`,
    "let rootElement = $state<Element | undefined>(undefined);",
    "let specialElement: Element | undefined;",
    "let hadConstructor = false;",
    "let hadProto = false;",
    "$effect(() => {",
    "  const element = rootElement;",
    "  if (element === undefined) return;",
    "  if (element !== specialElement) { specialElement = element; hadConstructor = false; hadProto = false; }",
    "  const constructor = Object.keys(rest).includes('constructor');",
    "  if (constructor) element.setAttribute('constructor', String(rest.constructor));",
    "  else if (hadConstructor) element.removeAttribute('constructor');",
    "  hadConstructor = constructor;",
    "  const proto = Object.keys(rest).includes('__proto__');",
    "  if (proto) element.setAttribute('__proto__', String(rest.__proto__));",
    "  else if (hadProto) element.removeAttribute('__proto__');",
    "  hadProto = proto;",
    "});",
    ...(context.usesAttributeBinding ? [
      `function ${context.bindingHelperName}(name: string, read: () => unknown, update: (value: any) => void) {`,
      "  return (element: Element) => {",
      "    $effect(() => {",
      "      const value = read();",
      "      if (value == null) element.removeAttribute(name);",
      "      else element.setAttribute(name, String(value));",
      "    });",
      "    const listener = () => update((element as Element & { value?: unknown }).value ?? element.getAttribute('value'));",
      "    element.addEventListener('input', listener);",
      "    return () => element.removeEventListener('input', listener);",
      "  };",
      "}",
    ] : []),
    ...(context.retentions.size === 0 ? [] : [
      "function retainedValue<T>(initial: T): (candidate: unknown) => T {",
      "  let previous = initial;",
      "  return (candidate: unknown) => {",
      "    if (candidate === Symbol.for('html-next.invalid-result')) return previous;",
      "    previous = candidate as T;",
      "    return previous;",
      "  };",
      "}",
      ...(Array.from(context.retentions.values()).some((entry) => entry.initial === undefined) ? [
        "function retainedStructuralValue<T>(): (candidate: T | symbol) => { ready: boolean; value: T } {",
        "  let ready = false;",
        "  let previous!: T;",
        "  return (candidate: T | symbol) => {",
        "    if (candidate !== Symbol.for('html-next.invalid-result')) { ready = true; previous = candidate as T; }",
        "    return { ready, value: previous };",
        "  };",
        "}",
      ] : []),
      ...[...context.retentions].filter(([site]) => !context.localRetentions.has(site))
        .map(([site, entry]) => `const retained${site} = ${entry.initial === undefined ? "retainedStructuralValue()" : `retainedValue(${entry.initial})`};`),
    ]),
    ...(hasProps ? [
      `const acceptedProps: Record<string, unknown> = { ${target.props.map((prop) => `${quote(prop.name)}: ${"default" in prop.contract ? JSON.stringify(prop.contract.default) : "null"}`).join(", ")} };`,
      "const inputAccepted: Record<string, boolean> = {};",
      "let checkedProps = $derived.by(() => ({",
      ...checkedPropSources,
      "}));",
      `const propValidityContract = ${JSON.stringify(validityContract)} as const;`,
      `let propInputValues = $derived({ ...checkedProps, ${target.props.map((prop) => `${quote(prop.name)}: ${selectors.includes(prop.name) ? `checkedProps[${quote(prop.name)}]` : inputSource(prop.name)}`).join(", ")} });`,
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
    ...data.map((declaration) => `const ${dataNames.get(declaration)!} = { pending: true, value: null, error: null, ok: false };`),
    ...computedSources,
    ...Array.from({ length: context.htmlSites }, (_, index) => index)
      .filter((site) => !context.localHtmlSites.has(site))
      .map((site) => `const htmlSite${site} = retainedSanitizedHtml(${context.styleOwner === undefined ? "" : quote(context.styleOwner)});`),
    ...(styles.stateNames.length === 0 ? [] : [
      HOST_STATE_TOKENS_SOURCE,
      `let hostState = $derived([${styles.stateNames.map((state) => `...hostStateTokens(${quote(state)}, ${code.get(state) ?? state})`).join(", ")}].join(" "));`,
    ]),
    ...handlerSources,
    ...lowering.fallbacks(),
  ].join("\n").replace(/<\/script/gi, "<\\/script") + "\n</script>";
  return { component: `${script}\n${markup}\n`, css, usesHtml: context.htmlSites > 0 };
}
