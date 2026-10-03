/** Svelte 5 output from the shared, checked component definition. */
import { fail } from "../diagnostics.js";
import { compileComponentStylesForSvelte, SVELTE_OWNER_ATTRIBUTE } from "../component-styles-build.js";
import { kebabCase, componentName } from "../names.js";
import { declarationTypeNode, normalizeType, parseTypedValue, parseTypeExpression } from "../type-system.js";
import { definitionMayInvokeComponents, elementMatchRoot, iteratedRefNames, rootArms } from "../template.js";
import { parseDuration } from "../duration.js";
import type { ComponentDefinition, ContextDeclaration, DataDeclaration, ElementNode, HandlerDeclaration, ReactiveDeclaration, SlotNode, SlotContract, TemplateNode } from "../template.js";
import type { PropContract } from "../types.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, isNativeBooleanAttribute, quote, svgAttributeName, selectorGenerics, dependentPropTypeSource, typeSource, SSR_BOOLEAN_PROPERTIES, SSR_STRING_PROPERTIES } from "./shared.js";
import { Lowering, mayProduceInvalidResult, present, type Scope, type Static, typeOf, typeScript } from "./vue-lowering.js";
import { declaredReferenceGuard, handlerDestinationCheck } from "./type-guards.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";

export interface SvelteConversionOptions {
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
  readonly propsSpecifier?: string;
  readonly htmlSpecifier?: string;
  readonly eventsSpecifier?: string;
  readonly controlSpecifier?: string;
  readonly dataSpecifier?: string;
  readonly guardNestedDepth?: boolean;
  readonly reactivitySpecifier?: string;
  readonly hostSpecifier?: string;
  readonly controllerSpecifier?: string;
  readonly propContractsByTag?: ReadonlyMap<string, Readonly<Record<string, PropContract>>>;
}

export interface SvelteConversionOutput {
  readonly component: string;
  readonly css: string;
  readonly usesHtml: boolean;
  readonly helpers: readonly ("props" | "html" | "events" | "control" | "data" | "reactivity" | "host" | "connection")[];
}

function nativeControlBinding(tag: string, name: string): boolean {
  return ["input", "textarea", "select"].includes(tag) &&
    (name === "value" || name === "checked" && tag === "input");
}

function checkSupported(definition: ComponentDefinition): void {
  for (const declaration of definition.declarations ?? []) {
    if (!["state", "computed", "handler", "data", "event", "method", "context"].includes(declaration.kind)) {
      fail("HT030", `Svelte conversion does not yet support ${declaration.kind} declarations.`);
    }
  }
  const visit = (node: TemplateNode): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") {
      for (const child of node.fallback ?? []) visit(child);
      return;
    }
    if (node.flow !== undefined && !["if", "with", "match", "when", "else", "each"].includes(node.flow.kind)) {
      fail("HT030", "Svelte conversion does not yet support structural flow, event modifiers, or references.");
    }
    for (const attribute of node.attributes) {
      if (attribute.kind === "attribute" && attribute.twoWay === true && (
          attribute.writablePath === undefined || typeof attribute.writablePath[0] !== "string"
        )) {
        fail("HT030", "Svelte conversion does not yet support property or two-way bindings on this element.");
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(definition.template);
}

interface RenderContext {
  readonly definition: ComponentDefinition;
  readonly imports: Set<string>;
  readonly handlerNames: ReadonlyMap<string, string>;
  readonly slotsByTag?: SvelteConversionOptions["slotsByTag"];
  usesScopedSlots: boolean;
  usesSampledSlots: boolean;
  readonly checkedSlotName: string;
  readonly propContractsByTag?: SvelteConversionOptions["propContractsByTag"];
  readonly styleOwner?: string;
  nextLoop: number;
  htmlSites: number;
  readonly localHtmlSites: Set<number>;
  readonly retentions: Map<number, { readonly initial?: string }>;
  readonly localRetentions: Set<number>;
  usesAttributeBinding: boolean;
  usesComponentBindings: boolean;
  usesProperties: boolean;
  usesComponentClasses: boolean;
  readonly componentClassName: string;
  readonly propertyAttachmentName: string;
  usesControls: boolean;
  usesNestedBindings: boolean;
  boundSelect: boolean;
  readonly controlAttachmentName: string;
  readonly bindingHelperName: string;
  readonly bindingValueName: string;
  readonly rootAttributeBindings: Set<string>;
  usesEvents: boolean;
  readonly refs: Set<string>;
  readonly refsName: string;
  readonly refAttachmentName: string;
  readonly refTargetName: string;
  readonly writePathName: string;
  readonly freshIdentifier: (base: string) => string;
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

function localOwnership(context: RenderContext, firstHtmlSite: number, firstRetention: number): string {
  const localHtml = Array.from({ length: context.htmlSites - firstHtmlSite }, (_, index) => firstHtmlSite + index)
    .filter((site) => !context.localHtmlSites.has(site));
  for (const site of localHtml) context.localHtmlSites.add(site);
  const localRetentions = [...context.retentions].filter(([site]) => site >= firstRetention && !context.localRetentions.has(site));
  for (const [site] of localRetentions) context.localRetentions.add(site);
  return [
    ...localHtml.map((site) => `{@const htmlSite${site} = retainedSanitizedHtml(${context.styleOwner === undefined ? "" : quote(context.styleOwner)})}`),
    ...localRetentions.map(([site, entry]) => `{@const retained${site} = ${entry.initial === undefined ? "retainedStructuralValue()" : `retainedValue(${entry.initial})`}}`),
  ].join("");
}

function renderEach(node: ElementNode | SlotNode, scope: Scope, lowering: Lowering, context: RenderContext): string {
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
  const declarations = localOwnership(context, firstHtmlSite, firstRetention);
  return `{#each ${rows} as ${row}${key}}${declarations}${markup}{/each}`;
}

function renderNode(node: TemplateNode, root: boolean, scope: Scope, lowering: Lowering,
  context: RenderContext): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    if (node.flow !== undefined) return renderEach(node, scope, lowering, context);
    const fallback = (node.fallback ?? []).map((child) => renderNode(child, false, scope, lowering, context)).join("");
    const sampledName = node.nameExpression === undefined ? undefined : context.freshIdentifier("htmlNextSlotName");
    if (sampledName !== undefined) context.usesSampledSlots = true;
    const name = sampledName ?? quote(node.name ?? "");
    const nameDeclaration = sampledName === undefined ? "" : `{@const ${sampledName} = untrack(() => String(${lowering.value(node.nameExpression!.ast, scope)}))}`;
    const selected = context.freshIdentifier("htmlNextSlot");
    const scoped = (node.props?.length ?? 0) > 0;
    if (scoped) context.usesScopedSlots = true;
    const defaultSlot = node.name === undefined && node.nameExpression === undefined;
    const supplied = defaultSlot ? `slots?.[""]${scoped ? " ?? (children === undefined ? undefined : null)" : ""}` : `slots?.[${name}]`;
    const checked = scoped ? `${context.checkedSlotName}(${supplied}, ${name})` : supplied;
    const values = scoped ? `{ ${node.props!.map((prop) => {
      const source = lowering.value(prop.expressionPlan.ast, scope);
      return `${quote(prop.name)}: ${mayProduceInvalidResult(prop.expressionPlan.ast, scope) ? retained(context, source, "undefined as unknown") : source}`;
    }).join(", ")} }` : "{}";
    const children = !scoped && defaultSlot ? "{:else if children}{@render children()}" : "";
    return `{#if true}${nameDeclaration}{@const ${selected} = ${checked}}{#if ${selected}}{@render ${selected}(${values})}${children}${fallback === "" ? "" : `{:else}${fallback}`}{/if}{/if}`;
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
    const alias = context.freshIdentifier("htmlNextAlias");
    const local: RootScope = {
      ...(scope as RootScope),
      code: new Map([...scope.code, [node.flow.alias, alias]]),
      types: new Map([...scope.types, [node.flow.alias, typeOf(value, scope)]]),
    };
    const source = lowering.value(value, scope);
    const markup = renderNode(body, root, local, lowering, context);
    if (!mayProduceInvalidResult(value, scope)) return `{#if true}{@const ${alias} = ${source}}${markup}{/if}`;
    const site = context.retentions.size;
    const result = `htmlNextStructural${site}`;
    const retainedSource = retainedStructural(context, source);
    return `{#if true}{@const ${result} = ${retainedSource}}{#if ${result}.ready}{@const ${alias} = ${result}.value}${markup}{/if}{/if}`;
  }
  if (node.flow?.kind === "match") {
    if (node.name !== "template") return renderNode(elementMatchRoot(node), root, scope, lowering, context);
    const flow = node.flow;
    const value = flow.expressionPlan?.ast;
    const alias = flow.alias === undefined ? undefined : context.freshIdentifier("htmlNextAlias");
    const local: RootScope = flow.alias === undefined ? scope as RootScope : {
      ...(scope as RootScope),
      code: new Map([...scope.code, [flow.alias, alias!]]),
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
    if (!mayProduceInvalidResult(value, scope)) return `{#if true}{@const ${alias} = ${source}}${block}{/if}`;
    const site = context.retentions.size;
    const result = `htmlNextStructural${site}`;
    const retainedSource = retainedStructural(context, source);
    return `{#if true}{@const ${result} = ${retainedSource}}{#if ${result}.ready}{@const ${alias} = ${result}.value}${block}{/if}{/if}`;
  }
  const contentDirective = node.attributes.find((attribute) => attribute.kind === "directive");
  let content: string | undefined;
  if (contentDirective?.kind === "directive" && contentDirective.expressionPlan !== undefined) {
    const plan = contentDirective.expressionPlan;
    const guard = declaredReferenceGuard(plan, scope, context.definition);
    const source = lowering.text(plan.ast, scope);
    const value = guard === undefined && !mayProduceInvalidResult(plan.ast, scope) ? source
      : retained(context, `(${guard === undefined ? "true" : guard}) ? ${source} : Symbol.for('html-next.invalid-result')`, "undefined as any");
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
  let snippetDeclarations = "";
  let componentChildren = node.children;
  const slotBindings: string[] = [];
  if (component) {
    const groups = new Map<string, TemplateNode[]>();
    const defaults: TemplateNode[] = [];
    for (const child of node.children) {
      const assigned = child.kind === "element" ? child.attributes.find((entry) => entry.kind === "literal" && entry.name === "slot") : undefined;
      if (assigned?.kind !== "literal") { defaults.push(child); continue; }
      const group = groups.get(assigned.value) ?? [];
      group.push(child); groups.set(assigned.value, group);
    }
    componentChildren = defaults;
    for (const [slot, children] of groups) {
      const contracts = context.slotsByTag?.get(node.name);
      const contract = contracts?.find((entry) => !entry.dynamic && entry.name === slot)
        ?? contracts?.find((entry) => entry.dynamic && (entry.props?.length ?? 0) > 0);
      const scoped = (contract?.props?.length ?? 0) > 0;
      const carrier = children.find((child): child is ElementNode => child.kind === "element" && child.name === "template");
      if (scoped && carrier === undefined) { slotBindings.push(`${quote(slot)}: null`); continue; }
      const alias = context.freshIdentifier("htmlNextSlotProps");
      const snippet = context.freshIdentifier("htmlNextProjection");
      const projectedScope: Scope = !scoped ? scope : {
        ...scope,
        code: new Map([...scope.code, ...contract!.props!.map((prop) => [prop, `${alias}[${quote(prop)}]`] as const)]),
        types: new Map<string, Static>([...scope.types, ...contract!.props!.map((prop) => [prop, { type: { kind: "terminal" as const, name: "unknown" }, nullable: true }] as const)]),
      };
      const firstHtml = context.htmlSites;
      const firstRetention = context.retentions.size;
      const markup = (scoped ? carrier!.children : children).map((child) => renderNode(child, false, projectedScope, lowering, context)).join("");
      const ownership = localOwnership(context, firstHtml, firstRetention);
      snippetDeclarations += `{#snippet ${snippet}(${alias}: Record<string, any>)}${ownership}${markup}{/snippet}`;
      slotBindings.push(`${quote(slot)}: ${snippet}`);
    }
  }
  const componentClasses = component ? node.attributes.filter((entry) => entry.kind === "attribute" && entry.target === "class") : [];
  if (componentClasses.length > 0) context.usesComponentClasses = true;
  const literals: string[] = [];
  const bindings: string[] = slotBindings.length === 0 ? [] : [`slots={{ ${slotBindings.join(", ")} }}`];
  const controlledNames = new Set(node.attributes.filter((attribute) => attribute.kind === "property" ||
    attribute.kind === "attribute" && attribute.twoWay)
    .map((attribute) => attribute.name));
  const authoredClass = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "class") : undefined;
  const authoredStyle = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "style") : undefined;
  const rootScope = root ? scope as RootScope : undefined;
  const reflectedNames = new Set(rootScope?.props.map((prop) => `data-${kebabCase(prop)}`) ?? []);
  const controlBinding = (attribute: Extract<ElementNode["attributes"][number], { kind: "attribute" | "property" }>): void => {
    context.usesControls = true;
    const value = lowering.value(attribute.expressionPlan!.ast, scope);
    const nativeProperty = attribute.kind === "property";
    const multiple = node.attributes.some((entry) => entry.name === "multiple" && entry.kind === "literal");
    const serialized = attribute.name === "checked" ? `Boolean(${value})`
      : node.name === "select" && multiple && !nativeProperty ? `(Array.isArray(${value}) ? ${value}.map(String) : [])`
      : nativeProperty && node.name === "select" ? `String(${value})` : `(${value} == null ? "" : String(${value}))`;
    if (node.name !== "textarea") bindings.push(`{...(typeof document === 'undefined' ? { ${quote(attribute.name)}: ${serialized} } : {})}`);
    else content = `{typeof document === 'undefined' ? ${serialized} : ${quote(node.children.filter((child) => child.kind === "text").map((child) => child.value).join(""))}}`;
    const literalValue = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "value");
    const defaults = attribute.name === "checked" ? `{ checked: ${node.attributes.some((entry) => entry.kind === "literal" && entry.name === "checked")} }`
      : `{ value: ${quote(literalValue?.kind === "literal" ? literalValue.value : node.name === "textarea" ? node.children.filter((child) => child.kind === "text").map((child) => child.value).join("") : "")} }`;
    if (node.name === "input") bindings.push(`{...(typeof document === 'undefined' ? {} : { ${attribute.name === "checked" ? "defaultChecked" : "defaultValue"}: (${defaults}).${attribute.name === "checked" ? "checked" : "value"} })}`);
    let update = "undefined";
    if (attribute.kind === "attribute" && attribute.twoWay) update = bindingWriter(attribute);
    bindings.push(`{@attach ${context.controlAttachmentName}(${quote(attribute.name)}, () => ${value}, ${defaults}, ${update}, ${nativeProperty})}`);
    if (root) context.rootAttributeBindings.add(attribute.name);
  };
  const bindingWriter = (attribute: Extract<ElementNode["attributes"][number], { kind: "attribute" }>): string => {
    const path = attribute.writablePath!;
    const destination = scope.code.get(path[0] as string)!;
    const value = context.bindingValueName;
    const check = handlerDestinationCheck(scope.types.get(path[0] as string)?.type, path, 1, value, scope, lowering);
    if (path.length > 1) context.usesNestedBindings = true;
    const write = path.length === 1 ? `${destination} = ${value} as typeof ${destination};`
      : `${context.writePathName}(${destination}, [${path.slice(1).map((segment) => typeof segment === "object" ? lowering.value(segment.expression, scope) : JSON.stringify(segment)).join(", ")}], ${value});`;
    return `(${value}: unknown) => { if (${value} !== Symbol.for('html-next.invalid-result')${check === undefined ? "" : ` && (${value} == null || ${check})`}) { ${write} } }`;
  };
  if (node.name === "option" && context.boundSelect) {
    const selected = node.attributes.some((entry) => entry.kind === "literal" && entry.name === "selected");
    bindings.push(`{...(typeof document === 'undefined' ? { "data-html-next-option-default": ${quote(String(selected))} } : {})}`);
  }
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      if (controlledNames.has(attribute.name) || componentClasses.length > 0 && attribute.name === "class") continue;
      if (root && (attribute.name === "class" || attribute.name === "style" || reflectedNames.has(attribute.name))) continue;
      if (node.name === "option" && context.boundSelect && attribute.name === "selected") {
        bindings.push(`{...(typeof document === 'undefined' ? {} : { selected: true })}`);
        continue;
      }
      const declared = childProp(attribute.name);
      if (declared === undefined) literals.push(!component && isNativeBooleanAttribute(attribute.name) ? attribute.name : `${attribute.name}=${quote(attribute.value)}`);
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
        if (component) {
          const declared = childProp(attribute.name);
          if (declared === undefined) fail("HT030", "Svelte conversion does not yet support two-way bindings to an undeclared component attribute.");
          if (declared[1].select !== undefined) fail("HT030", "Svelte conversion does not yet support two-way bindings to a selected component prop.");
          context.usesControls = true;
          context.usesComponentBindings = true;
          const guard = declaredReferenceGuard(attribute.expressionPlan, scope, context.definition);
          const source = lowering.value(attribute.expressionPlan.ast, scope);
          const candidate = context.freshIdentifier("htmlNextBindingValue");
          const value = retained(context, `(() => { if (!(${guard ?? "true"})) return Symbol.for('html-next.invalid-result'); const ${candidate}: unknown = ${source}; return acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(declared[1].type))}) ? ${candidate} : Symbol.for('html-next.invalid-result'); })()`, "undefined as any");
          bindings.push(`${declared[0]}={${value}}`);
          bindings.push(`{@attach (element: Element) => attachGenericBinding(element, ${bindingWriter(attribute)})}`);
        } else if (nativeControlBinding(node.name, attribute.name)) controlBinding(attribute);
        else {
          // Ordinary elements reflect the attribute, and feed their native value back on input.
          context.usesAttributeBinding = true;
          context.usesControls = true;
          const name = svgAttributeName(attribute.name);
          const value = lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name);
          // Svelte optimizes value= into a property write even on <output>. Keep the
          // server attribute declarative, and use only setAttribute/removeAttribute on the client.
          bindings.push(`{...(typeof document === 'undefined' ? { ${quote(name)}: ${value} } : {})}`);
          bindings.push(`{@attach ${context.bindingHelperName}(${quote(name)}, () => ${value}, ${bindingWriter(attribute)})}`);
          if (root) context.rootAttributeBindings.add(attribute.name);
        }
      }
      else if (attribute.target === "class" && component) continue;
      else if (attribute.target === "class") bindings.push(`class:${attribute.name}={${lowering.condition(attribute.expressionPlan.ast, scope)}}`);
      else if (attribute.target === "style") bindings.push(`style:${attribute.name}={${lowering.text(attribute.expressionPlan.ast, scope)}}`);
      else if (childProp(attribute.name) !== undefined) bindings.push(`${childProp(attribute.name)![0]}={${lowering.value(attribute.expressionPlan.ast, scope)}}`);
      else bindings.push(`${component ? attribute.name : svgAttributeName(attribute.name)}={${lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name)}}`);
    }
    if (attribute.kind === "property") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Expression \`${attribute.expression}\` could not be converted.`);
      if (nativeControlBinding(node.name, attribute.name)) controlBinding(attribute);
      else {
        const source = lowering.value(attribute.expressionPlan.ast, scope);
        if (attribute.name === "textContent") {
          const value = mayProduceInvalidResult(attribute.expressionPlan.ast, scope) ? retained(context, source, "undefined as unknown") : source;
          content = `{${value} == null ? "" : String(${value})}`;
        } else {
          context.usesProperties = true;
          bindings.push(`{@attach ${context.propertyAttachmentName}(${quote(attribute.name)}, () => ${source})}`);
          if (SSR_BOOLEAN_PROPERTIES.has(attribute.name) || SSR_STRING_PROPERTIES.has(attribute.name)) {
            const candidate = context.freshIdentifier("htmlNextPropertyValue");
            const serialized = SSR_BOOLEAN_PROPERTIES.has(attribute.name) ? `Boolean(${candidate})` : `String(${candidate})`;
            const rendered = mayProduceInvalidResult(attribute.expressionPlan.ast, scope)
              ? retained(context, `(() => { const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? ${candidate} : ${serialized}; })()`, SSR_BOOLEAN_PROPERTIES.has(attribute.name) ? "undefined as boolean | undefined" : "undefined as string | undefined")
              : SSR_BOOLEAN_PROPERTIES.has(attribute.name) ? `Boolean(${source})` : `String(${source})`;
            bindings.push(`{...(typeof document === 'undefined' ? { ${quote(attribute.name.toLowerCase())}: ${rendered} } : {})}`);
          }
        }
        if (root) { context.rootAttributeBindings.add(attribute.name); context.rootAttributeBindings.add(attribute.name.toLowerCase()); }
      }
    }
  }
  const attributes = [...literals];
  if (root) {
    attributes.push("{...rootAttrs}");
    attributes.push(rootScope!.preservesRootFocus
      ? "{@attach (element: Element) => { rootElement = element; if (rootFocusPending) { (element as HTMLElement).focus({ preventScroll: true }); rootFocusPending = false; } return () => { rootFocusPending ||= element.ownerDocument.activeElement === element; if (rootElement === element) rootElement = undefined; }; }}"
      : component
      ? "{@attach (element: Element) => { rootElement = element; return () => { if (rootElement === element) rootElement = undefined; }; }}"
      : "bind:this={rootElement}");
    if (authoredClass?.kind === "literal" && componentClasses.length === 0) {
      attributes.push(`class={[${quote(authoredClass.value)}, rest.class].filter(Boolean).join(" ")}`);
    }
    if (authoredStyle?.kind === "literal") {
      attributes.push(`style={[${quote(authoredStyle.value)}, rest.style].filter(Boolean).join("; ")}`);
    }
    attributes.push(`data-component={[rest["data-component"], ${quote((scope as RootScope).tag)}].filter(Boolean).join(" ")}`);
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
  if (componentClasses.length > 0) {
    const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "class");
    const base = `[${literal?.kind === "literal" ? quote(literal.value) : quote("")}${root ? ", rest.class" : ""}].filter(Boolean).join(" ")`;
    const values = componentClasses.map((entry) => {
      if (entry.kind !== "attribute" || entry.expressionPlan === undefined) fail("HT030", "An uncompiled class binding cannot be converted.");
      const expression = entry.expressionPlan.ast;
      const condition = lowering.condition(expression, scope);
      return `${quote(entry.name)}: ${mayProduceInvalidResult(expression, scope) ? retained(context, condition, "undefined as boolean | undefined") : condition}`;
    }).join(", ");
    attributes.push(`class={${context.componentClassName}(${base}, { ${values} })}`);
  }
  attributes.push(...bindings);
  if (!component && context.styleOwner !== undefined) attributes.push(`${SVELTE_OWNER_ATTRIBUTE}=${quote(context.styleOwner)}`);
  if (node.ref !== undefined) {
    context.refs.add(node.ref);
    attributes.push(`{@attach ${context.refAttachmentName}(${quote(node.ref)})}`);
  }
  const nativeEvents = (node.events ?? []).filter((event) => component || event.modifiers.length > 0);
  for (const event of node.events ?? []) {
    if (!nativeEvents.includes(event)) attributes.push(`on${event.name}={${context.handlerNames.get(event.handler) ?? event.handler}}`);
  }
  if (nativeEvents.length > 0) {
    context.usesEvents = true;
    attributes.push(`{@attach (element: Element) => attachNativeEvents(element, [${nativeEvents.map((event) =>
      `{ type: ${quote(event.name)}, modifiers: ${JSON.stringify(event.modifiers)}, handler: ${context.handlerNames.get(event.handler) ?? event.handler} }`).join(", ")}])}`);
  }
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const previousBoundSelect = context.boundSelect;
  if (node.name === "select") context.boundSelect = context.usesControls && node.attributes.some((entry) => entry.name === "value" && (entry.kind === "property" || entry.kind === "attribute" && entry.twoWay));
  const children = content ?? componentChildren.map((child) => renderNode(child, false, scope, lowering, context)).join("");
  context.boundSelect = previousBoundSelect;
  const markup = `${open}${children}</${name}>`;
  return snippetDeclarations === "" ? markup : `{#if true}${snippetDeclarations}${markup}{/if}`;
}

interface RootScope extends Scope {
  readonly tag: string;
  readonly props: readonly string[];
  readonly propContracts: Readonly<Record<string, PropContract>>;
  readonly stateNames: readonly string[];
  readonly preservesRootFocus: boolean;
}

export function generateSvelteOutput(definition: ComponentDefinition, options: SvelteConversionOptions = {}): SvelteConversionOutput {
  checkSupported(definition);
  const target = targetComponent(definition);
  const usesController = definition.controller !== undefined;
  const styles = compileComponentStylesForSvelte(definition.css, definition);
  const css = styles.css;
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const data = declarations.filter((declaration): declaration is DataDeclaration => declaration.kind === "data");
  const contexts = declarations.filter((declaration): declaration is ContextDeclaration => declaration.kind === "context");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const code = new Map(target.props.map((prop) => [prop.name, `checkedProps.${prop.name}`]));
  const types = new Map<string, Static>(target.props.map((prop) => [prop.name, { type: normalizeType(prop.contract.type), nullable: true }]));
  const expressionScope: Scope = { code, types };
  const dataNames = new Map<DataDeclaration, string>();
  const dataTypes = new Map<DataDeclaration, string>();
  const taken = new Set([...code.keys(), ...declarations.map((declaration) => declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name)]);
  const freshIdentifier = (base: string): string => {
    let name = base;
    let suffix = 2;
    while (taken.has(name)) name = `${base}${suffix++}`;
    taken.add(name);
    return name;
  };
  const reserved = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval "
    + "acceptsBindingDestination Props Snippet untrack useComponentHost SvelteMap SvelteSet propValidityState getContext setContext rootElement rootFocusPending specialElement hadConstructor hadProto event children slots rest rootAttrs checkedProps acceptedProps inputAccepted propValidityContract propInputValues hostState hostStateTokens checkedProp selectedPropNode mountPropValidity updatePropValidity attachGenericBinding attachBoundControl syncBoundControl controlDefaults observeBoundOptions BoundDefaults attachNativeEvents dispatchDeclared retainedSanitizedHtml useDataRead cycleCheckedComputed retainedValue retainedStructuralValue truthy text attribute math arithmetic concat join sortBy eachRows uniqueKeys").split(" "));
  for (const prop of target.props) reserved.add(`input${prop.name}`);
  const declarationName = (name: string): string => reserved.has(name) || name.startsWith("$") || /^retained\d+$|^htmlSite\d+$|^htmlNextRow\d+$|^htmlNextStructural\d+$/.test(name) ? freshIdentifier("htmlNextValue") : name;
  const contextNames = new Map<ContextDeclaration, string>();
  for (const declaration of contexts) {
    const alias = declaration.as ?? declaration.name;
    const variable = freshIdentifier("htmlNextContext");
    contextNames.set(declaration, variable);
    code.set(alias, `${variable}.value`);
    types.set(alias, { type: { kind: "terminal", name: "unknown" }, nullable: true });
  }
  const handlerNames = new Map(handlers.map((handler) => [handler.name, declarationName(handler.name)]));
  for (const declaration of data) {
    const name = freshIdentifier(`htmlNextData${dataNames.size}`);
    dataNames.set(declaration, name);
    code.set(declaration.name, name);
    const payload = declaration.type === undefined ? { kind: "terminal", name: "unknown" } as const
      : declaration.type === "text" ? { kind: "terminal", name: "string" } as const : parseTypeExpression(declaration.type);
    dataTypes.set(declaration, typeSource(payload));
    types.set(declaration.name, { type: { kind: "object", open: false, fields: [
      { name: "pending", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "value", type: { kind: "union", members: [payload, { kind: "terminal", name: "null" }] }, optional: false },
      { name: "error", type: { kind: "terminal", name: "unknown" }, optional: false },
      { name: "ok", type: { kind: "terminal", name: "boolean" }, optional: false },
    ] }, nullable: false });
  }
  const computedNames = new Map<ReactiveDeclaration, string>();
  for (const declaration of [...states, ...computed]) {
    const name = declarationName(declaration.name);
    if (declaration.kind === "computed") computedNames.set(declaration, name);
    code.set(declaration.name, declaration.kind === "computed" ? `${name}.get()` : name);
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
    preservesRootFocus: rootArms(definition.template) !== undefined,
    code,
    types,
  };
  const lowering = new Lowering();
  const context: RenderContext = { definition, handlerNames, imports: new Set(), slotsByTag: options.slotsByTag, usesScopedSlots: false, usesSampledSlots: false, checkedSlotName: freshIdentifier("htmlNextCheckedSlot"), propContractsByTag: options.propContractsByTag,
    ...(css !== "" && (definition.slots?.length ?? 0) > 0 ? { styleOwner: definition.contract.tag } : {}),
    nextLoop: 0, htmlSites: 0, localHtmlSites: new Set(), retentions: new Map(), localRetentions: new Set(),
    usesAttributeBinding: false, usesComponentBindings: false, usesProperties: false, usesComponentClasses: false, componentClassName: freshIdentifier("htmlNextClasses"), propertyAttachmentName: freshIdentifier("htmlNextProperty"), usesControls: false, usesNestedBindings: false, boundSelect: false, controlAttachmentName: freshIdentifier("htmlNextControl"), bindingHelperName: freshIdentifier("boundAttribute"),
    bindingValueName: freshIdentifier("boundValue"), rootAttributeBindings: new Set(),
    usesEvents: target.events.length > 0, refs: new Set(), refsName: freshIdentifier("htmlNextRefs"),
    refAttachmentName: freshIdentifier("htmlNextRef"), refTargetName: freshIdentifier("htmlNextRefTarget"),
    writePathName: freshIdentifier("htmlNextWritePath"), freshIdentifier };
  const controllerHostName = freshIdentifier("htmlNextHost");
  const controllerRefsName = freshIdentifier("htmlNextControllerRefs");
  const iteratedRefs = iteratedRefNames(definition);
  const methodNames = new Map(target.methods.map((method) => [method.name, freshIdentifier("htmlNextMethod")]));
  const nestedDepthLimit = options.guardNestedDepth ? definitionMayInvokeComponents(definition) ? 32 : 33 : undefined;
  const nestedDepthName = freshIdentifier("htmlNextDepth");
  const markup = renderNode(definition.template, true, scope, lowering, context);
  const generics = selectorGenerics(definition.contract.props);
  const genericParameters = new Map(generics.map(({ from, parameter }) => [from, parameter]));
  const dependentParameters = new Map(generics.map(({ from, parameter }) => [from, `NoInfer<${parameter}>`]));
  const propTypes = target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${genericParameters.get(prop.name) ?? dependentPropTypeSource(prop.contract, dependentParameters)};`).join("\n  ");
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
      : definition.contract.props[select.from] !== undefined ? `selectedPropNode(${inputSource(select.from)}, ${JSON.stringify(select.options)})`
      : `selectedPropNode(${code.get(select.from)}, ${JSON.stringify(select.options)})`;
    const source = inputSource(prop.name);
    return `    ${quote(prop.name)}: checkedProp<${typeSource(prop.contract.type)}>(${source}, ${type}, ${prop.contract.required}, ${quote(prop.name)}, acceptedProps, inputAccepted, false),`;
  });
  const stateSources = states.map((state) =>
    `let ${code.get(state.name)!} = $state(${state.expression === undefined ? "undefined" : lowering.value(state.expression.ast, scope)});`);
  const computedSources = computed.map((value) => {
    const expression = value.expression?.ast;
    const source = expression === undefined ? "undefined" : lowering.value(expression, scope);
    const type = typeScript(scope.types.get(value.name)!);
    return `const ${computedNames.get(value)!}: { get(): ${type} } = cycleCheckedComputed<${type}>(() => (${expression !== undefined && mayProduceInvalidResult(expression, scope)
      ? retained(context, source, "undefined as any") : source}) as ${type});`;
  });
  const handlerSources = handlers.map((handler) => `function ${handlerNames.get(handler.name)!}(): void {\n${handler.steps.map((step, index) => {
    const handlerScope = scope;
    const guard = step.guard === undefined ? "" : `if ((${lowering.value(step.guard.ast, handlerScope)} as unknown) !== Symbol.for('html-next.invalid-result') && ${lowering.condition(step.guard.ast, handlerScope)}) `;
    if (step.kind === "dispatch") {
      const declaration = target.events.find((event) => event.name === step.event);
      if (declaration === undefined) fail("HT034", `Handler \`${handler.name}\` dispatches undeclared event \`${step.event}\`.`);
      const detail = context.freshIdentifier(`htmlNextDetail${index}`);
      const source = step.value === undefined ? "undefined" : lowering.value(step.value.ast, handlerScope);
      return `  ${guard}{ const ${detail}: unknown = ${source}; if (${detail} !== Symbol.for('html-next.invalid-result')) dispatchDeclared(rootElement ?? null, ${quote(step.event)}, ${detail}, ${JSON.stringify(declarationTypeNode(declaration.type, declaration.shape))}, ${JSON.stringify({ bubbles: declaration.bubbles, composed: declaration.composed, cancelable: declaration.cancelable })}); }`;
    }
    if (step.kind === "focus" || step.kind === "validate") {
      context.refs.add(step.target);
      const action = step.kind === "focus" ? "focus" : "reportValidity";
      return `  ${guard}(${context.refTargetName}(${quote(step.target)}) as HTMLElement & { reportValidity?: () => boolean } | undefined)?.${action}?.();`;
    }
    if (step.kind !== "set") fail("HT030", `Svelte conversion of handler step in \`${handler.name}\` is not implemented.`);
    const state = states.find((entry) => entry.name === step.writablePath[0]);
    if (state === undefined) fail("HT031", `\`${step.path}\` is not a writable state path.`);
    const next = context.freshIdentifier(`htmlNextCandidate${index}`);
    const check = handlerDestinationCheck(scope.types.get(state.name)?.type, step.writablePath, 1, next, handlerScope, lowering);
    const destination = scope.code.get(state.name)!;
    const write = step.writablePath.length === 1 ? `${destination} = ${next} as typeof ${destination};`
      : `${context.writePathName}(${destination}, [${step.writablePath.slice(1).map((segment) => typeof segment === "object"
        ? lowering.value(segment.expression, handlerScope) : JSON.stringify(segment)).join(", ")}], ${next});`;
    return `  ${guard}{ const ${next}: unknown = ${lowering.value(step.value.ast, handlerScope)}; if (${next} !== Symbol.for('html-next.invalid-result')${check === undefined ? "" : ` && (${next} == null || ${check})`}) { ${write} } }`;
  }).join("\n")}\n}`);
  const usesNestedWrites = context.usesNestedBindings || handlers.some((handler) => handler.steps.some((step) => step.kind === "set" && step.writablePath.length > 1));
  const focusReads: string[] = [];
  if (scope.preservesRootFocus) {
    const match = definition.template.flow;
    const focusCode = new Map(scope.code);
    const focusTypes = new Map(scope.types);
    const focusScope: Scope = { code: focusCode, types: focusTypes };
    if (match?.kind === "match" && match.expressionPlan !== undefined) {
      const expression = lowering.value(match.expressionPlan.ast, scope);
      focusReads.push(`  void (${expression});`);
      if (match.alias !== undefined) {
        focusCode.set(match.alias, `(${expression})`);
        focusTypes.set(match.alias, typeOf(match.expressionPlan.ast, scope));
      }
    }
    const conditions: string[] = [];
    for (const arm of rootArms(definition.template)!) {
      if (arm.flow?.kind === "when" && arm.flow.testPlan !== undefined) {
        conditions.push(`(${lowering.condition(arm.flow.testPlan.ast, focusScope)})`);
      }
    }
    if (conditions.length > 0) focusReads.push(`  void (${conditions.join(" || ")});`);
  }
  const script = [
    `<script lang="ts"${generics.length === 0 ? "" : ` generics=${quote(generics.map(({ declaration }) => declaration.replaceAll('"', "'")).join(", "))}`}>`,
    'import type { Snippet } from "svelte";',
    ...(nestedDepthLimit !== undefined || states.length > 0 || contexts.length > 0 ? ['import { getContext, setContext } from "svelte";'] : []),
    ...(hasProps || context.usesControls || context.usesSampledSlots || scope.preservesRootFocus ? ['import { untrack } from "svelte";'] : []),
    ...(usesController ? [`import { useComponentHost } from ${quote(options.hostSpecifier ?? "./host.svelte")};`] : []),
    ...(computed.length > 0 ? [`import { cycleCheckedComputed } from ${quote(options.reactivitySpecifier ?? "./reactivity.svelte")};`] : []),
    ...(data.some((declaration) => declaration.source !== undefined) ? [`import { useDataRead } from ${quote(options.dataSpecifier ?? "./data.svelte")};`] : []),
    ...(context.usesControls ? [`import { attachGenericBinding, attachBoundControl, syncBoundControl, controlDefaults, observeBoundOptions, type BoundDefaults } from ${quote(options.controlSpecifier ?? "./control")};`] : []),
    ...(context.usesEvents ? [`import { attachNativeEvents${target.events.length === 0 ? "" : ", dispatchDeclared"} } from ${quote(options.eventsSpecifier ?? "./events")};`] : []),
    ...(context.htmlSites === 0 ? [] : [`import { retainedSanitizedHtml } from ${quote(options.htmlSpecifier ?? "./html")};`]),
    ...(context.usesComponentBindings ? [`import { acceptsBindingDestination } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...(hasProps ? [`import { checkedProp, mountPropValidity, updatePropValidity${usesController ? ", propValidityState" : ""}${selectors.length === 0 ? "" : ", selectedPropNode"} } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.svelte`)};`),
    ...(css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${definition.contract.name}.css`)};`]),
    ...(nestedDepthLimit === undefined ? [] : [
      `const ${nestedDepthName} = getContext<number>("html-next:nested-depth") ?? 0;`,
      `if (${nestedDepthName} >= ${nestedDepthLimit}) {`,
      "  const message = 'Component invocations nested deeper than the lowering limit.';",
      "  throw Object.assign(new Error('HR008: ' + message), { name: 'HtmlDiagnosticError', diagnostic: Object.freeze({ code: 'HR008', message }) });",
      "}",
      `setContext("html-next:nested-depth", ${nestedDepthName} + 1);`,
    ]),
    `type Props = { ${propTypes} children?: Snippet; slots?: Record<string, Snippet<[Record<string, any>]> | null>; [key: string]: unknown; };`,
    `let { ${destructured}${destructured === "" ? "" : ", "}children, slots, ...rest }: Props = $props();`,
    // Svelte's spread path normalizes these names through an inherited object property.
    // Keep ordinary passthrough attrs native to Svelte; write only these names with the DOM API.
    `const rootAttrs = $derived.by(() => { const attrs = { ...rest }; ${[...context.rootAttributeBindings].map((name) => `delete attrs[${quote(name)}];`).join(" ")} if (typeof document !== 'undefined') { Reflect.deleteProperty(attrs, 'constructor'); Reflect.deleteProperty(attrs, '__proto__'); } return attrs; });`,
    "let rootElement = $state<Element | undefined>(undefined);",
    ...(scope.preservesRootFocus ? ["let rootFocusPending = false;"] : []),
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
    ...(context.usesControls ? [
      `function ${context.controlAttachmentName}(name: "value" | "checked", read: () => unknown, defaults: BoundDefaults, update?: (value: unknown) => void, nativeProperty = false) {`,
      "  return (element: Element) => {",
      "    const authored = controlDefaults(element, defaults);",
      "    const initial = untrack(read);",
      "    const dispose = attachBoundControl(element, name, initial, authored, update, nativeProperty, initial !== Symbol.for('html-next.invalid-result'));",
      "    $effect(() => { const value = read(); syncBoundControl(element, name, value, authored, nativeProperty, value !== Symbol.for('html-next.invalid-result')); });",
      "    const stop = observeBoundOptions(element, () => { const value = untrack(read); syncBoundControl(element, name, value, controlDefaults(element, defaults), nativeProperty, value !== Symbol.for('html-next.invalid-result'), true); });",
      "    return () => { dispose?.(); stop(); };",
      "  };",
      "}",
    ] : []),
    ...(context.usesComponentClasses ? [
      `function ${context.componentClassName}(base: string, values: Record<string, boolean | undefined>): string {`,
      String.raw`  const tokens = new Set(base.split(/[ \t\r\n\f]+/).filter(Boolean));`,
      "  for (const [name, enabled] of Object.entries(values)) { if (enabled === undefined) continue; if (enabled) tokens.add(name); else tokens.delete(name); }",
      "  return [...tokens].join(' ');",
      "}",
    ] : []),
    ...(context.usesScopedSlots ? [
      `function ${context.checkedSlotName}(slot: Snippet<[Record<string, any>]> | null | undefined, name: string) {`,
      "  if (slot === null) {",
      `    const message = 'Scoped slot \u0060' + name + '\u0060 requires a consumer <template slot="' + name + '">.';`,
      "    throw Object.assign(new Error('HR007: ' + message), { name: 'HtmlDiagnosticError', diagnostic: Object.freeze({ code: 'HR007', message }) });",
      "  }",
      "  return slot;",
      "}",
    ] : []),
    ...(context.usesProperties ? [
      `function ${context.propertyAttachmentName}(name: string, read: () => unknown) {`,
      "  return (element: Element) => {",
      "    let initialized = false;",
      "    $effect(() => {",
      "      const value = read();",
      "      if (value === Symbol.for('html-next.invalid-result')) return;",
      "      // Native scroll setters run while live roots are detached and have no initial layout effect.",
      "      const first = !initialized; initialized = true;",
      "      if (first && (name === 'scrollTop' || name === 'scrollLeft')) return;",
      "      Reflect.set(element, name, value);",
      "    });",
      "  };",
      "}",
    ] : []),
    ...(context.usesAttributeBinding ? [
      `function ${context.bindingHelperName}(name: string, read: () => unknown, update: (value: any) => void) {`,
      "  return (element: Element) => {",
      "    $effect(() => {",
      "      const value = read();",
      "      if (value === Symbol.for('html-next.invalid-result')) return;",
      "      if (value == null) element.removeAttribute(name);",
      "      else element.setAttribute(name, String(value));",
      "    });",
      "    return attachGenericBinding(element, update);",
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
      `let propInputValues = $derived.by(() => ({ ...checkedProps, ${target.props.map((prop) => `${quote(prop.name)}: ${selectors.includes(prop.name) ? `checkedProps[${quote(prop.name)}]` : inputSource(prop.name)}`).join(", ")}${selectors.filter((name) => definition.contract.props[name] === undefined).map((name) => `, ${quote(name)}: ${code.get(name)}`).join("")} }));`,
      "$effect(() => {",
      "  const element = rootElement;",
      "  if (element === undefined) return;",
      "  return mountPropValidity(element, { contract: propValidityContract, values: untrack(() => propInputValues) });",
      "});",
      "$effect(() => {",
      "  if (rootElement !== undefined) updatePropValidity(rootElement, { contract: propValidityContract, values: propInputValues });",
      "});",
    ] : []),
    ...contexts.flatMap((declaration) => {
      const variable = contextNames.get(declaration)!;
      const key = `html-next:context:${declaration.from}\u0000${declaration.name}`;
      const message = `<${definition.contract.tag}> requires context \`${declaration.name}\` from <${declaration.from}>.`;
      return [
        `const ${variable} = getContext<{ readonly value: unknown }>(${quote(key)});`,
        `if (${variable} === undefined) throw Object.assign(new Error(${quote(`HR009: ${message}`)}), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR009", message: ${quote(message)} }) });`,
      ];
    }),
    ...stateSources,
    ...states.map((state) => `setContext(${quote(`html-next:context:${definition.contract.tag}\u0000${state.name}`)}, { get value() { return ${code.get(state.name)}; } });`),
    ...data.map((declaration) => {
      if (declaration.source === undefined) return `const ${dataNames.get(declaration)!} = { pending: true, value: null, error: null, ok: false };`;
      const parameters = declaration.parameters.map((parameter) => `${quote(parameter.name)}: ${lowering.value(parameter.expression.ast, scope)}`).join(", ");
      const sources = declaration.parameters.filter((parameter) => parameter.mode === "from").map((parameter) => lowering.value(parameter.expression.ast, scope)).join(", ");
      return `const ${dataNames.get(declaration)!} = useDataRead<${dataTypes.get(declaration)!}>({ root: () => rootElement ?? null, source: ${quote(declaration.source)}, definition: ${quote(definition.source.file)}, ${declaration.type === undefined ? "" : `type: ${quote(declaration.type)}, `}${declaration.debounce === undefined ? "" : `debounce: ${parseDuration(declaration.debounce)}, `}${declaration.poll === undefined ? "" : `poll: ${parseDuration(declaration.poll)}, `}sources: () => [${sources}], parameters: () => ({ ${parameters} }) });`;
    }),
    ...computedSources,
    ...(scope.preservesRootFocus ? [
      "$effect.pre(() => {",
      ...focusReads,
      "  untrack(() => { rootFocusPending = rootElement !== undefined && rootElement.ownerDocument.activeElement === rootElement; });",
      "});",
    ] : []),
    ...Array.from({ length: context.htmlSites }, (_, index) => index)
      .filter((site) => !context.localHtmlSites.has(site))
      .map((site) => `const htmlSite${site} = retainedSanitizedHtml(${context.styleOwner === undefined ? "" : quote(context.styleOwner)});`),
    ...(styles.stateNames.length === 0 ? [] : [
      HOST_STATE_TOKENS_SOURCE,
      `let hostState = $derived([${styles.stateNames.map((state) => `...hostStateTokens(${quote(state)}, ${code.get(state) ?? state})`).join(", ")}].join(" "));`,
    ]),
    ...(context.refs.size === 0 && !usesController ? [] : [
      `const ${context.refsName} = new Map<string, Set<Element>>();`,
      ...(usesController ? [`const ${controllerRefsName} = new Map<string, Element | Element[]>();`] : []),
      `function ${context.refAttachmentName}(name: string) {`,
      "  return (element: Element) => {",
      `    const elements = ${context.refsName}.get(name) ?? new Set<Element>();`,
      `    ${context.refsName}.set(name, elements); elements.add(element);`,
      ...(usesController && iteratedRefs.size > 0 ? [
        `    if (${JSON.stringify([...iteratedRefs])}.includes(name)) {`,
        `      const recorded = ${controllerRefsName}.get(name) as Element[] | undefined;`,
        `      if (recorded === undefined) ${controllerRefsName}.set(name, [element]);`,
        "      else recorded.push(element);",
        `    } else ${controllerRefsName}.set(name, element);`,
      ] : usesController ? [`    ${controllerRefsName}.set(name, element);`] : []),
      "    return () => { elements.delete(element); };",
      "  };",
      "}",
      `function ${context.refTargetName}(name: string): Element | undefined {`,
      `  return [...(${context.refsName}.get(name) ?? [])].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1)[0];`,
      "}",
    ]),
    ...(usesNestedWrites ? [
      `function ${context.writePathName}(root: unknown, path: readonly unknown[], value: unknown): void {`,
      "  let target = root;",
      "  for (const [index, key] of path.entries()) {",
      "    if (typeof key !== 'string' && typeof key !== 'number' || target === null || typeof target !== 'object') return;",
      "    if (index === path.length - 1) (target as Record<string | number, unknown>)[key] = value;",
      "    else target = (target as Record<string | number, unknown>)[key];",
      "  }",
      "}",
    ] : []),
    ...(usesController ? [
      `const ${controllerHostName} = useComponentHost(() => import(${quote(definition.controller!)}), {`,
      "  root: () => rootElement ?? null,",
      `  definition: ${quote(definition.source.file)}, tag: ${quote(definition.contract.tag)}, controller: ${quote(options.controllerSpecifier ?? definition.controller!)},`,
      `  props: () => ${hasProps ? "checkedProps" : "({})"}, propNames: ${JSON.stringify(target.props.map((prop) => prop.name))},`,
      ...(hasProps ? [
        `  propInputs: (name: string) => ({ ${target.props.map((prop) => `${quote(prop.name)}: input${prop.name} ?? null`).join(", ")} } as Record<string, unknown>)[name],`,
        "  propValidity: (name: string) => propValidityState({ contract: propValidityContract, values: propInputValues }, name),",
      ] : []),
      `  state: { ${states.map((state) => `${quote(state.name)}: { get: () => ${code.get(state.name)}, set: (value: unknown) => { ${code.get(state.name)} = value as typeof ${code.get(state.name)}; } }`).join(", ")} },`,
      `  computed: { ${[...computed, ...data, ...contexts].map((value) => { const name = value.kind === "context" ? value.as ?? value.name : value.name; return `${quote(name)}: () => ${code.get(name)}`; }).join(", ")} },`,
      `  refs: ${controllerRefsName},`,
      `  dispatch: (root: Element, name: string, detail?: unknown) => { switch (name) { ${target.events.map((event) => `case ${quote(event.name)}: return dispatchDeclared(root, name, detail, ${JSON.stringify(declarationTypeNode(event.type, event.shape))}, ${JSON.stringify({ bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable })});`).join(" ")} default: return root.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false })); } },`,
      `  methods: ${JSON.stringify(target.methods.map((method) => ({ name: method.name, exportName: method.exportName })))},`,
      "});",
    ] : []),
    ...target.methods.map((method) => {
      const alias = methodNames.get(method.name)!;
      const result = usesController ? `${controllerHostName}.invoke(${quote(method.name)}, ...args)`
        : `Promise.reject(new TypeError(${quote(`Controller method \`${method.name}\` is not ready for <${definition.contract.tag}>.`)}))`;
      return `const ${alias} = (...args: unknown[]): Promise<Awaited<${method.returnType}>> => ${result} as Promise<Awaited<${method.returnType}>>;\nexport { ${alias} as ${method.name} };`;
    }),
    ...(!usesController && target.methods.length > 0 ? [
      "$effect(() => {",
      "  const element = rootElement; if (element === undefined) return;",
      ...target.methods.map((method) => `  Object.defineProperty(element, ${quote(method.name)}, { configurable: true, enumerable: false, value: ${methodNames.get(method.name)} });`),
      "});",
    ] : []),
    ...handlerSources,
    ...lowering.fallbacks(),
  ].join("\n").replace(/<\/script/gi, "<\\/script") + "\n</script>";
  return { component: `${script}\n${markup}\n`, css, usesHtml: context.htmlSites > 0,
    helpers: [
      ...(hasProps || context.usesComponentBindings || target.events.length > 0 ? ["props" as const] : []),
      ...(context.htmlSites > 0 ? ["html" as const] : []),
      ...(context.usesEvents ? ["events" as const] : []),
      ...(context.usesControls ? ["control" as const] : []),
      ...(data.some((declaration) => declaration.source !== undefined) ? ["data" as const] : []),
      ...(usesController ? ["host" as const] : []),
      ...(usesController || data.some((declaration) => declaration.source !== undefined) ? ["connection" as const] : []),
      ...(computed.length > 0 || usesController ? ["reactivity" as const] : []),
    ] };
}
