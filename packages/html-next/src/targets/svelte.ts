/** Svelte 5 output from the shared, checked component definition. */
import { fail } from "../diagnostics.js";
import type { CompiledExpression } from "../expression.js";
import { compileComponentStylesForSvelte, SVELTE_OWNER_ATTRIBUTE } from "../component-styles-build.js";
import { kebabCase, componentName } from "../names.js";
import { declarationTypeNode, normalizeType, parseTypedValue, parseTypeExpression, type TypeNode } from "../type-system.js";
import { definitionMayInvokeComponents, elementMatchRoot, iteratedRefNames, rootArms } from "../template.js";
import { parseDuration } from "../duration.js";
import { getDomInterface } from "../platform.js";
import type { ComponentDefinition, ContextDeclaration, DataDeclaration, ElementNode, HandlerDeclaration, ReactiveDeclaration, SlotNode, SlotContract, TemplateNode } from "../template.js";
import type { PropContract } from "../types.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, literalAttribute, isScriptIdentifier, isVoidElement, isNativeBooleanAttribute, quote, svgAttributeName, selectorGenerics, dependentPropTypeSource, typeSource, SSR_BOOLEAN_PROPERTIES, SSR_STRING_PROPERTIES } from "./shared.js";
import { Lowering, category, mayProduceInvalidResult, present, type Scope, type Static, typeOf, typeScript } from "./vue-lowering.js";
import { declaredReferenceGuard, handlerDestinationCheck } from "./type-guards.js";
import { CONTROL_CAPTURE_CONTEXT } from "./svelte-control.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";

function hasStructuredHtmlInput(type: TypeNode): boolean {
  if (type.kind === "constrained") return hasStructuredHtmlInput(type.base);
  if (type.kind === "union") return type.members.some(hasStructuredHtmlInput);
  return type.kind === "list" || type.kind === "record" || type.kind === "object";
}

function unknownValueScope(name: string): Scope {
  return { code: new Map([[name, name]]), types: new Map([[name, { type: { kind: "terminal", name: "unknown" }, nullable: true }]]) };
}

// A NUL cannot appear in an authored HTML attribute or a declared public prop name.
const SLOTS_PROP = "\0html-next:slots";
const ROOT_OWNER_PROP = "\0html-next:root-owner";
const DECORATIONS_PROP = "\0html-next:decorations";
const BINDING_INPUTS_PROP = "\0html-next:binding-inputs";
const LITERAL_INPUTS_PROP = "\0html-next:literal-inputs";
const NATIVE_BINDINGS_PROP = "\0html-next:native-bindings";

export interface SvelteConversionOptions {
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
  readonly rootBindings?: readonly string[] | undefined;
  readonly rootDecorations?: { readonly classes: boolean; readonly styles: boolean } | undefined;
  readonly decorationsSpecifier?: string;
  readonly styleSpecifier?: string;
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
  readonly helpers: readonly ("props" | "html" | "events" | "control" | "data" | "reactivity" | "host" | "connection" | "decorations" | "style")[];
}

function nativeControlBinding(tag: string, name: string): boolean {
  return ["input", "textarea", "select"].includes(tag) &&
    (name === "value" || name === "checked" && tag === "input");
}

/** Object literal __proto__ keys must be computed to define an ordinary own property. */
function objectKey(name: string): string {
  return name === "__proto__" ? `[${quote(name)}]` : quote(name);
}

function literalValueSource(value: unknown): string {
  return JSON.stringify(value)?.replaceAll('"__proto__":', '["__proto__"]:') ?? "undefined";
}

function componentPropAttribute(name: string, value: string): string {
  return name === "__proto__" ? `{...{ __proto__: null, ...{ ${objectKey(name)}: ${value} } }}` : `${name}={${value}}`;
}

/** Match native projection marking so controllers can act on rendered slot content. */
function projectedNode(node: TemplateNode): TemplateNode {
  if (node.kind !== "element") return node;
  return { ...node, attributes: [...node.attributes.filter(attribute => attribute.name !== "data-slotted"),
    { kind: "literal", name: "data-slotted", value: "" }] };
}

function literalPropValue(value: string, contract: PropContract): string {
  const type = normalizeType(contract.type);
  const parsed = value === "" && type.kind === "terminal" && type.name === "boolean"
    ? { ok: true as const, value: true }
    : parseTypedValue(value, contract.type, "$", "html");
  return parsed.ok ? literalValueSource(parsed.value) : `${quote(value)} as any`;
}

/** A missing class base differs from an authored empty class attribute. */
function classBaseSource(node: ElementNode, root: boolean): string {
  const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "class");
  const empty = literal?.kind === "literal" ? quote("") : root ? `(rest.class == null || rest.class === false ? undefined : ${quote("")})` : "undefined";
  return `([${literal?.kind === "literal" ? quote(literal.value) : quote("")}${root ? ", rest.class" : ""}].filter(Boolean).join(" ") || ${empty})`;
}

function checkSupported(definition: ComponentDefinition): { importedNames: ReadonlySet<string>; refs: Set<string> } {
  const importedNames = new Set<string>();
  const refs = new Set<string>();
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
    if (node.name.includes("-")) importedNames.add(componentName(node.name));
    if (node.ref !== undefined) refs.add(node.ref);
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
  return { importedNames, refs };
}

interface RenderContext {
  readonly definition: ComponentDefinition;
  readonly imports: Set<string>;
  readonly handlerNames: ReadonlyMap<string, string>;
  readonly inputNames: ReadonlyMap<string, string>;
  readonly slotsByTag?: SvelteConversionOptions["slotsByTag"];
  usesScopedSlots: boolean;
  usesSampledSlots: boolean;
  readonly checkedSlotName: string;
  readonly propContractsByTag?: SvelteConversionOptions["propContractsByTag"];
  readonly styleOwner?: string;
  nextLoop: number;
  htmlSites: number;
  readonly localHtmlSites: Set<number>;
  readonly optionHtmlSites: Set<number>;
  readonly retentions: Map<number, { readonly initial?: string }>;
  readonly localRetentions: Set<number>;
  usesAttributeBinding: boolean;
  usesComponentBindings: boolean;
  usesDeclaredFormats: boolean;
  usesProperties: boolean;
  usesDecorations: boolean;
  usesStyleDecorations: boolean;
  usesInvocationClasses: boolean;
  readonly initialClassName: string;
  usesDecorationAttachment: boolean;
  readonly rootDecorations?: SvelteConversionOptions["rootDecorations"];
  readonly rootBindings?: readonly string[] | undefined;
  readonly initialBindingsName: string;
  readonly initialBindingReadName: string;
  readonly nativeBindingReadName: string;
  readonly rootBindingAttributeName: string;
  readonly decorationAttachmentName: string;
  readonly propertyAttachmentName: string;
  usesControls: boolean;
  usesNestedBindings: boolean;
  boundSelect: boolean | string;
  selectSelection?: string | undefined;
  implicitOptionValueName?: string;
  readonly controlAttachmentName: string;
  readonly bindingHelperName: string;
  readonly bindingValueName: string;
  readonly rootAttributeBindings: Set<string>;
  usesEvents: boolean;
  readonly refs: Set<string>;
  readonly refsName: string;
  readonly resetRootRefs: boolean;
  readonly refAttachmentName: string;
  readonly refTargetName: string;
  readonly writePathName: string;
  readonly freshIdentifier: (base: string) => string;
}

function strictTypeCheck(type: TypeNode, value: string, context: RenderContext): string {
  context.usesDeclaredFormats = true;
  return `acceptsBindingDestination(${value}, ${JSON.stringify(type)})`;
}

function declaredReadGuard(plan: CompiledExpression, scope: Scope, context: RenderContext): string | undefined {
  return declaredReferenceGuard(plan, scope, context.definition, (type, value) => strictTypeCheck(type, value, context));
}

function conformingRead(plan: CompiledExpression, scope: Scope, context: RenderContext, source: string): { source: string; invalid: boolean } {
  const guard = declaredReadGuard(plan, scope, context);
  return {
    source: guard === undefined ? source : `(${guard}) ? ${source} : Symbol.for('html-next.invalid-result')`,
    invalid: guard !== undefined || mayProduceInvalidResult(plan.ast, scope),
  };
}

/** Preserve invalid results before display conversion can stringify their symbol. */
function conformingTextRead(plan: CompiledExpression, scope: Scope, lowering: Lowering, context: RenderContext): { source: string; invalid: boolean } {
  const invalid = mayProduceInvalidResult(plan.ast, scope);
  if (!invalid || ["boolean", "string", "number", "scalar"].includes(category(typeOf(plan.ast, scope).type))) {
    return conformingRead(plan, scope, context, lowering.text(plan.ast, scope));
  }
  const candidate = context.freshIdentifier("htmlNextText");
  const read = conformingRead(plan, scope, context, lowering.value(plan.ast, scope));
  const displayScope: Scope = { code: new Map([[candidate, candidate]]), types: new Map([[candidate, typeOf(plan.ast, scope)]]) };
  const display = lowering.text({ kind: "id", name: candidate }, displayScope);
  return { source: `(() => { const ${candidate}: any = ${read.source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? ${candidate} : ${display}; })()`, invalid: true };
}

function textSource(node: Extract<TemplateNode, { kind: "text" }>, scope: Scope, lowering: Lowering, context: RenderContext): string {
  if (node.segments !== undefined) return `[${node.segments.map((segment) => textSource(segment, scope, lowering, context)).join(", ")}].map(value => String(value ?? "")).join("")`;
  if (node.expressionPlan === undefined) return quote(node.value);
  const read = conformingTextRead(node.expressionPlan, scope, lowering, context);
  return read.invalid ? retained(context, read.source, "undefined as any") : read.source;
}

/** Attribute presence and Web IDL Boolean conversion differ for dynamic multiple values. */
function selectMultiple(node: ElementNode, root: boolean, scope: Scope, lowering: Lowering, context: RenderContext): string {
  const literal = node.attributes.some((entry) => entry.name === "multiple" && entry.kind === "literal");
  const incoming = root ? lowering.attribute({ kind: "id", name: "htmlNextMultiple" }, unknownValueScope("htmlNextMultiple"), "multiple") : undefined;
  const fallback = root ? `(() => { const htmlNextMultiple: unknown = rest.multiple; return Object.hasOwn(rest, "multiple") ? (${incoming}) !== undefined : ${literal}; })()` : String(literal);
  const binding = node.attributes.find((entry) => entry.name === "multiple" && (entry.kind === "attribute" || entry.kind === "property"));
  if (binding === undefined || binding.kind !== "attribute" && binding.kind !== "property") return fallback;
  const source = binding.kind === "property" ? lowering.value(binding.expressionPlan!.ast, scope) : lowering.attribute(binding.expressionPlan!.ast, scope, "multiple");
  const read = conformingRead(binding.expressionPlan!, scope, context, source);
  const candidate = context.freshIdentifier("htmlNextMultiple");
  return `(() => { const ${candidate}: unknown = ${read.source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? ${fallback} : ${binding.kind === "property" ? `Boolean(${candidate})` : `${candidate} != null && ${candidate} !== false`}; })()`;
}

/** Public option text expressions can supply exact implicit SSR values. */
function canMatchOptionText(node: TemplateNode): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot" || node.name.includes("-")) return false;
  if (node.name === "option") {
    // An unconditional literal value does not depend on the option's rendered label.
    if (node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "value") &&
      !node.attributes.some((attribute) => attribute.kind !== "literal" && attribute.name === "value")) return true;
    const content = node.attributes.find((attribute) => attribute.kind === "directive");
    if (content !== undefined) return content.name === "value" || content.name === "html";
    if (node.attributes.some((attribute) => attribute.kind === "property" && attribute.name === "textContent")) return true;
    return node.children.every((child) => child.kind === "text");
  }
  return node.children.every(canMatchOptionText);
}

/** Native selects reapply their model after option regions change, not after fixed option text updates. */
function hasOptionRegions(node: TemplateNode): boolean {
  if (node.kind === "text") return false;
  if (node.kind === "slot" || node.flow !== undefined || node.name.includes("-")) return true;
  if (node.name !== "option" && node.attributes.some((attribute) => attribute.kind === "directive" && attribute.name === "html")) return true;
  return node.children.some(hasOptionRegions);
}

function optionAttribute(value: string, context: RenderContext): string {
  const candidate = context.freshIdentifier("htmlNextOptionValue");
  return `(() => { const ${candidate}: unknown = ${value}; return ${candidate} == null ? {} : { value: String(${candidate}) }; })()`;
}

function conformingCondition(plan: CompiledExpression, scope: Scope, lowering: Lowering, context: RenderContext): { source: string; invalid: boolean } {
  const read = conformingRead(plan, scope, context, lowering.value(plan.ast, scope));
  if (!read.invalid) return { source: lowering.condition(plan.ast, scope), invalid: false };
  return { source: `((value: any) => value === Symbol.for('html-next.invalid-result') ? value : ${lowering.truthiness("value")})(${read.source})`, invalid: true };
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

function retainedHtmlSource(context: RenderContext, site: number): string {
  const args = context.styleOwner === undefined ? [] : [quote(context.styleOwner)];
  if (context.optionHtmlSites.has(site)) {
    if (args.length === 0) args.push("undefined");
    args.push("true");
  }
  return `retainedSanitizedHtml(${args.join(", ")})`;
}

function localOwnership(context: RenderContext, firstHtmlSite: number, firstRetention: number): string {
  const localHtml = Array.from({ length: context.htmlSites - firstHtmlSite }, (_, index) => firstHtmlSite + index)
    .filter((site) => !context.localHtmlSites.has(site));
  for (const site of localHtml) context.localHtmlSites.add(site);
  const localRetentions = [...context.retentions].filter(([site]) => site >= firstRetention && !context.localRetentions.has(site));
  for (const [site] of localRetentions) context.localRetentions.add(site);
  return [
    ...localHtml.map((site) => `{@const htmlSite${site} = ${retainedHtmlSource(context, site)}}`),
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
  const read = conformingRead(flow.listPlan, scope, context, lowering.value(listNode, scope));
  const stableSource = read.invalid ? retained(context, read.source, "[] as any[]") : read.source;
  // Native structural reads accept absence, even for an initialized declared list.
  const listSource = listType.type.kind === "list" && (listType.nullable || read.invalid) ? `(${stableSource} ?? [])` : stableSource;
  const filterItem = context.freshIdentifier("htmlNextItem");
  const list = lowering.list(listNode, scope, filterItem, {
    ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
    itemScope: scopeWith(filterItem, "index", "loop"),
    sort: (flow.sort ?? "").split(",").map((key) => key.trim()).filter(Boolean),
    ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
  }, listSource);
  const callbackScope = scopeWith("item", "index", "loop");
  const checked = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list,
    `(item, index, loop) => ${lowering.value(flow.keyPlan.ast, callbackScope)}`);
  const rows = lowering.eachRows(checked);
  const rowScope = scopeWith(`${row}.item`, `${row}.index`, `${row}.loop`);
  const key = flow.keyPlan === undefined ? "" : ` (${lowering.value(flow.keyPlan.ast, rowScope)})`;
  const { flow: _flow, ...body } = node;
  const firstHtmlSite = context.htmlSites;
  const firstRetention = context.retentions.size;
  const inputs: string[] = [];
  const markup = renderNode(body, false, rowScope, lowering, context, inputs);
  const declarations = localOwnership(context, firstHtmlSite, firstRetention);
  return `{#each ${rows} as ${row}${key}}${declarations}${inputs.join("")}${markup}{/each}`;
}

function renderNode(node: TemplateNode, root: boolean, scope: Scope, lowering: Lowering,
  context: RenderContext, blockInputs?: string[]): string {
  if (node.kind === "text") {
    return context.boundSelect && context.selectSelection === undefined && node.expressionPlan === undefined && node.segments === undefined ? escapeHtml(node.value) : `{${textSource(node, scope, lowering, context)}}`;
  }
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
    const hasChildren = context.definition.contract.props.children === undefined;
    const supplied = defaultSlot ? `slots?.[""]${scoped && hasChildren ? " ?? (children === undefined ? undefined : null)" : ""}` : `slots?.[${name}]`;
    const checked = scoped ? `${context.checkedSlotName}(${supplied}, ${name})` : supplied;
    const values = scoped ? `{ ${node.props!.map((prop) => {
      const source = lowering.value(prop.expressionPlan.ast, scope);
      return `${objectKey(prop.name)}: ${mayProduceInvalidResult(prop.expressionPlan.ast, scope) ? retained(context, source, "undefined as unknown") : source}`;
    }).join(", ")} }` : "{}";
    const children = !scoped && defaultSlot && hasChildren ? "{:else if children}{@render children()}" : "";
    return `{#if true}${nameDeclaration}{@const ${selected} = ${checked}}{#if ${selected}}{@render ${selected}(${values})}${children}${fallback === "" ? "" : `{:else}${fallback}`}{/if}{/if}`;
  }
  if (node.flow?.kind === "each") return renderEach(node, scope, lowering, context);
  if (node.flow?.kind === "if") {
    if (node.flow.testPlan === undefined) fail("HT030", `Expression \`${node.flow.test}\` could not be converted.`);
    const { flow: _flow, ...body } = node;
    const read = conformingCondition(node.flow.testPlan, scope, lowering, context);
    return `{#if ${read.invalid ? retained(context, read.source, "false") : read.source}}${renderNode(body, root, scope, lowering, context)}{/if}`;
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
    const read = conformingRead(node.flow.expressionPlan, scope, context, lowering.value(value, scope));
    const markup = renderNode(body, root, local, lowering, context);
    if (!read.invalid) return `{#if true}{@const ${alias} = ${read.source}}${markup}{/if}`;
    const site = context.retentions.size;
    const result = `htmlNextStructural${site}`;
    const retainedSource = retainedStructural(context, read.source);
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
    const expression = flow.expressionPlan === undefined ? undefined : conformingRead(flow.expressionPlan, scope, context, lowering.value(flow.expressionPlan.ast, scope));
    const conditions = arms.map((arm) => {
      if (arm.flow?.kind !== "when") return undefined;
      if (arm.flow.testPlan === undefined) fail("HT030", `Expression \`${arm.flow.test}\` could not be converted.`);
      return conformingCondition(arm.flow.testPlan, local, lowering, context);
    });
    const markup = arms.map((arm) => {
      const { flow: _flow, ...body } = arm;
      const rendered = renderNode(body, root, local, lowering, context);
      return root && context.resetRootRefs ? `{#key ${context.refsName}.clear()}${rendered}{/key}` : rendered;
    });
    const invalid = expression?.invalid === true || conditions.some((condition) => condition?.invalid === true);
    if (!invalid) {
      const cases = arms.map((arm, index) => {
        if (arm.flow?.kind === "when") return `${index === 0 ? "{#if" : "{:else if"} ${conditions[index]!.source}}${markup[index]}`;
        if (arm.flow?.kind === "else") return `{:else}${markup[index]}`;
        fail("HT018", "A $match child must be a $when or $else arm.");
      }).join("");
      const block = `${cases}{/if}`;
      return alias === undefined || expression === undefined ? block : `{#if true}{@const ${alias} = ${expression.source}}${block}{/if}`;
    }
    // Choose the arm and alias together: an invalid tested arm retains the entire region.
    // Tests after the winning arm must remain unevaluated, matching prepareMatch.
    const testName = context.freshIdentifier("htmlNextMatchTest");
    const selection = arms.map((arm, index) => {
      const condition = conditions[index];
      const selected = `{ arm: ${index}, value: ${alias ?? "undefined"} }`;
      if (arm.flow?.kind === "else") return `return ${selected};`;
      if (condition === undefined) fail("HT018", "A $match child must be a $when or $else arm.");
      return `{ const ${testName}: any = ${condition.source}; ${condition.invalid ? `if (${testName} === Symbol.for('html-next.invalid-result')) return ${testName}; ` : ""}if (${testName}) return ${selected}; }`;
    }).join(" ");
    const sampled = context.freshIdentifier("htmlNextMatchValue");
    const source = `(() => { ${alias === undefined || expression === undefined ? "" : `const ${sampled} = ${expression.source}; ${expression.invalid ? `if (${sampled} === Symbol.for('html-next.invalid-result')) return ${sampled};` : ""} const ${alias} = ${sampled} as ${typeScript(typeOf(value!, scope))};`} ${selection} return { arm: -1, value: ${alias ?? "undefined"} }; })()`;
    const result = context.freshIdentifier("htmlNextMatch");
    const retainedSource = retainedStructural(context, source);
    const cases = arms.map((_arm, index) => `${index === 0 ? "{#if" : "{:else if"} ${result}.value.arm === ${index}}${markup[index]}`).join("");
    return `{#if true}{@const ${result} = ${retainedSource}}{#if ${result}.ready}${alias === undefined ? "" : `{@const ${alias} = ${result}.value.value}`}${cases}{/if}{/if}{/if}`;
  }

  const contentDirective = node.attributes.find((attribute) => attribute.kind === "directive");
  let content: string | undefined;
  let optionTextValue: string | undefined;
  let optionHtmlSite: number | undefined;
  let optionAttributeValue: string | undefined;
  let optionPropertyValue: string | undefined;
  if (contentDirective?.kind === "directive" && contentDirective.expressionPlan !== undefined) {
    const plan = contentDirective.expressionPlan;
    const read = conformingTextRead(plan, scope, lowering, context);
    const value = read.invalid ? retained(context, read.source, "undefined as any") : read.source;
    const optionText = node.name === "option" ? context.freshIdentifier("htmlNextOptionText") : undefined;
    if (node.name === "option" && contentDirective.name !== "html") optionTextValue = value;
    if (contentDirective.name === "html") {
      const site = context.htmlSites++;
      if (node.name === "option" && context.selectSelection !== undefined) {
        optionHtmlSite = site;
        optionTextValue = `htmlSite${site}.text(${value})`;
      }
      content = `{@html htmlSite${site}(${value})}`;
    } else content = node.name === "option" ? `{(() => { const ${optionText}: unknown = ${value}; return ${optionText} == null ? "" : String(${optionText}); })()}` : `{${value}}`;
  }
  if (content === undefined && node.name === "option" && node.children.every((child) => child.kind === "text") &&
    node.children.some((child) => child.expressionPlan !== undefined || child.segments !== undefined)) {
    optionTextValue = `[${node.children.map((child) => textSource(child, scope, lowering, context)).join(", ")}].map(value => String(value ?? "")).join("")`;
    content = `{${optionTextValue}}`;
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
    componentChildren = defaults.map(projectedNode);
    if (groups.has("") || childProps?.children !== undefined && defaults.length > 0) {
      const unnamed = node.children.filter((child) => {
        const assigned = child.kind === "element" ? child.attributes.find((entry) => entry.kind === "literal" && entry.name === "slot") : undefined;
        return assigned?.kind !== "literal" || assigned.value === "";
      });
      groups.set("", unnamed);
      componentChildren = [];
    }
    for (const [slot, children] of groups) {
      const contracts = context.slotsByTag?.get(node.name);
      const contract = contracts?.find((entry) => !entry.dynamic && entry.name === slot)
        ?? contracts?.find((entry) => entry.dynamic && (entry.props?.length ?? 0) > 0);
      const scoped = (contract?.props?.length ?? 0) > 0;
      const carrier = children.find((child): child is ElementNode => child.kind === "element" && child.name === "template");
      if (scoped && carrier === undefined) { slotBindings.push(`${objectKey(slot)}: null`); continue; }
      const alias = context.freshIdentifier("htmlNextSlotProps");
      const snippet = context.freshIdentifier("htmlNextProjection");
      const projectedScope: Scope = !scoped ? scope : {
        ...scope,
        code: new Map([...scope.code, ...contract!.props!.map((prop) => [prop, `${alias}[${quote(prop)}]`] as const)]),
        types: new Map<string, Static>([...scope.types, ...contract!.props!.map((prop) => [prop, { type: { kind: "terminal" as const, name: "unknown" }, nullable: true }] as const)]),
      };
      const firstHtml = context.htmlSites;
      const firstRetention = context.retentions.size;
      const markup = (scoped ? carrier!.children : children.map(projectedNode)).map((child) => renderNode(child, false, projectedScope, lowering, context)).join("");
      const ownership = localOwnership(context, firstHtml, firstRetention);
      snippetDeclarations += `{#snippet ${snippet}(${alias}: Record<string, any>)}${ownership}${markup}{/snippet}`;
      slotBindings.push(`${objectKey(slot)}: ${snippet}`);
    }
  }
  const decorations = node.attributes.filter((entry) => entry.kind === "attribute" && (entry.target === "class" || entry.target === "style"));
  const ownsClasses = decorations.some((entry) => entry.kind === "attribute" && entry.target === "class");
  const ownsStyles = decorations.some((entry) => entry.kind === "attribute" && entry.target === "style");
  const decoratesClasses = ownsClasses || root && context.rootDecorations?.classes === true;
  const decoratesStyles = ownsStyles || root && context.rootDecorations?.styles === true;
  const hasDecorations = decoratesClasses || decoratesStyles;
  const ownedRules = decorations.map((entry) => {
    if (entry.kind !== "attribute" || entry.expressionPlan === undefined) fail("HT030", "An uncompiled decoration cannot be converted.");
    const plan = entry.expressionPlan;
    const guard = declaredReadGuard(plan, scope, context);
    const source = entry.target === "class" ? lowering.condition(plan.ast, scope) : lowering.text(plan.ast, scope);
    return `{ kind: ${quote(entry.target!)} as const, name: ${quote(entry.name)}, read: () => (${guard === undefined ? source : `(${guard}) ? ${source} : Symbol.for('html-next.invalid-result')`}) }`;
  });
  if (root && context.rootDecorations !== undefined) ownedRules.push(`...((rest[${quote(DECORATIONS_PROP)}] as readonly Decoration[] | undefined) ?? [])`);
  const rules = `[${ownedRules.join(", ")}]`;
  if (hasDecorations) context.usesDecorations = true;
  if (!component && decoratesStyles) context.usesStyleDecorations = true;
  const literals: string[] = [];
  const selectedBindings: string[] = [];
  const literalInputs: string[] = [];
  const inputDeclarations: string[] = blockInputs ?? [];
  const nativeBindings: string[] = [];
  const bindings: string[] = slotBindings.length === 0 ? [] : [childProps?.slots === undefined
    ? `slots={{ ${slotBindings.join(", ")} }}`
    : `{...{ ${quote(SLOTS_PROP)}: { ${slotBindings.join(", ")} } }}`];
  const controlledNames = new Set(node.attributes.filter((attribute) => attribute.kind === "property" ||
    attribute.kind === "attribute" && attribute.twoWay)
    .map((attribute) => attribute.name));
  if (root && node.name === "select" && !controlledNames.has("value") && !context.rootBindings?.includes("value")) {
    context.usesAttributeBinding = true;
    context.rootAttributeBindings.add("value");
    const candidate = context.freshIdentifier("htmlNextSelectAttribute");
    const serialized = lowering.attribute({ kind: "id", name: candidate }, unknownValueScope(candidate), "value");
    const read = `(() => { const ${candidate}: unknown = rest.value; return ${serialized}; })()`;
    bindings.push(`{...(typeof document === 'undefined' && Object.keys(rest).includes("value") ? { value: ${read} } : {})}`);
    bindings.push(`{@attach ${context.bindingHelperName}("value", () => Object.keys(rest).includes("value") ? ${read} : Symbol.for('html-next.invalid-result'))}`);
  }
  const authoredClass = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "class") : undefined;
  const authoredStyle = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "style") : undefined;
  const rootScope = root ? scope as RootScope : undefined;
  const reflectedNames = new Set(rootScope?.props.map((prop) => `data-${kebabCase(prop)}`) ?? []);
  let selectValue: string | undefined;
  let selectSelectionName: string | undefined;
  const manualSelection = node.name === "select" && node.children.every(canMatchOptionText);
  const controlBinding = (attribute: Extract<ElementNode["attributes"][number], { kind: "attribute" | "property" }>): void => {
    context.usesControls = true;
    const read = conformingRead(attribute.expressionPlan!, scope, context, lowering.value(attribute.expressionPlan!.ast, scope));
    const value = read.source;
    const nativeProperty = attribute.kind === "property";
    const multiple = node.name === "select" ? selectMultiple(node, root, scope, lowering, context) : "false";
    const serialize = (source: string): string => attribute.name === "checked" ? nativeProperty ? `Boolean(${source})` : lowering.truthiness(source)
      : node.name === "select" && !nativeProperty ? `((${multiple}) ? (Array.isArray(${source}) ? ${source}.map(String) : []) : (${source} == null ? "" : String(${source})))`
      : nativeProperty && node.name === "select" ? `String(${source})` : `(${source} == null ? "" : String(${source}))`;
    const literalValue = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "value");
    if (node.name === "select" && literalValue?.kind === "literal") {
      context.usesAttributeBinding = true;
      const candidate = context.freshIdentifier("htmlNextSelectValueAttribute");
      const raw = `(Object.hasOwn(rest, "value") ? rest.value : ${quote(literalValue.value)})`;
      const literal = root ? `(() => { const ${candidate}: unknown = ${raw}; return ${lowering.attribute({ kind: "id", name: candidate }, unknownValueScope(candidate), "value")}; })()` : quote(literalValue.value);
      // HTML attribute names are case-insensitive. The public spread keeps an ordinary value
      // attribute alongside Svelte's separate select-selection value during server rendering.
      bindings.push(`{...(typeof document === 'undefined' ? { VALUE: ${literal} } : {})}`);
      bindings.push(`{@attach ${context.bindingHelperName}("value", () => ${literal})}`);
    }
    const inheritsBinding = root && context.rootBindings?.includes(attribute.name);
    const defaultValue = quote(literalValue?.kind === "literal" ? literalValue.value : node.name === "textarea" ? node.children.filter((child) => child.kind === "text").map((child) => child.value).join("") : "");
    const defaultChecked = node.attributes.some((entry) => entry.kind === "literal" && entry.name === "checked");
    const defaults = attribute.name === "checked" ? `{ checked: ${inheritsBinding ? `${context.rootBindingAttributeName}("checked") !== undefined || ` : ""}${defaultChecked} }`
      : `{ value: ${inheritsBinding && node.name === "input" ? `String(${context.rootBindingAttributeName}("value") ?? ${defaultValue})` : defaultValue} }`;
    const candidate = context.freshIdentifier("htmlNextControlValue");
    const serialized = read.invalid ? `(() => { const ${candidate}: unknown = ${value}; return ${candidate} === Symbol.for('html-next.invalid-result') ? (${defaults}).${attribute.name === "checked" ? "checked" : "value"} : ${serialize(candidate)}; })()` : serialize(value);
    if (node.name === "select" && attribute.name === "value") {
      selectValue = serialized;
      if (manualSelection) selectSelectionName = context.freshIdentifier("htmlNextSelectSelection");
    }
    if (node.name !== "textarea") bindings.push(`{...(typeof document === 'undefined' ? { ${objectKey(attribute.name)}: ${selectSelectionName === undefined ? serialized : `Symbol.for('html-next.select-selection')`} } : {})}`);
    else content = `{typeof document === 'undefined' ? ${serialized} : ${quote(node.children.filter((child) => child.kind === "text").map((child) => child.value).join(""))}}`;
    if (node.name === "input") bindings.push(`{...(typeof document === 'undefined' ? {} : { ${attribute.name === "checked" ? "defaultChecked" : "defaultValue"}: (${defaults}).${attribute.name === "checked" ? "checked" : "value"} })}`);
    let update = "undefined";
    if (attribute.kind === "attribute" && attribute.twoWay) update = bindingWriter(attribute);
    const options = [nativeProperty ? "nativeProperty: true" : undefined,
      node.name === "select" && !node.children.some(hasOptionRegions) ? "observeOptions: false" : undefined].filter((entry) => entry !== undefined);
    bindings.push(`{@attach ${context.controlAttachmentName}(${quote(attribute.name)}, () => ${value}, ${defaults}, ${update}${options.length === 0 ? "" : `, { ${options.join(", ")} }`})}`);
    if (root) context.rootAttributeBindings.add(attribute.name);
  };
  const bindingWriter = (attribute: Extract<ElementNode["attributes"][number], { kind: "attribute" }>): string => {
    const path = attribute.writablePath!;
    const destination = scope.code.get(path[0] as string)!;
    const value = context.bindingValueName;
    if (path.length > 1) context.usesNestedBindings = true;
    const write = path.length === 1 ? `${destination} = ${value} as typeof ${destination};`
      : `${context.writePathName}(${destination}, [${path.slice(1).map((segment) => typeof segment === "object" ? lowering.value(segment.expression, scope) : JSON.stringify(segment)).join(", ")}], ${value});`;
    return `(${value}: unknown) => { if (${value} !== Symbol.for('html-next.invalid-result')) { ${write} } }`;
  };
  const selectedBindingInput = (prop: string, attribute: Extract<ElementNode["attributes"][number], { kind: "attribute" }>): void => {
    const candidate = context.freshIdentifier("htmlNextBindingInput");
    const guard = declaredReadGuard(attribute.expressionPlan!, scope, context);
    const source = lowering.value(attribute.expressionPlan!.ast, scope);
    const serialized = lowering.attribute({ kind: "id", name: candidate }, unknownValueScope(candidate), attribute.name);
    selectedBindings.push(`[${quote(prop)}]: () => { if (!(${guard ?? "true"})) return Symbol.for('html-next.invalid-result'); const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? ${candidate} : { value: ${candidate}, attribute: ${serialized} }; }`);
  };
  const boundLiteralInput = (prop: string, contract: PropContract, raw: string, guard: string | undefined, literal: string): string => {
    context.usesComponentBindings = true;
    const candidate = context.freshIdentifier("htmlNextBindingValue");
    const input = context.freshIdentifier("htmlNextBindingInput");
    const initial = `{ value: ${literalPropValue(literal, contract)}, raw: ${quote(literal)} } as { value: any; raw: unknown }`;
    const read = retained(context, `(() => { if (!(${guard ?? "true"})) return Symbol.for('html-next.invalid-result'); const ${candidate}: unknown = ${raw}; return acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(contract.type))}) ? { value: ${candidate}, raw: ${candidate} } : Symbol.for('html-next.invalid-result'); })()`, initial);
    inputDeclarations.push(`{@const ${input} = ${read}}`);
    literalInputs.push(`[${quote(prop)}]: { get raw() { return ${input}.raw; } }`);
    return `${input}.value`;
  };
  if (node.name === "option" && context.boundSelect && context.selectSelection === undefined) {
    const selected = node.attributes.some((entry) => entry.kind === "literal" && entry.name === "selected");
    bindings.push(`{...(typeof document === 'undefined' && (${context.boundSelect}) ? { "data-html-next-option-default": ${quote(String(selected))} } : {})}`);
  }
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      if (node.name === "select" && attribute.name === "value" && !controlledNames.has("value")) {
        context.usesAttributeBinding = true;
        literals.push(`{...(typeof document === 'undefined' ? { value: ${quote(attribute.value)} } : {})}`);
        const candidate = context.freshIdentifier("htmlNextSelectLiteral");
        const value = root ? `(() => { const ${candidate}: unknown = Object.keys(rest).includes("value") ? rest.value : ${quote(attribute.value)}; return ${lowering.attribute({ kind: "id", name: candidate }, unknownValueScope(candidate), "value")}; })()` : quote(attribute.value);
        bindings.push(`{@attach ${context.bindingHelperName}("value", () => ${value})}`);
        continue;
      }
      if (controlledNames.has(attribute.name) && childProp(attribute.name)?.[1].select === undefined ||
        !component && node.name === "input" && ["value", "checked"].includes(attribute.name) && node.attributes.some((entry) => entry.kind === "attribute" && entry.name === attribute.name && entry.target === undefined) ||
        (ownsClasses && attribute.name === "class" || !component && ownsStyles && attribute.name === "style")) continue;
      if (root && (attribute.name === "class" || attribute.name === "style" || reflectedNames.has(attribute.name))) continue;
      if (node.name === "option" && context.boundSelect && attribute.name === "selected") {
        bindings.push(`{...(typeof document === 'undefined' && (${context.boundSelect}) ? {} : { selected: true })}`);
        continue;
      }
      if (root && !component && context.rootBindings?.includes(attribute.name) === true) {
        context.usesAttributeBinding = true;
        literals.push(`{...(typeof document === 'undefined' ? { ${objectKey(attribute.name)}: ${quote(attribute.value)} } : {})}`);
        if (!nativeControlBinding(node.name, attribute.name)) bindings.push(`{@attach ${context.bindingHelperName}(${quote(attribute.name)}, () => ${quote(attribute.value)})}`);
        continue;
      }
      const declared = childProp(attribute.name);
      if (declared !== undefined && declared[1].select === undefined && node.attributes.some((entry) =>
        entry.kind === "attribute" && entry.target === undefined && childProp(entry.name)?.[0] === declared[0])) continue;
      if (declared === undefined) literals.push(!component && isNativeBooleanAttribute(attribute.name) ? attribute.name : `${attribute.name}=${attribute.name === "slot" || !component && /^[-+]?\d+(?:\.\d+)?$/.test(attribute.value) ? literalAttribute(attribute.value) : `{${quote(attribute.value)}}`}`);
      else {
        const [prop, contract] = declared;
        literals.push(componentPropAttribute(prop, literalPropValue(attribute.value, contract)));
        const options = contract.select?.options.map((option) =>
          `[${JSON.stringify(option.value)}, ${literalPropValue(attribute.value, { ...contract, type: option.type })}]`);
        literalInputs.push(`[${quote(prop)}]: { raw: ${quote(attribute.value)}${options === undefined ? "" : `, options: [${options.join(", ")}]`} }`);
      }
      continue;
    }
    if (attribute.kind === "attribute") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Expression \`${attribute.expression}\` could not be converted.`);
      if (root && reflectedNames.has(attribute.name) && attribute.twoWay !== true) continue;
      if (attribute.twoWay === true) {
        if (component) {
          const declared = childProp(attribute.name);
          context.usesControls = true;
          if (declared === undefined) {
            const guard = declaredReadGuard(attribute.expressionPlan, scope, context);
            const source = lowering.value(attribute.expressionPlan.ast, scope);
            nativeBindings.push(`[${quote(attribute.name)}]: () => ${guard === undefined ? source : `(${guard}) ? ${source} : Symbol.for('html-next.invalid-result')`}`);
            bindings.push(`{@attach (element: Element) => attachGenericBinding(element, ${bindingWriter(attribute)})}`);
            continue;
          }
          const guard = declaredReadGuard(attribute.expressionPlan, scope, context);
          const source = lowering.value(attribute.expressionPlan.ast, scope);
          if (declared[1].select !== undefined) {
            selectedBindingInput(declared[0], attribute);
            bindings.push(`{@attach (element: Element) => attachGenericBinding(element, ${bindingWriter(attribute)})}`);
            continue;
          }
          context.usesComponentBindings = true;
          const candidate = context.freshIdentifier("htmlNextBindingValue");
          const literal = node.attributes.find((entry) => entry.kind === "literal" && childProp(entry.name)?.[0] === declared[0]);
          const initial = literal?.kind === "literal" ? `${literalPropValue(literal.value, declared[1])} as any` : "undefined as any";
          const value = literal?.kind === "literal" ? boundLiteralInput(declared[0], declared[1], source, guard, literal.value) : retained(context, `(() => { if (!(${guard ?? "true"})) return Symbol.for('html-next.invalid-result'); const ${candidate}: unknown = ${source}; return acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(declared[1].type))}) ? ${candidate} : Symbol.for('html-next.invalid-result'); })()`, initial);
          bindings.push(componentPropAttribute(declared[0], value));
          bindings.push(`{@attach (element: Element) => attachGenericBinding(element, ${bindingWriter(attribute)})}`);
        } else if (nativeControlBinding(node.name, attribute.name)) controlBinding(attribute);
        else {
          // Ordinary elements reflect the attribute, and feed their native value back on input.
          context.usesAttributeBinding = true;
          context.usesControls = true;
          const name = svgAttributeName(attribute.name);
          const read = conformingRead(attribute.expressionPlan, scope, context, lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name));
          const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === attribute.name);
          const value = read.invalid ? retained(context, read.source, literal?.kind === "literal" ? quote(literal.value) : "undefined as any") : read.source;
          if (node.name === "option" && name === "value") optionAttributeValue = value;
          // Svelte optimizes value= into a property write even on <output>. Keep the
          // server attribute declarative, and use only setAttribute/removeAttribute on the client.
          bindings.push(`{...(typeof document === 'undefined' ? ${node.name === "option" && name === "value" ? optionAttribute(value, context) : `{ ${objectKey(name)}: ${value} }`} : {})}`);
          bindings.push(`{@attach ${context.bindingHelperName}(${quote(name)}, () => ${read.source}, ${bindingWriter(attribute)}${node.name === "option" && name === "value" ? ", true" : ""})}`);
          if (root) context.rootAttributeBindings.add(attribute.name);
        }
      }
      else if (attribute.target === "class" || attribute.target === "style") continue;
      else {
        const declared = childProp(attribute.name);
        if (declared?.[1].select !== undefined) { selectedBindingInput(declared[0], attribute); continue; }
        const read = conformingRead(attribute.expressionPlan, scope, context, declared === undefined
          ? lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name) : lowering.value(attribute.expressionPlan.ast, scope));
        const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === attribute.name);
        const initial = literal?.kind === "literal" ? declared === undefined ? quote(literal.value) : `${literalPropValue(literal.value, declared[1])} as any` : "undefined as any";
        let value: string;
        if (declared !== undefined && declared[1].select === undefined) {
          if (literal?.kind === "literal") value = boundLiteralInput(declared[0], declared[1], lowering.value(attribute.expressionPlan.ast, scope), declaredReadGuard(attribute.expressionPlan, scope, context), literal.value);
          else if (attribute.expressionPlan.ast.kind === "literal" && attribute.expressionPlan.ast.dimension === undefined &&
            parseTypedValue(attribute.expressionPlan.ast.value, declared[1].type, "$", "value").ok) value = read.source;
          else {
            context.usesComponentBindings = true;
            const candidate = context.freshIdentifier("htmlNextBindingValue");
            value = retained(context, `(() => { const ${candidate}: unknown = ${read.source}; return ${candidate} !== Symbol.for('html-next.invalid-result') && acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(declared[1].type))}) ? ${candidate} : Symbol.for('html-next.invalid-result'); })()`, initial);
          }
        } else value = read.invalid ? retained(context, read.source, initial) : read.source;
        if (node.name === "select" && attribute.name === "value" || node.name === "input" && ["value", "checked"].includes(attribute.name)) {
          context.usesAttributeBinding = true;
          const nativeAttribute = node.name === "input" && attribute.name === "checked" ? `((value: unknown) => value === false ? undefined : value)(${value})` : value;
          const nativeRead = node.name === "input" && attribute.name === "checked" ? `((value: unknown) => value === false ? undefined : value === true ? "" : value)(${read.source})` : read.source;
          bindings.push(`{...(typeof document === 'undefined' ? { ${objectKey(attribute.name)}: ${nativeAttribute} } : {})}`);
          // Public default properties keep Svelte hydration from clearing native attribute defaults.
          if (node.name === "input") bindings.push(`{...(typeof document === 'undefined' ? {} : { ${attribute.name === "checked" ? "defaultChecked" : "defaultValue"}: ${attribute.name === "checked" ? `(${nativeAttribute}) != null` : nativeAttribute} })}`);
          bindings.push(`{@attach ${context.bindingHelperName}(${quote(attribute.name)}, () => ${nativeRead})}`);
          if (root) context.rootAttributeBindings.add(attribute.name);
        } else if (node.name === "option" && attribute.name === "value") {
          optionAttributeValue = value;
          // An option's DOM value is always a string. Omitted value attributes use option text.
          context.usesAttributeBinding = true;
          bindings.push(`{...(typeof document === 'undefined' ? ${optionAttribute(value, context)} : {})}`);
          bindings.push(`{@attach ${context.bindingHelperName}("value", () => ${read.source}, undefined, true)}`);
        } else bindings.push(component
          ? componentPropAttribute(declared?.[0] ?? attribute.name, value)
          : `${svgAttributeName(attribute.name)}={${value}}`);
      }
    }
    if (attribute.kind === "property") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Expression \`${attribute.expression}\` could not be converted.`);
      if (nativeControlBinding(node.name, attribute.name)) controlBinding(attribute);
      else {
        const read = conformingRead(attribute.expressionPlan, scope, context, lowering.value(attribute.expressionPlan.ast, scope));
        const source = read.source;
        if (attribute.name === "textContent") {
          const value = read.invalid ? retained(context, source, "undefined as unknown") : source;
          content = `{${value} == null ? "" : String(${value})}`;
          if (node.name === "option") optionTextValue = value;
        } else {
          context.usesProperties = true;
          bindings.push(`{@attach ${context.propertyAttachmentName}(${quote(attribute.name)}, () => ${source})}`);
          if (SSR_BOOLEAN_PROPERTIES.has(attribute.name) || SSR_STRING_PROPERTIES.has(attribute.name)) {
            const boolean = SSR_BOOLEAN_PROPERTIES.has(attribute.name);
            let rendered = boolean ? `Boolean(${source})` : `String(${source})`;
            if (read.invalid) {
              const candidate = context.freshIdentifier("htmlNextPropertyValue");
              const serialized = boolean ? `Boolean(${candidate})` : `String(${candidate})`;
              const name = attribute.name.toLowerCase();
              const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === name);
              const initialValue = literal?.kind === "literal" ? quote(literal.value) : "undefined";
              const initialAttribute = context.freshIdentifier("htmlNextPropertyAttribute");
              const initialSource = root ? `(Object.keys(rest).includes(${quote(name)}) ? rest[${quote(name)}] : ${initialValue})` : initialValue;
              const initialResult = context.freshIdentifier("htmlNextInitialProperty");
              const initial = `(() => { const ${initialAttribute}: unknown = ${initialSource}; const ${initialResult} = ${lowering.attribute({ kind: "id", name: initialAttribute }, unknownValueScope(initialAttribute), name)}; return ${boolean ? `${initialResult} !== undefined` : initialResult}; })()`;
              rendered = retained(context, `(() => { const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? ${candidate} : ${serialized}; })()`, initial);
            }
            if (node.name === "option" && attribute.name === "value") optionPropertyValue = rendered;
            bindings.push(`{...(typeof document === 'undefined' ? { ${objectKey(attribute.name.toLowerCase())}: ${rendered} } : {})}`);
          }
        }
        if (root) { context.rootAttributeBindings.add(attribute.name); context.rootAttributeBindings.add(attribute.name.toLowerCase()); }
      }
    }
  }
  if (nativeBindings.length > 0) bindings.push(`{...{ ${quote(NATIVE_BINDINGS_PROP)}: { ${nativeBindings.join(", ")} } }}`);
  if (root && !component) {
    for (const name of context.rootBindings ?? []) {
      const read = `${context.nativeBindingReadName}(${quote(name)})`;
      const source = `(${read} === undefined ? Symbol.for('html-next.invalid-result') : ${read}!())`;
      if (nativeControlBinding(node.name, name)) {
        context.usesControls = true;
        const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === name);
        const defaults = name === "checked" ? `{ checked: ${context.rootBindingAttributeName}(${quote(name)}) !== undefined || ${literal !== undefined} }`
          : node.name === "textarea" ? `{ value: ${quote(node.children.filter((child) => child.kind === "text").map((child) => child.value).join(""))} }`
          : `{ value: String(${context.rootBindingAttributeName}(${quote(name)}) ?? ${quote(literal?.kind === "literal" ? literal.value : "")}) }`;
        context.usesAttributeBinding = true;
        const unbound = context.freshIdentifier("htmlNextAttributeValue");
        const unboundScope = unknownValueScope(unbound);
        const unboundSource = `(() => { const ${unbound}: unknown = Object.keys(rest).includes(${quote(name)}) ? rest[${quote(name)}] : ${literal?.kind === "literal" ? quote(literal.value) : "undefined"}; return ${lowering.attribute({ kind: "id", name: unbound }, unboundScope, name)}; })()`;
        const unboundDefault = name === "checked" ? `(${unboundSource}) !== undefined` : `String((${unboundSource}) ?? "")`;
        const candidate = context.freshIdentifier("htmlNextNativeValue");
        const multiple = node.name === "select" ? selectMultiple(node, root, scope, lowering, context) : "false";
        const candidateScope = unknownValueScope(candidate);
        const serialized = name === "checked" ? lowering.condition({ kind: "id", name: candidate }, candidateScope) : node.name === "select" ? `((${multiple}) ? (Array.isArray(${candidate}) ? ${candidate}.map(String) : []) : (${candidate} == null ? "" : String(${candidate})))` : `(${candidate} == null ? "" : String(${candidate}))`;
        if (node.name === "select" && name === "value") {
          selectValue = `(() => { const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? undefined : ${serialized}; })()`;
          if (manualSelection) selectSelectionName = context.freshIdentifier("htmlNextSelectSelection");
        }
        if (node.name === "textarea") content = `{typeof document === 'undefined' ? (() => { const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? (${defaults}).value : ${serialized}; })() : (${defaults}).value}`;
        else bindings.push(selectSelectionName === undefined
          ? `{...(typeof document === 'undefined' ? (() => { const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? {} : { ${objectKey(name)}: ${serialized} }; })() : {})}`
          : `{...(typeof document === 'undefined' && ${selectSelectionName} !== undefined ? { value: Symbol.for('html-next.select-selection') } : {})}`);
        if (node.name !== "input") {
          const inherited = context.freshIdentifier("htmlNextInheritedAttribute");
          bindings.push(`{@attach ${read} === undefined ? undefined : (() => { const ${inherited} = ${context.rootBindingAttributeName}(${quote(name)}) ?? ${literal?.kind === "literal" ? quote(literal.value) : "undefined"}; return ${context.bindingHelperName}(${quote(name)}, () => ${inherited}); })()}`);
        }
        if (node.name === "input") bindings.push(`{...(typeof document === 'undefined' ? {} : { ${name === "checked" ? "defaultChecked" : "defaultValue"}: ${read} === undefined ? ${unboundDefault} : (${defaults}).${name === "checked" ? "checked" : "value"} })}`);
        bindings.push(`{@attach ${read} === undefined ? ${context.bindingHelperName}(${quote(name)}, () => ${unboundSource}) : ${context.controlAttachmentName}(${quote(name)}, () => ${source}, ${defaults}, undefined${node.name === "select" ? ", { observeOptions: false }" : ""})}`);
      } else {
        context.usesAttributeBinding = true;
        const candidate = context.freshIdentifier("htmlNextNativeValue");
        const local = unknownValueScope(candidate);
        const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === name);
        const unbound = `(Object.keys(rest).includes(${quote(name)}) ? rest[${quote(name)}] : ${literal?.kind === "literal" ? quote(literal.value) : "undefined"})`;
        const serialized = lowering.attribute({ kind: "id", name: candidate }, local, name);
        bindings.push(`{@attach ${context.bindingHelperName}(${quote(name)}, () => { const ${candidate}: unknown = ${read} === undefined ? ${unbound} : ${read}!(); return ${candidate} === Symbol.for('html-next.invalid-result') ? ${candidate} : ${serialized}; })}`);
      }
    }
  }
  let selectedOption: string | undefined;
  if (node.name === "option" && context.selectSelection !== undefined) {
    const literalText = node.children.map((child) => child.kind === "text" ? child.value : "").join("");
    const literal = node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "value");
    let normalized = quote(literalText.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, ""));
    if (optionTextValue !== undefined && optionPropertyValue === undefined && (optionAttributeValue !== undefined || literal === undefined)) {
      if (optionHtmlSite !== undefined) context.optionHtmlSites.add(optionHtmlSite);
      context.implicitOptionValueName ??= context.freshIdentifier("htmlNextOptionValue");
      normalized = `${context.implicitOptionValueName}(${optionTextValue})`;
    }
    let value = optionPropertyValue ?? (literal?.kind === "literal" ? quote(literal.value) : normalized);
    if (optionAttributeValue !== undefined && optionPropertyValue === undefined) {
      const candidate = context.freshIdentifier("htmlNextOptionValue");
      value = `(() => { const ${candidate}: unknown = ${optionAttributeValue}; return ${candidate} == null ? ${normalized} : String(${candidate}); })()`;
    }
    const selected = node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "selected");
    // Mark defaults only where SSR selection differs from authored selected=.
    const yes = selected ? "{ selected: true }" : '{ selected: true, "data-html-next-option-default": "false" }';
    const no = selected ? '{ "data-html-next-option-default": "true" }' : "{}";
    // The callback keeps SSR-only reads out of per-option client memoization.
    selectedOption = `{...Reflect.apply(() => typeof document === 'undefined' && (${context.boundSelect}) ? (${context.selectSelection}?.(${value}) ? ${yes} : ${no}) : {}, undefined, [])}`;
  }
  if (selectedBindings.length > 0) bindings.push(`${BINDING_INPUTS_PROP}={{ ${selectedBindings.join(", ")} }}`);
  // Svelte preserves NUL-named component props; a spread adds a proxy to every invocation.
  if (literalInputs.length > 0) bindings.push(`${LITERAL_INPUTS_PROP}={{ ${literalInputs.join(", ")} }}`);
  const attributes = [...(selectedOption === undefined ? [] : [selectedOption]), ...literals];
  if (root) {
    attributes.push("{...rootAttrs}");
    if (component) attributes.push(`{...{ ${quote(ROOT_OWNER_PROP)}: true }}`);
    attributes.push(rootScope!.preservesRootFocus
      ? "{@attach (element: Element) => { rootElement = element; if (rootFocusPending) { (element as HTMLElement).focus({ preventScroll: true }); rootFocusPending = false; } return () => { rootFocusPending ||= element.ownerDocument.activeElement === element; if (rootElement === element) rootElement = undefined; }; }}"
      : component
      ? "{@attach (element: Element) => { rootElement = element; return () => { if (rootElement === element) rootElement = undefined; }; }}"
      : "bind:this={rootElement}");
    if (authoredClass?.kind === "literal" && !decoratesClasses) {
      const base = classBaseSource(node, root);
      if (component) attributes.push(`class={${base}}`);
      else {
        context.usesAttributeBinding = true;
        context.rootAttributeBindings.add("class");
        attributes.push(`{...(typeof document === 'undefined' ? { class: ${base} } : {})}`);
        attributes.push(`{@attach ${context.bindingHelperName}("class", () => ${base})}`);
      }
    }
    if (authoredStyle?.kind === "literal" && (component || !decoratesStyles)) {
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
      attributes.push(`${name}={${!bound ? `${context.inputNames.get(prop)} == null ? ${fallback} : ` : ""}${value} == null ? undefined : (${serialized})}`);
    }
  }
  if (hasDecorations) {
    if (component) {
      if (decoratesClasses) {
        context.usesInvocationClasses = true;
        const base = classBaseSource(node, root);
        attributes.push(`class={${context.initialClassName}(${base}, ${rules})}`);
      }
      attributes.push(`{...{ ${quote(DECORATIONS_PROP)}: ${rules} }}`);
    } else {
      context.usesDecorationAttachment = true;
      if (decoratesClasses) {
        const base = classBaseSource(node, root);
        context.usesAttributeBinding = true;
        if (root) context.rootAttributeBindings.add("class");
        attributes.push(`{...(typeof document === 'undefined' ? { class: classText(${base}, ${rules}) } : {})}`);
        attributes.push(`{@attach ${context.bindingHelperName}("class", () => ${base})}`);
      }
      if (decoratesStyles) {
        const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "style");
        const base = `[${literal?.kind === "literal" ? quote(literal.value) : quote("")}${root ? ", rest.style" : ""}].filter(Boolean).join("; ")`;
        const empty = literal?.kind === "literal" ? quote("") : root ? `(rest.style == null || rest.style === false ? undefined : ${quote("")})` : "undefined";
        attributes.push(`style={(typeof document === 'undefined' ? styleText(${base}, ${rules}) : ${base}) || ${empty}}`);
      }
      attributes.push(`{@attach ${context.decorationAttachmentName}(${rules})}`);
    }
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
  const previousSelectSelection = context.selectSelection;
  if (node.name === "select") context.boundSelect = controlledNames.has("value") ? true
    : root && context.rootBindings?.includes("value") ? `${context.nativeBindingReadName}("value") !== undefined` : false;
  if (node.name === "select") context.selectSelection = selectSelectionName;
  const children = content ?? componentChildren.map((child) => renderNode(child, false, scope, lowering, context)).join("");
  context.boundSelect = previousBoundSelect;
  context.selectSelection = previousSelectSelection;
  let markup = `${open}${children}</${name}>`;
  if (node.name === "textarea" && content === undefined && node.children.some((child) => child.kind === "text" && (child.expressionPlan !== undefined || child.segments !== undefined))) {
    markup = `<svelte:element this={"textarea"}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>${children}</svelte:element>`;
  }
  if (node.name === "select" && !controlledNames.has("value")) {
    // Public dynamic elements keep SSR value= as an ordinary attribute. A real
    // control binding keeps Svelte's select/option SSR selection context.
    const bridge = root && context.rootBindings?.includes("value");
    const ordinary = `<svelte:element this={"select"}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>${children}</svelte:element>`;
    markup = bridge ? `{#if ${context.nativeBindingReadName}("value") !== undefined}${markup}{:else}${ordinary}{/if}` : ordinary;
  }
  if (selectSelectionName !== undefined) markup = `{#if true}{@const ${selectSelectionName} = typeof document === 'undefined' ? ((value: unknown) => { if (value === undefined) return undefined; const many = Array.isArray(value); let matched = false; return (option: string) => many ? (value as unknown[]).includes(option) : !matched && (matched = value === option); })(${selectValue}) : undefined}${markup}{/if}`;
  if (blockInputs === undefined && inputDeclarations.length > 0) markup = `{#if true}${inputDeclarations.join("")}${markup}{/if}`;
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
  const { importedNames, refs } = checkSupported(definition);
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
  const code = new Map(target.props.map((prop) => [prop.name, `checkedProps[${quote(prop.name)}]`]));
  const types = new Map<string, Static>(target.props.map((prop) => [prop.name, { type: prop.contract.select === undefined ? normalizeType(prop.contract.type) : { kind: "union", members: prop.contract.select.options.map((option) => option.type) }, nullable: true }]));
  const expressionScope: Scope = { code, types };
  const dataNames = new Map<DataDeclaration, string>();
  const dataTypes = new Map<DataDeclaration, string>();
  const taken = new Set([...importedNames, ...code.keys(), ...declarations.map((declaration) => declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name)]);
  const freshIdentifier = (base: string): string => {
    let name = base;
    let suffix = 2;
    while (taken.has(name)) name = `${base}${suffix++}`;
    taken.add(name);
    return name;
  };
  const reserved = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval undefined NaN Infinity globalThis window document String Number Boolean Object Array Symbol Map Set WeakMap WeakSet Reflect JSON Math Date RegExp Intl Promise Error TypeError CustomEvent Event Element HTMLElement Node HTMLInputElement HTMLTextAreaElement HTMLSelectElement queueMicrotask requestAnimationFrame "
    + "retainedBindingInput htmlPropValue parseHtmlLiteral acceptsBindingDestination classText styleText Decoration Props Snippet untrack useComponentHost propValidityState getContext setContext rootElement rootFocusPending specialElement hadConstructor hadProto event children slots rest rootAttrs checkedProps acceptedProps inputAccepted propValidityContract propInputValues hostState hostStateTokens checkedProp selectedPropNode selectedBindingNode mountPropValidity updatePropValidity attachGenericBinding attachBoundControl syncBoundControl controlDefaults prepareHydrationControls observeBoundOptions BoundDefaults attachNativeEvents dispatchDeclared retainedSanitizedHtml useDataRead cycleCheckedComputed retainedValue retainedStructuralValue truthy text attribute math arithmetic concat join sortBy eachRows uniqueKeys").split(" "));
  for (const name of importedNames) reserved.add(name);
  const inputNames = new Map(target.props.map((prop) => [prop.name, freshIdentifier("htmlNextInputValue")]));
  for (const name of inputNames.values()) reserved.add(name);
  reserved.add("formatValue");
  reserved.add("createFormatValue");
  const declarationName = (name: string): string => !isScriptIdentifier(name) || reserved.has(name) || name.startsWith("$") || /^retained\d+$|^htmlSite\d+$|^htmlNextRow\d+$|^htmlNextStructural\d+$/.test(name) ? freshIdentifier("htmlNextValue") : name;
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
    // An initializer does not constrain later writes to untyped state.
    const inferred = declaration.kind === "state" || declaration.expression === undefined
      ? { type: { kind: "terminal", name: "unknown" }, nullable: true } as Static
      : typeOf(declaration.expression.ast, expressionScope);
    const typed = declared === undefined ? inferred : present(declared);
    types.set(declaration.name, { ...typed, nullable: typed.nullable || declaration.expression === undefined || declaration.kind === "computed" });
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
  const context: RenderContext = { definition, handlerNames, inputNames, imports: new Set(), slotsByTag: options.slotsByTag, usesScopedSlots: false, usesSampledSlots: false, checkedSlotName: freshIdentifier("htmlNextCheckedSlot"), propContractsByTag: options.propContractsByTag,
    ...(css !== "" && (definition.slots?.length ?? 0) > 0 ? { styleOwner: definition.contract.tag } : {}),
    nextLoop: 0, htmlSites: 0, localHtmlSites: new Set(), optionHtmlSites: new Set(), retentions: new Map(), localRetentions: new Set(),
    usesAttributeBinding: false, usesComponentBindings: false, usesDeclaredFormats: false, usesProperties: false, usesDecorations: false, usesStyleDecorations: false, usesInvocationClasses: false, initialClassName: freshIdentifier("htmlNextInitialClass"), usesDecorationAttachment: false, rootDecorations: options.rootDecorations, rootBindings: options.rootBindings, initialBindingsName: freshIdentifier("htmlNextInitialBindings"), initialBindingReadName: freshIdentifier("htmlNextInitialBinding"), nativeBindingReadName: freshIdentifier("htmlNextNativeBinding"), rootBindingAttributeName: freshIdentifier("htmlNextRootBindingAttribute"), decorationAttachmentName: freshIdentifier("htmlNextDecorations"), propertyAttachmentName: freshIdentifier("htmlNextProperty"), usesControls: false, usesNestedBindings: false, boundSelect: false, controlAttachmentName: freshIdentifier("htmlNextControl"), bindingHelperName: freshIdentifier("boundAttribute"),
    bindingValueName: freshIdentifier("boundValue"), rootAttributeBindings: new Set(),
    usesEvents: target.events.length > 0, refs, refsName: freshIdentifier("htmlNextRefs"),
    resetRootRefs: usesController || refs.size > 0 || handlers.some((handler) => handler.steps.some((step) => step.kind === "focus" || step.kind === "validate")),
    refAttachmentName: freshIdentifier("htmlNextRef"), refTargetName: freshIdentifier("htmlNextRefTarget"),
    writePathName: freshIdentifier("htmlNextWritePath"), freshIdentifier };
  const controllerHostName = freshIdentifier("htmlNextHost");
  const iteratedRefs = iteratedRefNames(definition);
  const methodNames = new Map(target.methods.map((method) => [method.name, freshIdentifier("htmlNextMethod")]));
  const nestedDepthLimit = options.guardNestedDepth ? definitionMayInvokeComponents(definition) ? 32 : 33 : undefined;
  const nestedDepthName = freshIdentifier("htmlNextDepth");
  const markup = renderNode(definition.template, true, scope, lowering, context);
  const generics = selectorGenerics(definition.contract.props);
  const genericParameters = new Map(generics.map(({ from, parameter }) => [from, parameter]));
  const dependentParameters = new Map(generics.map(({ from, parameter }) => [from, `NoInfer<${parameter}>`]));
  const nativeAttributes = freshIdentifier("HtmlNextNativeAttributes");
  const rawRest = freshIdentifier("htmlNextRest");
  const arms = rootArms(definition.template);
  const rootType = arms === undefined ? getDomInterface(definition.template.name) ?? "HTMLElement"
    : [...new Set(arms.map((arm) => getDomInterface(arm.name) ?? "HTMLElement"))].join(" | ");
  const eventCallbacks = target.events.flatMap((event) => [`on${event.name}`, `on${event.name}capture`]
    .filter((name) => definition.contract.props[name] === undefined)
    .map((name) => ({ name, type: `((event: CustomEvent<${event.detailType}>) => void) | null` })));
  const slotType = (slot: SlotContract): string => `Snippet<[${(slot.props?.length ?? 0) === 0 ? "Record<string, any>" : `Readonly<{ ${slot.props!.map((name) => `${quote(name)}: any;`).join(" ")} }>`}]>`;
  const namedSlots = target.slots.filter((slot) => !slot.dynamic);
  const dynamicSlots = target.slots.filter((slot) => slot.dynamic);
  const slotsType = target.slots.length === 0 ? "Record<string, Snippet<[Record<string, any>]> | null>"
    : `Readonly<{ ${namedSlots.map((slot) => `${quote(slot.name ?? "")}?: ${slotType(slot)} | null;`).join(" ")}${dynamicSlots.length === 0 ? "" : ` [name: string]: ${[...new Set(target.slots.map(slotType))].join(" | ")} | null | undefined;`} }>`;
  const omittedNative = ["children", "slots", ...target.props.map((prop) => prop.name), ...eventCallbacks.map((event) => event.name)];
  const propTypes = target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${genericParameters.get(prop.name) ?? dependentPropTypeSource(prop.contract, dependentParameters)};`).join("\n  ");
  const selectedInputs = new Map(target.props.filter((prop) => prop.contract.select !== undefined).map((prop) => [prop.name, {
    raw: freshIdentifier("htmlNextInput"), retain: freshIdentifier("htmlNextBoundInput"),
  }]));
  const structuredInputs = new Set(target.props.filter((prop) => prop.contract.select?.options.some((option) => hasStructuredHtmlInput(option.type))).map((prop) => prop.name));
  const structuredReader = (name: string): string => structuredInputs.has(name) ? ", parseHtmlLiteral" : "";
  const destructured = target.props.map((prop) => `${quote(prop.name)}: ${selectedInputs.get(prop.name)?.raw ?? inputNames.get(prop.name)}`).join(", ");
  const hasProps = target.props.length > 0;
  const publicChildren = definition.contract.props.children !== undefined;
  const publicSlots = definition.contract.props.slots !== undefined;
  const internalProps = [!publicChildren ? "children" : undefined, !publicSlots ? "slots" : undefined].filter((name) => name !== undefined);
  const selectors = [...new Set(target.props.flatMap((prop) => prop.contract.select === undefined ? [] : [prop.contract.select.from]))];
  const validityContract = { props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) =>
    [name, { ...prop, type: prop.select === undefined ? normalizeType(prop.type)
      : { kind: "union" as const, members: prop.select.options.map((option) => option.type) } }])) };
  const inputSource = (name: string): string => {
    const prop = definition.contract.props[name]!;
    const input = selectedInputs.has(name) ? `${inputNames.get(name)}.value` : inputNames.get(name)!;
    return "default" in prop ? `(${input} === undefined ? ${literalValueSource(prop.default)} : ${input})` : input;
  };
  const selectorSource = (name: string): string | undefined => {
    const selector = definition.contract.props[name];
    // A selecting prop is a finite ordinary type. Read its accepted value without
    // depending on the aggregate checkedProps, which also reads this selected input.
    return selector === undefined ? code.get(name)
      : `checkedProp(${inputSource(name)}, ${JSON.stringify(normalizeType(selector.type))}, ${selector.required}, ${quote(name)}, acceptedProps, inputAccepted, false)`;
  };
  const literalInputName = freshIdentifier("htmlNextLiteralInput");
  // Native HTML parses the model once, while selected-type validity follows the current selector.
  const literalInitialsName = freshIdentifier("htmlNextLiteralInitials");
  const propTypeSource = (prop: (typeof target.props)[number], binding = false): string => {
    const select = prop.contract.select;
    if (select === undefined) return JSON.stringify(normalizeType(prop.contract.type));
    return `${binding ? "selectedBindingNode" : "selectedPropNode"}(${selectorSource(select.from)}, ${literalValueSource(select.options)})`;
  };
  const selectedInputSources = target.props.flatMap((prop) => {
    const input = selectedInputs.get(prop.name);
    if (input === undefined) return [];
    return [
      `const ${input.retain} = retainedBindingInput((value: unknown) => { acceptedProps[${quote(prop.name)}] = value; }, ${"default" in prop.contract ? literalValueSource(prop.contract.default) : "null"}${structuredReader(prop.name)});`,
      `let ${inputNames.get(prop.name)} = $derived.by(() => ${input.retain}((rest[${quote(BINDING_INPUTS_PROP)}] as Record<string, () => { value: unknown; attribute: string | undefined } | symbol> | undefined)?.[${quote(prop.name)}], () => ({ value: ${literalInputName}(${quote(prop.name)}, ${input.raw}, ${selectorSource(prop.contract.select!.from)}, true), raw: (rest[${quote(LITERAL_INPUTS_PROP)}] as Record<string, { raw: unknown }> | undefined)?.[${quote(prop.name)}]?.raw ?? ${input.raw} ?? null, html: Object.hasOwn((rest[${quote(LITERAL_INPUTS_PROP)}] as object | undefined) ?? {}, ${quote(prop.name)}) }), ${propTypeSource(prop, true)}));`,
    ];
  });
  const checkedPropSources = target.props.map((prop) =>
    `    ${objectKey(prop.name)}: checkedProp<${typeSource(prop.contract.type)}>(${inputSource(prop.name)}, ${propTypeSource(prop)}, ${prop.contract.required}, ${quote(prop.name)}, acceptedProps, inputAccepted, false),`);
  const stateSources = states.map((state) =>
    `let ${code.get(state.name)!} = $state<${typeScript(scope.types.get(state.name)!)}>(${state.expression === undefined ? "null" : lowering.value(state.expression.ast, scope)});`);
  const computedSources = computed.map((value) => {
    const read = value.expression === undefined ? { source: "null", invalid: false }
      : conformingRead(value.expression, scope, context, lowering.value(value.expression.ast, scope));
    const type = typeScript(scope.types.get(value.name)!);
    return `const ${computedNames.get(value)!}: { get(): ${type} } = cycleCheckedComputed<${type}>(() => (${read.invalid
      ? retained(context, read.source, "null as any") : read.source}) as ${type});`;
  });
  const handlerSources = handlers.map((handler) => `function ${handlerNames.get(handler.name)!}(): void {\n${handler.steps.map((step, index) => {
    const handlerScope = scope;
    const condition = step.guard === undefined ? undefined : conformingCondition(step.guard, handlerScope, lowering, context);
    const guardName = condition === undefined ? undefined : context.freshIdentifier("htmlNextGuard");
    const guard = condition === undefined ? "" : `const ${guardName} = ${condition.source}; if (${condition.invalid ? `(${guardName} as unknown) !== Symbol.for('html-next.invalid-result') && ` : ""}${guardName}) `;
    if (step.kind === "dispatch") {
      const declaration = target.events.find((event) => event.name === step.event);
      if (declaration === undefined) fail("HT034", `Handler \`${handler.name}\` dispatches undeclared event \`${step.event}\`.`);
      const detail = context.freshIdentifier(`htmlNextDetail${index}`);
      const source = step.value === undefined ? "undefined" : conformingRead(step.value, handlerScope, context, lowering.value(step.value.ast, handlerScope)).source;
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
    const check = handlerDestinationCheck(declarationTypeNode(state.type, state.shape), step.writablePath, 1, next, handlerScope, lowering, (type, value) => strictTypeCheck(type, value, context));
    const destination = scope.code.get(state.name)!;
    const write = step.writablePath.length === 1 ? `${destination} = ${next} as typeof ${destination};`
      : `${context.writePathName}(${destination}, [${step.writablePath.slice(1).map((segment) => typeof segment === "object"
        ? lowering.value(segment.expression, handlerScope) : JSON.stringify(segment)).join(", ")}], ${next});`;
    const read = conformingRead(step.value, handlerScope, context, lowering.value(step.value.ast, handlerScope));
    return `  ${guard}{ const ${next}: unknown = ${read.source}; if (${next} !== Symbol.for('html-next.invalid-result')${check === undefined ? "" : ` && (${next} === undefined || ${check})`}) { ${write} } }`;
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
  const initialBindingMap = freshIdentifier("htmlNextBindingDefaults");
  const nativeRoot = definition.root?.kind !== "component";
  const initialBindingSources = !nativeRoot ? [] : (context.rootBindings ?? []).map((name) => {
    const candidate = context.freshIdentifier("htmlNextInitialValue");
    const local = unknownValueScope(candidate);
    const serialized = lowering.attribute({ kind: "id", name: candidate }, local, name);
    return `[${quote(name)}]: ${context.initialBindingReadName}(${quote(name)}, (${candidate}: unknown) => ${candidate} === Symbol.for('html-next.invalid-result') ? undefined : ${serialized})`;
  });
  const dataSources = data.map((declaration) => {
    if (declaration.source === undefined) return `const ${dataNames.get(declaration)!} = { pending: true, value: null, error: null, ok: false };`;
    const parameters = declaration.parameters.map((parameter) => {
      const read = conformingRead(parameter.expression, scope, context, lowering.value(parameter.expression.ast, scope));
      return `{ name: ${quote(parameter.name)}, mode: ${quote(parameter.mode)}, read: () => ${read.source} }`;
    }).join(", ");
    return `const ${dataNames.get(declaration)!} = useDataRead<${dataTypes.get(declaration)!}>({ root: () => rootElement ?? null, source: ${quote(declaration.source)}, definition: ${quote(definition.source.file)}, ${declaration.type === undefined ? "" : `type: ${quote(declaration.type)}, `}${declaration.debounce === undefined ? "" : `debounce: ${parseDuration(declaration.debounce)}, `}${declaration.poll === undefined ? "" : `poll: ${parseDuration(declaration.poll)}, `}parameters: [${parameters}] });`;
  });
  const formatBinding = freshIdentifier("htmlNextFormatValue");
  const moduleFallbacks = lowering.moduleFallbacks(formatBinding);
  const script = [
    `<script lang="ts"${generics.length === 0 ? "" : ` generics=${quote(generics.map(({ declaration }) => declaration.replaceAll('"', "'")).join(", "))}`}>`,
    'import type { Snippet } from "svelte";',
    ...(moduleFallbacks.length === 0 ? [] : [`const formatValue = ${formatBinding};`]),
    `import type { HTMLAttributes as ${nativeAttributes} } from "svelte/elements";`,
    ...(nestedDepthLimit !== undefined || states.length > 0 || contexts.length > 0 || context.imports.size > 0 ? ['import { getContext, setContext } from "svelte";'] : []),
    ...(hasProps || (options.rootBindings?.length ?? 0) > 0 || context.usesControls || context.usesAttributeBinding || context.usesSampledSlots || context.usesInvocationClasses || scope.preservesRootFocus ? ['import { untrack } from "svelte";'] : []),
    ...(usesController ? [`import { useComponentHost } from ${quote(options.hostSpecifier ?? "./host.svelte")};`] : []),
    ...(computed.length > 0 ? [`import { cycleCheckedComputed } from ${quote(options.reactivitySpecifier ?? "./reactivity.svelte")};`] : []),
    ...(data.some((declaration) => declaration.source !== undefined) ? [`import { useDataRead } from ${quote(options.dataSpecifier ?? "./data.svelte")};`] : []),
    ...(context.usesControls ? [`import { attachGenericBinding, attachBoundControl, syncBoundControl, controlDefaults, prepareHydrationControls, observeBoundOptions, type BoundDefaults } from ${quote(options.controlSpecifier ?? "./control")};`] : []),
    ...(context.usesEvents ? [`import { attachNativeEvents${target.events.length === 0 ? "" : ", dispatchDeclared"} } from ${quote(options.eventsSpecifier ?? "./events")};`] : []),
    ...(context.htmlSites === 0 ? [] : [`import { retainedSanitizedHtml } from ${quote(options.htmlSpecifier ?? "./html")};`]),
    ...(context.usesDecorations ? [`import { classText, type Decoration } from ${quote(options.decorationsSpecifier ?? "./decorations")};`] : []),
    ...(context.usesStyleDecorations ? [`import { styleText } from ${quote(options.styleSpecifier ?? "./style/style.js")};`] : []),
    ...((context.usesComponentBindings || context.usesDeclaredFormats) ? [`import { acceptsBindingDestination } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...(hasProps ? [`import { checkedProp, mountPropValidity, updatePropValidity${usesController ? ", propValidityState" : ""}${selectors.length === 0 ? "" : ", selectedPropNode, selectedBindingNode, retainedBindingInput, htmlPropValue"}${structuredInputs.size > 0 ? ", parseHtmlLiteral" : ""} } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
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
    ...(context.imports.size === 0 ? [] : [
      // A parent without its own controls must give siblings the same capture owner.
      `if (getContext(${quote(CONTROL_CAPTURE_CONTEXT)}) === undefined) setContext(${quote(CONTROL_CAPTURE_CONTEXT)}, { prepared: false });`,
    ]),
    ...(context.usesControls ? ["prepareHydrationControls();"] : []),
    `type Props = Omit<${nativeAttributes}<${rootType}>, ${omittedNative.map(quote).join(" | ")}> & { ${propTypes} ${eventCallbacks.map((event) => `${quote(event.name)}?: ${event.type};`).join(" ")} ${publicChildren ? "" : "children?: Snippet;"} ${publicSlots ? "" : `slots?: ${slotsType};`} [key: string]: unknown; };`,
    `let { ${[destructured, ...internalProps, `...${rawRest}`].filter(Boolean).join(", ")} }: Props = $props();`,
    `const rest = ${rawRest} as Record<string, unknown>;`,
    ...(publicSlots ? [`let slots = $derived(rest[${quote(SLOTS_PROP)}] as Record<string, Snippet<[Record<string, any>]> | null> | undefined);`] : []),
    ...(initialBindingSources.length === 0 ? [] : [
      `function ${context.nativeBindingReadName}(name: string): (() => unknown) | undefined {`,
      `  const bindings = rest[${quote(NATIVE_BINDINGS_PROP)}] as Record<string, () => unknown> | undefined;`,
      "  return bindings != null && Object.hasOwn(bindings, name) ? bindings[name] : undefined;",
      "}",
      `const ${initialBindingMap} = new Map<string, unknown>();`,
      `function ${context.initialBindingReadName}(name: string, serialize: (value: unknown) => unknown): unknown {`,
      `  const read = ${context.nativeBindingReadName}(name);`,
      "  if (read === undefined) return undefined;",
      `  if (!${initialBindingMap}.has(name)) ${initialBindingMap}.set(name, untrack(() => serialize(read())));`,
      `  return ${initialBindingMap}.get(name);`,
      "}",
      `let ${context.initialBindingsName} = $derived.by(() => ({ ${initialBindingSources.join(", ")} }));`,
      `function ${context.rootBindingAttributeName}(name: string): unknown {`,
      `  return untrack(() => rootElement === undefined ? (${context.initialBindingsName} as Record<string, unknown>)[name] : rootElement.getAttribute(name) ?? undefined);`,
      "}",
    ]),
    // Svelte's spread path normalizes these names through an inherited object property.
    // Keep ordinary passthrough attrs native to Svelte; write only these names with the DOM API.
    `const rootAttrs = $derived.by(() => { const attrs = Object.assign(Object.create(null) as Record<string, unknown>, rest); ${nativeRoot ? `Reflect.deleteProperty(attrs, ${quote(NATIVE_BINDINGS_PROP)}); ` : ""}${initialBindingSources.length === 0 ? "" : `if (typeof document === 'undefined') for (const [name, value] of Object.entries(${context.initialBindingsName})) { if (value !== undefined) attrs[name] = value; } `}Reflect.deleteProperty(attrs, ${quote(ROOT_OWNER_PROP)}); Reflect.deleteProperty(attrs, ${quote(DECORATIONS_PROP)}); Reflect.deleteProperty(attrs, ${quote(BINDING_INPUTS_PROP)}); ${hasProps ? `Reflect.deleteProperty(attrs, ${quote(LITERAL_INPUTS_PROP)}); ` : ""}${publicSlots ? `Reflect.deleteProperty(attrs, ${quote(SLOTS_PROP)}); ` : ""}${[...context.rootAttributeBindings].map((name) => `delete attrs[${quote(name)}];`).join(" ")} if (typeof document !== 'undefined') { ${nativeRoot ? (context.rootBindings ?? []).map((name) => `Reflect.deleteProperty(attrs, ${quote(name)});`).join(" ") : ""} Reflect.deleteProperty(attrs, 'constructor'); Reflect.deleteProperty(attrs, '__proto__'); } return attrs; });`,
    "let rootElement = $state<Element | undefined>(undefined);",
    ...(scope.preservesRootFocus ? ["let rootFocusPending = false;"] : []),
    "let specialElement: Element | undefined;",
    "let hadConstructor = false;",
    "let hadProto = false;",
    "$effect(() => {",
    "  const element = rootElement;",
    "  if (element === undefined) return;",
    "  if (element !== specialElement) { specialElement = element; hadConstructor = false; hadProto = false; }",
    "  const constructorValue: unknown = rest.constructor;",
    "  const constructor = Object.keys(rest).includes('constructor') && constructorValue != null && constructorValue !== false;",
    "  if (constructor) element.setAttribute('constructor', String(constructorValue));",
    "  else if (hadConstructor) element.removeAttribute('constructor');",
    "  hadConstructor = constructor;",
    "  const protoValue: unknown = rest.__proto__;",
    "  const proto = Object.keys(rest).includes('__proto__') && protoValue != null && protoValue !== false;",
    "  if (proto) element.setAttribute('__proto__', String(protoValue));",
    "  else if (hadProto) element.removeAttribute('__proto__');",
    "  hadProto = proto;",
    "});",
    ...(context.implicitOptionValueName === undefined ? [] : [
      `function ${context.implicitOptionValueName}(value: unknown): string {`,
      "  const text = String(value ?? '');",
      // Native option values collapse only ASCII whitespace; NBSP is significant.
      "  return /^[\\t\\n\\f\\r ]|[\\t\\n\\f\\r ]$|[\\t\\n\\f\\r]| {2}/.test(text) ? text.replace(/[\\t\\n\\f\\r ]+/g, ' ').replace(/^ | $/g, '') : text;",
      "}",
    ]),
    ...(context.usesControls ? [
      `function ${context.controlAttachmentName}(name: "value" | "checked", read: () => unknown, defaults: BoundDefaults, update?: (value: unknown) => void, options: { nativeProperty?: boolean; observeOptions?: boolean } = {}) {`,
      "  const { nativeProperty = false, observeOptions = true } = options;",
      "  return (element: Element) => {",
      "    const authored = controlDefaults(element, defaults);",
      "    const initial = untrack(read);",
      "    const dispose = attachBoundControl(element, name, initial, authored, update, nativeProperty, initial !== Symbol.for('html-next.invalid-result'));",
      "    $effect(() => { const value = read(); syncBoundControl(element, name, value, authored, nativeProperty, value !== Symbol.for('html-next.invalid-result')); });",
      "    const stop = observeOptions ? observeBoundOptions(element, () => { const value = untrack(read); syncBoundControl(element, name, value, controlDefaults(element, defaults), nativeProperty, value !== Symbol.for('html-next.invalid-result'), true); }) : undefined;",
      "    return () => { dispose?.(); stop?.(); };",
      "  };",
      "}",
    ] : []),
    ...(context.usesInvocationClasses ? [
      `function ${context.initialClassName}(base: string | undefined, decorations: readonly Decoration[]): string | undefined {`,
      "  return untrack(() => classText(base, decorations));",
      "}",
    ] : []),
    ...(context.usesDecorationAttachment ? [
      `function ${context.decorationAttachmentName}(decorations: readonly Decoration[]) {`,
      "  return (element: Element) => {",
      "    for (const decoration of decorations) $effect(() => {",
      "      const value = decoration.read();",
      "      if (value === Symbol.for('html-next.invalid-result')) return;",
      "      if (decoration.kind === 'class') element.classList.toggle(decoration.name, Boolean(value));",
      "      else (element as HTMLElement).style.setProperty(decoration.name, value == null ? '' : String(value));",
      "    });",
      "  };",
      "}",
    ] : []),
    ...(context.usesScopedSlots ? [
      `function ${context.checkedSlotName}(slot: Snippet<[any]> | null | undefined, name: string) {`,
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
      `function ${context.bindingHelperName}(name: string, read: () => unknown, update?: (value: any) => void, initialize = false) {`,
      "  return (element: Element) => {",
      "    const apply = (value: unknown) => {",
      "      if (value === Symbol.for('html-next.invalid-result')) return;",
      "      if (value == null) element.removeAttribute(name);",
      "      else element.setAttribute(name, String(value));",
      "    };",
      "    // Options must expose their initial DOM value before the parent select binding runs.",
      "    if (initialize) apply(untrack(read));",
      "    $effect(() => apply(read()));",
      ...(context.usesControls ? ["    return update === undefined ? undefined : attachGenericBinding(element, update);"] : []),
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
        "function retainedStructuralValue(): <T>(candidate: T | symbol) => { ready: boolean; value: T } {",
        "  let ready = false;",
        "  let previous: unknown;",
        "  return function<T>(candidate: T | symbol) {",
        "    if (candidate !== Symbol.for('html-next.invalid-result')) { ready = true; previous = candidate; }",
        "    return { ready, value: previous as T };",
        "  };",
        "}",
      ] : []),
      ...[...context.retentions].filter(([site]) => !context.localRetentions.has(site))
        .map(([site, entry]) => `const retained${site} = ${entry.initial === undefined ? "retainedStructuralValue()" : `retainedValue(${entry.initial})`};`),
    ]),
    ...(hasProps ? [
      `const acceptedProps: Record<string, unknown> = { ${target.props.map((prop) => `${objectKey(prop.name)}: ${"default" in prop.contract ? literalValueSource(prop.contract.default) : "null"}`).join(", ")} };`,
      "const inputAccepted = Object.create(null) as Record<string, boolean>;",
      ...(selectedInputs.size === 0 ? [] : [
        `const ${literalInitialsName} = new Map<string, unknown>();`,
        `function ${literalInputName}(name: string, initial: unknown, selector: unknown, once = false): unknown {`,
        `  const literals = rest[${quote(LITERAL_INPUTS_PROP)}] as Record<string, { options?: readonly (readonly [unknown, unknown])[] }> | undefined;`,
        "  const literal = literals !== undefined && Object.hasOwn(literals, name) ? literals[name] : undefined;",
        "  if (literal === undefined) return initial;",
        `  if (once && ${literalInitialsName}.has(name)) return ${literalInitialsName}.get(name);`,
        "  const option = literal.options?.find(([value]) => value === selector);",
        "  const value = option === undefined ? initial : option[1];",
        `  if (once) ${literalInitialsName}.set(name, value);`,
        "  return value;",
        "}",
      ]),
      ...selectedInputSources,
      "let checkedProps = $derived.by(() => ({",
      ...checkedPropSources,
      "}));",
      `const propValidityContract = ${literalValueSource(validityContract)} as const;`,
      `let propInputValues = $derived.by(() => ({ ...checkedProps, ${target.props.map((prop) => `${objectKey(prop.name)}: ${selectors.includes(prop.name) ? `checkedProps[${quote(prop.name)}]` : prop.contract.select === undefined ? inputSource(prop.name) : `(${inputNames.get(prop.name)}.html && rest[${quote(BINDING_INPUTS_PROP)}] !== undefined && Object.hasOwn(rest[${quote(BINDING_INPUTS_PROP)}] as object, ${quote(prop.name)}) ? htmlPropValue(${inputNames.get(prop.name)}.raw, ${propTypeSource(prop, true)}${structuredReader(prop.name)}) : ${inputNames.get(prop.name)}.html ? ${literalInputName}(${quote(prop.name)}, ${inputSource(prop.name)}, ${selectorSource(prop.contract.select.from)}) : ${inputSource(prop.name)})`}`).join(", ")}${selectors.filter((name) => definition.contract.props[name] === undefined).map((name) => `, ${objectKey(name)}: ${code.get(name)}`).join("")} }));`,
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
    ...dataSources,
    ...computedSources,
    ...(scope.preservesRootFocus ? [
      "$effect.pre(() => {",
      ...focusReads,
      "  untrack(() => { rootFocusPending = rootElement !== undefined && rootElement.ownerDocument.activeElement === rootElement; });",
      "});",
    ] : []),
    ...Array.from({ length: context.htmlSites }, (_, index) => index)
      .filter((site) => !context.localHtmlSites.has(site))
      .map((site) => `const htmlSite${site} = ${retainedHtmlSource(context, site)};`),
    ...(styles.stateNames.length === 0 ? [] : [
      HOST_STATE_TOKENS_SOURCE,
      `let hostState = $derived([${styles.stateNames.map((state) => `...hostStateTokens(${quote(state)}, ${code.get(state) ?? state})`).join(", ")}].join(" "));`,
    ]),
    ...(context.refs.size === 0 && !usesController ? [] : [
      `const ${context.refsName} = new Map<string, Element | Element[]>();`,
      `function ${context.refAttachmentName}(name: string) {`,
      "  let current: Element | undefined;",
      "  return (element: Element) => {",
      ...(iteratedRefs.size > 0 ? [
        `    if (${JSON.stringify([...iteratedRefs])}.includes(name)) {`,
        `      const recorded = ${context.refsName}.get(name) as Element[] | undefined;`,
        "      const index = current === undefined ? -1 : recorded?.indexOf(current) ?? -1;",
        `      if (recorded === undefined) ${context.refsName}.set(name, [element]);`,
        "      else if (index >= 0) recorded[index] = element;",
        "      else recorded.push(element);",
        `    } else ${context.refsName}.set(name, element);`,
      ] : [`    ${context.refsName}.set(name, element);`]),
      "    current = element;",
      "  };",
      "}",
      `function ${context.refTargetName}(name: string): Element | undefined {`,
      `  const recorded = ${context.refsName}.get(name);`,
      "  return Array.isArray(recorded) ? recorded[0] : recorded;",
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
      `  ownsRoot: () => rest[${quote(ROOT_OWNER_PROP)}] !== true,`,
      `  definition: ${quote(definition.source.file)}, tag: ${quote(definition.contract.tag)}, controller: ${quote(options.controllerSpecifier ?? definition.controller!)},`,
      `  props: () => ${hasProps ? "checkedProps" : "({})"}, propNames: ${JSON.stringify(target.props.map((prop) => prop.name))},`,
      ...(hasProps ? [
        `  propInputs: (name: string) => { ${target.props.filter((prop) => selectedInputs.has(prop.name)).map((prop) => `if (name === ${quote(prop.name)}) return ${inputNames.get(prop.name)}.raw;`).join(" ")} const literal = rest[${quote(LITERAL_INPUTS_PROP)}] as Record<string, { raw: unknown }> | undefined; return literal !== undefined && Object.hasOwn(literal, name) ? literal[name]!.raw : ({ ${target.props.filter((prop) => !selectedInputs.has(prop.name)).map((prop) => `${objectKey(prop.name)}: ${inputNames.get(prop.name)} ?? null`).join(", ")} } as Record<string, unknown>)[name]; },`,
        "  propValidity: (name: string) => propValidityState({ contract: propValidityContract, values: propInputValues }, name),",
      ] : []),
      `  state: { ${states.map((state) => `${objectKey(state.name)}: { get: () => ${code.get(state.name)}, set: (value: unknown) => { ${code.get(state.name)} = value as typeof ${code.get(state.name)}; } }`).join(", ")} },`,
      `  computed: { ${[...computed, ...data, ...contexts].map((value) => { const name = value.kind === "context" ? value.as ?? value.name : value.name; return `${objectKey(name)}: () => ${code.get(name)}`; }).join(", ")} },`,
      `  refs: ${context.refsName},`,
      `  dispatch: (root: Element, name: string, detail?: unknown) => { switch (name) { ${target.events.map((event) => `case ${quote(event.name)}: return dispatchDeclared(root, name, detail, ${JSON.stringify(declarationTypeNode(event.type, event.shape))}, ${JSON.stringify({ bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable })});`).join(" ")} default: return root.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false })); } },`,
      `  methods: ${JSON.stringify(target.methods.map((method) => ({ name: method.name, exportName: method.exportName })))},`,
      "});",
    ] : []),
    ...target.methods.map((method) => {
      const alias = methodNames.get(method.name)!;
      const result = usesController ? `${controllerHostName}.invoke(${quote(method.name)}, ...args)`
        : `Promise.reject(new TypeError(${quote(`Controller method \`${method.name}\` is not ready for <${definition.contract.tag}>.`)}))`;
      return `const ${alias} = (...args: unknown[]): Promise<Awaited<${method.returnType}>> => ${result} as Promise<Awaited<${method.returnType}>>;\nexport { ${alias} as ${isScriptIdentifier(method.name) ? method.name : quote(method.name)} };`;
    }),
    ...(!usesController && target.methods.length > 0 ? [
      "$effect(() => {",
      `  const element = rootElement; if (element === undefined || rest[${quote(ROOT_OWNER_PROP)}] === true) return;`,
      ...target.methods.map((method) => `  Object.defineProperty(element, ${quote(method.name)}, { configurable: true, enumerable: false, value: ${methodNames.get(method.name)} });`),
      "});",
    ] : []),
    ...handlerSources,
    ...lowering.fallbacks(),
  ].join("\n").replace(/<\/script/gi, "<\\/script") + "\n</script>";
  return { component: `${moduleFallbacks.length === 0 ? "" : `<script module lang="ts">\n${moduleFallbacks.join("\n").replace(/<\/script/gi, "<\\/script")}\n</script>\n`}${script}\n${markup}\n`, css, usesHtml: context.htmlSites > 0,
    helpers: [
      ...(hasProps || context.usesComponentBindings || context.usesDeclaredFormats || target.events.length > 0 ? ["props" as const] : []),
      ...(context.htmlSites > 0 ? ["html" as const] : []),
      ...(context.usesEvents ? ["events" as const] : []),
      ...(context.usesControls ? ["control" as const] : []),
      ...(context.usesDecorations ? ["decorations" as const] : []),
      ...(context.usesStyleDecorations ? ["style" as const] : []),
      ...(data.some((declaration) => declaration.source !== undefined) ? ["data" as const] : []),
      ...(usesController ? ["host" as const] : []),
      ...(usesController || data.some((declaration) => declaration.source !== undefined) ? ["connection" as const] : []),
      ...(computed.length > 0 || usesController ? ["reactivity" as const] : []),
    ] };
}
