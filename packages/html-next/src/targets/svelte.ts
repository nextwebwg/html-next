import { entryTags } from "../entry-origin.js";
import { literalValueSource } from "./shared.js";
import { ITERATION_INDEX } from "../expression.js";
import { attributeNamespace } from "../dom-attributes.js";
import { referenceContext, referenceType, uncheckedReferences, withReferenceTypes } from "./reference-types.js";
/** Svelte 5 output from the shared, checked component definition. */
import { bindingRevertSource, controllerInitials, revertSource, withRevert } from "./state-roots.js";
import { fail } from "../diagnostics.js";
import type { CompiledExpression } from "../expression.js";
import { compileComponentStylesForSvelte, componentStateNames, VUE_ROOT_ATTRIBUTE } from "../component-styles-build.js";
import { asciiLowerCase, kebabCase, componentName, propAttribute } from "../names.js";
import { invocationValue } from "../prop-values.js";
import { declarationTypeNode, normalizeType, parseTypedValue, parseTypeExpression, type TypeNode } from "../type-system.js";
import { definitionMayInvokeComponents, elementMatchRoot, iteratedRefNames, rootArms, repeatedSlotNames } from "../template.js";
import { parseDuration } from "../duration.js";
import { getDomInterface } from "../platform.js";
import { templateForwardsAttributes } from "../template.js";
import type { ComponentDefinition, ContextDeclaration, DataDeclaration, ElementNode, HandlerDeclaration, ReactiveDeclaration, SlotNode, SlotContract, TemplateNode } from "../template.js";
import type { PropContract } from "../types.js";
import { propInputOrder, targetComponent } from "./backend.js";
import { declaresHead, headEntriesSource, headScriptsSource } from "./head-target.js";
import { frameworkRequestSource, REQUEST_CHECK, REQUEST_HELPERS, REQUEST_TYPES, requestListenerType, respondersSource, responderType } from "./requests-target.js";
import { condenseWhitespace, escapeHtml, isEdgeSpace, literalAttribute, isScriptIdentifier, isVoidElement, isNativeBooleanAttribute, objectKey, quote, svgAttributeName, selectorGenerics, dependentPropTypeSource, SLOT_PROP_IMPORT, slotPropValueSource, slotPropDefaultSource, slotPropsType, typeSource, SSR_BOOLEAN_PROPERTIES, SSR_STRING_PROPERTIES } from "./shared.js";
import { inputScope, Lowering, category, mayProduceInvalidResult, present, provenSlotProp, type Scope, slotPropStatic, type Static, typeOf, typeScript } from "./vue-lowering.js";
import { declaredReferenceGuard, handlerDestinationCheck, increment, provenWrite, refusing, writeCheck } from "./type-guards.js";
import { CONTROL_CAPTURE_CONTEXT } from "./svelte-control.js";
import { BINDING_INPUTS_PROP, ENTRY_PROP, LISTS_PROP, LITERAL_INPUTS_PROP, NATIVE_BINDINGS_PROP, ROOT_OWNER_PROP, SLOTS_PROP, SVELTE_RENDER_COMPONENTS, SVELTE_RENDER_EXPORTS, SVELTE_RENDER_SPECIFIER } from "./svelte-render.js";
import { BINDING_INPUTS_PROP as STATUS_INPUTS_PROP } from "../prop-inputs.js";
import { formatSvelteScript, jsxAttributeRecord } from "./vue-format.js";
import { invocationSchema } from "./invocation-attributes.js";
import { isStyleWrite, styleWriteRules } from "./style-writes.js";
import { SVELTE_CONTEXT_SPECIFIER } from "./svelte-context.js";

function hasStructuredHtmlInput(type: TypeNode): boolean {
  if (type.kind === "constrained") return hasStructuredHtmlInput(type.base);
  if (type.kind === "union") return type.members.some(hasStructuredHtmlInput);
  return type.kind === "list" || type.kind === "record" || type.kind === "object";
}

function unknownValueScope(name: string): Scope {
  return { code: new Map([[name, name]]), types: new Map([[name, { type: { kind: "terminal", name: "unknown" }, nullable: true }]]) };
}


export interface SvelteConversionOptions {
  readonly modulePreparation?: { readonly source: string };
  readonly bindingsSpecifier?: string;
  /**
   * The linked graph's definitions, by tag. A `:state()` condition on another component resolves
   * against them, and the component's root carries the states their styles test on it.
   */
  readonly componentGraph?: ReadonlyMap<string, ComponentDefinition>;
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  readonly importSpecifier?: (tag: string) => string;
  readonly rootBindings?: readonly string[] | undefined;
  readonly decorationsSpecifier?: string;
  readonly styleSpecifier?: string;
  readonly propsSpecifier?: string;
  readonly attributesSpecifier?: string;
  readonly htmlSpecifier?: string;
  readonly eventsSpecifier?: string;
  readonly controlSpecifier?: string;
  readonly dataSpecifier?: string;
  readonly guardNestedDepth?: boolean;
  readonly reactivitySpecifier?: string;
  readonly hostSpecifier?: string;
  readonly connectionSpecifier?: string;
  readonly renderSpecifier?: string;
  /** The states a `<context>` reader can read, from `publishedStates`; without it, every state is published. */
  readonly publishedStates?: ReadonlySet<string> | undefined;
  /** The request steps, which a component that declares requests imports. */
  readonly requestsSpecifier?: string;
  readonly headSpecifier?: string;
  readonly controllerSpecifier?: string;
  readonly propContractsByTag?: ReadonlyMap<string, Readonly<Record<string, PropContract>>>;
  /** The component `<slot of>` outlets render a child's slot content in (`svelte-context.ts`). */
  readonly contextSpecifier?: string;
}

export interface SvelteConversionOutput {
  readonly component: string;
  readonly usesHtml: boolean;
  readonly helpers: readonly ("attributes" | "bindings" | "props" | "html" | "events" | "control" | "data" | "reactivity" | "host" | "connection" | "decorations" | "style" | "render" | "requests" | "head" | "context")[];
}

/** A value Svelte reads as written in a quoted attribute: no entity, brace, quote or edge space. */
const PLAIN_ATTRIBUTE = /^[\w.,:;/#%+=@!?()-]+(?: [\w.,:;/#%+=@!?()-]+)*$/;

function nativeControlBinding(tag: string, name: string): boolean {
  return ["input", "textarea", "select"].includes(tag) &&
    (name === "value" || name === "checked" && tag === "input");
}


function componentPropAttribute(name: string, value: string): string {
  return name === "__proto__" ? `{...{ __proto__: null, ...{ ${objectKey(name)}: ${value} } }}` : `${name}={${value}}`;
}

function caseSensitiveAttribute(name: string): boolean {
  return name.toLowerCase() !== asciiLowerCase(name);
}

function nativeAttribute(name: string, value: string, context: RenderContext): readonly string[] {
  if (!caseSensitiveAttribute(name)) return [`${name}={${value}}`];
  context.usesAttributeBinding = true;
  return [`{...(typeof document === 'undefined' ? { ${objectKey(name)}: ${value} } : {})}`, `{@attach ${context.bindingHelperName}(${quote(name)}, () => ${value})}`];
}

/** Match native projection marking so controllers can act on rendered slot content. */
function projectedNode(node: TemplateNode): TemplateNode {
  if (node.kind !== "element") return node;
  // A `<template>` with a directive renders its children in its place, and they are the projected content.
  if (node.name === "template" && node.flow !== undefined) return { ...node, children: node.children.map(projectedNode) };
  // The writing component's stamp (`stampProjected`) stays, so its styles keep reaching the element.
  if (node.attributes.some(attribute => attribute.kind === "literal" && attribute.name === "data-slotted")) return node;
  return { ...node, attributes: [...node.attributes.filter(attribute => attribute.name !== "data-slotted"),
    { kind: "literal", name: "data-slotted", value: "" }] };
}

/** Omit native elements and visible text at an accepting outlet, through structural templates. */
function acceptedProjection(nodes: readonly TemplateNode[]): TemplateNode[] {
  return nodes.flatMap((node): TemplateNode[] => {
    if (node.kind === "text") return node.expressionPlan === undefined && node.segments === undefined && !/[^\t\n\f\r ]/.test(node.value) ? [node] : [];
    if (node.kind === "slot") return [node];
    if (node.name === "template") return [{ ...node, children: acceptedProjection(node.children) }];
    return node.name.includes("-") ? [node] : [];
  });
}

function literalPropValue(value: string, contract: PropContract): string {
  const type = normalizeType(contract.type);
  const parsed = value === "" && type.kind === "terminal" && type.name === "boolean"
    ? { ok: true as const, value: true }
    : parseTypedValue(value, contract.type, "$", "html");
  return parsed.ok ? literalValueSource(parsed.value) : `${quote(value)} as any`;
}

/** A missing class base differs from an authored empty class attribute. `scope` precedes the authored classes. */
function classBaseSource(node: ElementNode, root: boolean, scope: readonly string[]): string {
  const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "class");
  const empty = literal?.kind === "literal" ? quote("") : "undefined";
  const authored = [...scope, ...literal?.kind === "literal" ? [literal.value] : []].join(" ");
  return `([${quote(authored)}].filter(Boolean).join(" ") || ${empty})`;
}

function checkSupported(definition: ComponentDefinition): { importedNames: ReadonlySet<string>; refs: Set<string> } {
  const importedNames = new Set<string>();
  const refs = new Set<string>();
  for (const declaration of definition.declarations ?? []) {
    if (!["state", "computed", "handler", "data", "event", "context"].includes(declaration.kind)) {
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
  usesHtmlInputs?: boolean;
  usesInputStatus?: boolean;
  usesInputExpressions?: boolean;
  readonly observe: (scope: Scope) => Scope;
  readonly availability: ReadonlyMap<string, string>;
  readonly lowering: Lowering;
  readonly definition: ComponentDefinition;
  readonly imports: Set<string>;
  readonly handlerNames: ReadonlyMap<string, string>;
  readonly inputNames: ReadonlyMap<string, string>;
  readonly slotsByTag?: SvelteConversionOptions["slotsByTag"];
  usesScopedSlots: boolean;
  usesSlotPropChecks?: boolean;
  readonly propContractsByTag?: SvelteConversionOptions["propContractsByTag"];
  readonly componentGraph?: SvelteConversionOptions["componentGraph"];
  /** Each enclosing `$each` row's key, or its index without one, as the row reads it. */
  readonly eachKeys: string[];
  /**
   * The children an `as` list holds, by their `children` array (which a lowered copy of the element
   * keeps): the list's name, the child's place, how many `eachKeys` enclose the list, and the slots
   * the list renders for it, which the child's own invocation leaves out.
   */
  readonly listedChildren: Map<readonly TemplateNode[], { readonly list: string; readonly place: number; readonly depth: number; readonly slots: ReadonlySet<string> }>;
  usesChildOutlets: boolean;
  readonly plainSlots: ReadonlySet<string>;
  /** A bound prop of an accepted child's entry is checked as the child checks it (`checkListedProp`). */
  usesEntryChecks?: boolean;
  /** Each `<slot of>` outlet's props, by accepted tag, as the child's slot declaration shapes them. */
  readonly outletProps: string[];
  readonly styleOwner?: string;
  /** The scoped styles' root and limits: the root's tag, and each invoked component's, as classes. */
  readonly hostClass: boolean;
  readonly styledComponents: ReadonlySet<string>;
  /** Scope classes the root takes through its attribute spread, when no class binding writes them. */
  rootScope?: string;
  htmlSites: number;
  readonly localHtmlSites: Set<number>;
  readonly optionHtmlSites: Set<number>;
  readonly retentions: Map<number, { readonly initial?: string }>;
  readonly localRetentions: Set<number>;
  usesAttributeBinding: boolean;
  usesNamespacedAttributes?: boolean;
  usesComponentBindings: boolean;
  usesDeclaredFormats: boolean;
  usesProperties: boolean;
  usesDecorations: boolean;
  usesStyleDecorations: boolean;
  usesDecorationAttachment: boolean;
  readonly rootBindings?: readonly string[] | undefined;
  readonly initialBindingsName: string;
  readonly initialBindingReadName: string;
  readonly nativeBindingReadName: string;
  readonly rootBindingAttributeName: string;
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
  readonly reflectedPropName: string;
  /** Inside <pre> or <textarea>, whose text Svelte keeps exactly, or <option>, whose text is its implicit value. */
  preformatted: boolean;
  readonly freshIdentifier: (base: string) => string;
  /** A template-local name: the authored one, unless the script or a helper already uses it. */
  readonly localName: (authored: string, fallback: string) => string;
}

function strictTypeCheck(type: TypeNode, value: string, context: RenderContext): string {
  context.usesDeclaredFormats = true;
  return `acceptsBindingDestination(${value}, ${JSON.stringify(type)})`;
}

function declaredReadGuard(plan: CompiledExpression, scope: Scope, context: RenderContext): string | undefined {
  return declaredReferenceGuard(plan, scope, context.definition, (type, value) => strictTypeCheck(type, value, context), context.lowering);
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

/** A `$each`'s rows source, its row scope and local names, and its key read in that scope. */
function eachParts(node: ElementNode | SlotNode, scope: Scope, lowering: Lowering, context: RenderContext) {
  const flow = node.flow;
  if (flow?.kind !== "each" || flow.listPlan === undefined) fail("HT030", "A Svelte list needs a checked $each expression.");
  const listNode = flow.listPlan.ast;
  const listType = typeOf(listNode, scope);
  const itemType: Static = listType.type.kind === "list"
    ? { type: present(listType.type.item).type, nullable: false }
    : { type: { kind: "terminal", name: "unknown" }, nullable: false };
  const indexType: Static = { type: { kind: "terminal", name: "number" }, nullable: false };
  // Each row destructures to the names the source gives its item and index.
  const item = context.localName(flow.item, "item");
  const index = context.localName(flow.index ?? "index", "index");
  const scopeWith = (item: string, index?: string): Scope => withReferenceTypes({
    ...scope,
    code: new Map([...scope.code, [flow.item, item], ...(index === undefined ? [] : [...flow.index === undefined ? [] : [[flow.index, index] as const], [ITERATION_INDEX, index] as const])]),
    types: new Map([...scope.types, [flow.item, itemType], ...(index === undefined ? [] : [...flow.index === undefined ? [] : [[flow.index, indexType] as const], [ITERATION_INDEX, indexType] as const])]),
  }, [[flow.item, (() => { const type = referenceType(listNode, scope); return type?.kind === "list" ? type.item : undefined; })()], ...index === undefined ? [] : [[flow.index ?? ITERATION_INDEX, undefined] as const, [ITERATION_INDEX, undefined] as const]]);
  const read = conformingRead(flow.listPlan, scope, context, lowering.value(listNode, scope));
  const stableSource = read.invalid ? retained(context, read.source, "[] as any[]") : read.source;
  // Native structural reads accept absence, even for an initialized declared list.
  const listSource = listType.type.kind === "list" && (listType.nullable || read.invalid) ? `(${stableSource} ?? [])` : stableSource;
  const filterItem = context.freshIdentifier("htmlNextItem");
  const list = lowering.list(listNode, scope, filterItem, {
    ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
    itemScope: scopeWith(filterItem),
    sort: (flow.sortKeys ?? []).map(({ path, descending }) => `${descending ? "-" : ""}${path.join(".")}`),
    ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
  }, listSource);
  const callbackScope = scopeWith(item, index);
  const checked = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list,
    `(${item}, ${index}) => ${lowering.value(flow.keyPlan.ast, callbackScope)}`);
  const rows = lowering.eachRows(checked);
  const rowScope = scopeWith(item, index);
  const keyValue = flow.keyPlan === undefined ? undefined : lowering.value(flow.keyPlan.ast, rowScope);
  return { rows, rowScope, item, index, keyValue };
}

function renderEach(node: ElementNode | SlotNode, scope: Scope, lowering: Lowering, context: RenderContext): string {
  const { rows, rowScope, item, index, keyValue } = eachParts(node, scope, lowering, context);
  const key = keyValue === undefined ? "" : ` (${keyValue})`;
  const { flow: _flow, ...body } = node;
  const firstHtmlSite = context.htmlSites;
  const firstRetention = context.retentions.size;
  const inputs: string[] = [];
  // An accepted child below keys its entry by each enclosing row (`listedChildren`).
  context.eachKeys.push(keyValue ?? index);
  const markup = renderNode(body, false, rowScope, lowering, context, inputs);
  context.eachKeys.pop();
  const declarations = localOwnership(context, firstHtmlSite, firstRetention);
  const content = `${declarations}${inputs.join("")}${markup}`;
  const fields = ([["item", item], ["index", index]] as const)
    .filter(([field, name]) => field === "item" || new RegExp(`\\b${name}\\b`).test(`${key}${content}`))
    .map(([field, name]) => field === name ? field : `${field}: ${name}`);
  return `{#each ${rows} as { ${fields.join(", ")} }${key}}${content}{/each}`;
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function listedNames(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** A plain source made entirely of conditional nodes is assigned while one of them renders. */
function plainSourceCondition(children: readonly TemplateNode[], carrier: ElementNode | undefined, scope: Scope, lowering: Lowering, context: RenderContext): string | undefined {
  if (carrier !== undefined || children.length === 0) return undefined;
  const conditions = children.map(child => child.kind === "element" && child.flow?.kind === "if" && child.flow.testPlan !== undefined
    ? conformingCondition(child.flow.testPlan, scope, lowering, context) : undefined);
  return conditions.every(condition => condition !== undefined && !condition.invalid)
    ? conditions.map(condition => `(${condition!.source})`).join(" || ") : undefined;
}

/**
 * For an invocation of a component whose slot declares `as` (components#slot-accepts-as): each list the
 * consumer builds, as `{@const}` declarations with the snippets its children's slots render through
 * `<slot of>`, and the binding that gives the lists to the component. The list follows the consumer's
 * `$if` and `$each`, so the component reads it complete before it renders, on the server too.
 */
function childListSource(node: ElementNode, scope: Scope, lowering: Lowering, context: RenderContext): { readonly declarations: string; readonly binding: string } | undefined {
  const receiving = context.componentGraph?.get(node.name);
  const lists = Object.entries(receiving?.contract.slots ?? {}).filter(([, slot]) => slot.as !== undefined);
  if (receiving === undefined || lists.length === 0) return undefined;
  let declarations = "";
  const bindings: string[] = [];
  for (const [slotName, declaration] of lists) {
    const accepts = declaration.accepts ?? [];
    const named = `\`${node.name}\`'s ${slotName === "" ? "default slot" : `\`${slotName}\` slot`}`;
    const warning = (message: string): string => quote(`${receiving.source.file}: HR007: ${message}`);
    const list = context.freshIdentifier(`${isScriptIdentifier(declaration.as!) ? declaration.as! : "children"}List`);
    const depth = context.eachKeys.length;
    let place = 0;
    const slotOf = (child: TemplateNode): string => {
      const slot = child.kind === "element" ? child.attributes.find((entry) => entry.kind === "literal" && entry.name === "slot") : undefined;
      return slot?.kind === "literal" ? slot.value : "";
    };
    // Each child's item: its key parts (place, then each enclosing row's key), prop reads and slot
    // snippets; or a warning for content the slot leaves out. `locals` are the rows' names its snippets read.
    const items = (nodes: readonly TemplateNode[], scope: Scope, keys: readonly string[], locals: readonly string[]): string[] => nodes.flatMap((child): string[] => {
      if (child.kind === "text") return child.expressionPlan === undefined && child.segments === undefined && !/[^\t\n\f\r ]/.test(child.value)
        ? [] : [warning(`${named} accepts ${listedNames(accepts)}; this text is left out.`)];
      // ponytail: content forwarded through the consumer's own <slot> is not listed.
      if (child.kind === "slot") return [];
      if (child.flow?.kind === "if") {
        if (child.flow.testPlan === undefined) fail("HT030", `Expression \`${child.flow.test}\` could not be converted.`);
        const { flow, ...body } = child;
        return [`...(${lowering.condition(flow.testPlan!.ast, scope)} ? [${items([body], scope, keys, locals).join(", ")}] : [])`];
      }
      if (child.flow?.kind === "each") {
        const parts = eachParts(child, scope, lowering, context);
        const { flow: _flow, ...body } = child;
        const inner = items([body], parts.rowScope, [...keys, parts.keyValue ?? parts.index], [...locals, parts.item, parts.index]).join(", ");
        const fields = ([["item", parts.item], ["index", parts.index]] as const)
          .filter(([field, name]) => field === "item" || new RegExp(`\\b${name}\\b`).test(inner)).map(([field, name]) => `${field}: ${name}`);
        return [`...${parts.rows}.flatMap(({ ${fields.join(", ")} }) => [${inner}])`];
      }
      if (child.flow?.kind === "with") {
        // ponytail: a `$with` that reads an input's status (an `$await` group) is not converted around accepted children.
        if (child.flow.expressionPlan === undefined || child.flow.binding !== undefined) fail("HT030", `Expression \`${child.flow.expr}\` could not be converted.`);
        const { flow, ...body } = child;
        const alias = context.localName(flow.alias, "value");
        const local: Scope = { ...scope, code: new Map([...scope.code, [flow.alias, alias]]),
          types: new Map([...scope.types, [flow.alias, flow.aliasType === undefined ? typeOf(flow.expressionPlan!.ast, scope) : present(flow.aliasType)]]) };
        return [`...((${alias}: any) => [${items([body], local, keys, [...locals, alias]).join(", ")}])(${lowering.value(flow.expressionPlan!.ast, scope)})`];
      }
      // A `<template $match>` lists its chosen arm's children; any other `$match` element is left out, as live leaves it.
      if (child.flow?.kind === "match" && child.name === "template") {
        const flow = child.flow;
        const alias = flow.alias === undefined ? undefined : context.localName(flow.alias, "value");
        const local: Scope = alias === undefined ? scope : { ...scope, code: new Map([...scope.code, [flow.alias!, alias]]),
          types: new Map([...scope.types, [flow.alias!, flow.expressionPlan === undefined ? { type: { kind: "terminal", name: "unknown" }, nullable: true } : typeOf(flow.expressionPlan.ast, scope)]]) };
        const inner = [...locals, ...alias === undefined ? [] : [alias]];
        const arms = child.children.filter((arm): arm is ElementNode => arm.kind === "element");
        const chosen = arms.reduceRight((otherwise, arm) => {
          const { flow: armFlow, ...body } = arm;
          const listed = `[${items([body], local, keys, inner).join(", ")}]`;
          if (armFlow?.kind === "else") return listed;
          if (armFlow?.kind !== "when" || armFlow.testPlan === undefined) fail("HT018", "A $match child must be a $when or $else arm.");
          return `(${lowering.condition(armFlow.testPlan.ast, local)} ? ${listed} : ${otherwise})`;
        }, "[]");
        return [alias === undefined ? `...${chosen}` : `...((${alias}: any) => ${chosen})(${lowering.value(flow.expressionPlan!.ast, scope)})`];
      }
      if (child.name === "template" && child.flow === undefined) return items(child.children, scope, keys, locals);
      const definition = context.componentGraph?.get(child.name);
      if (!accepts.includes(child.name) || definition === undefined) {
        // A preset counts by lineage, but is not supported yet.
        let delegated: string | undefined;
        for (let at = definition; delegated === undefined && at?.root?.kind === "component"; at = context.componentGraph?.get(at.root.tag)) {
          if (accepts.includes(at.root.tag)) delegated = at.root.tag;
        }
        return [warning(delegated === undefined ? `${named} accepts ${listedNames(accepts)}; this \`<${child.name}>\` is left out.`
          : `\`<${child.name}>\` is a preset of \`${delegated}\`, which ${named} accepts; a preset among accepted children is not supported yet, so it is left out.`)];
      }
      // Each prop as the child's own instance first resolves it: a literal converts by its declared type, a
      // bound value passes the child's check (`checkPropInput`), and null, absent and rejected input take the
      // default, or null. Once the child renders, its entry reads the child's own props (`ownChild`).
      const props = Object.entries(definition.contract.props).map(([prop, contract]) => {
        const given = child.attributes.filter((attribute) => asciiLowerCase(prop) === attribute.name || kebabCase(prop) === attribute.name);
        const bound = given.find((attribute) => attribute.kind === "attribute" && attribute.target === undefined);
        const literal = given.find((attribute) => attribute.kind === "literal");
        const fallback = "default" in contract ? literalValueSource(contract.default) : "null";
        let value = fallback;
        if (bound?.kind === "attribute" && bound.expressionPlan !== undefined) {
          context.usesEntryChecks = true;
          const checked = context.freshIdentifier("checked");
          value = `((${checked}) => ${checked}.ok ? ${checked}.value : ${fallback})(checkListedProp((${lowering.value(bound.expressionPlan.ast, scope)}) ?? ${fallback}, ${JSON.stringify(normalizeType(contract.type))}, false, ${!contract.required}))`;
        } else if (literal?.kind === "literal") {
          const converted = invocationValue(contract, literal.value, "html", true);
          if (converted !== undefined) value = literalValueSource(converted);
        }
        return `${objectKey(prop)}: () => ${value}`;
      });
      const groups = new Map<string, TemplateNode[]>();
      for (const grandchild of child.children) {
        const slot = slotOf(grandchild);
        groups.set(slot, [...groups.get(slot) ?? [], grandchild]);
      }
      const hoisted = new Set<string>();
      const slots: string[] = [];
      const warnings: string[] = [];
      for (const [slot, content] of groups) {
        const declared = definition.contract.slots?.[slot]?.props ?? {};
        const scoped = Object.keys(declared).length > 0;
        const carrier = content.find((entry): entry is ElementNode => entry.kind === "element" && entry.name === "template" && entry.attributes.some(attribute => attribute.kind === "literal" && attribute.name === "slot"));
        if (scoped && carrier === undefined) {
          warnings.push(warning(`\`${slot}\` has props, so its content is a \`<template slot="${slot}">\`.`));
          hoisted.add(slot);
          continue;
        }
        hoisted.add(slot);
        const alias = context.freshIdentifier("slotArguments");
        const snippet = context.freshIdentifier(`${isScriptIdentifier(slot) ? slot : "child"}Entry`);
        const snippetScope: Scope = { ...scope,
          code: new Map([...scope.code, ...Object.keys(declared).map((prop) => [prop, `${alias}.p[${quote(prop)}]`] as const)]),
          types: new Map<string, Static>([...scope.types, ...Object.entries(declared).map(([prop, contract]) => [prop, slotPropStatic(contract)] as const)]),
        };
        const firstHtml = context.htmlSites;
        const firstRetention = context.retentions.size;
        // A `<template slot>` renders afresh at each outlet; plain content renders at one (`childSlot`). Each
        // element it renders at the top is the child's, which its `host.slots` lists (`a`).
        const nodes = carrier !== undefined ? carrier.children : content.map(projectedNode);
        const markup = nodes.map((entry) => {
          const rendered = renderNode(entry, false, snippetScope, lowering, context);
          // ponytail: an element under `$if`, `$each` or another directive at the top is not listed in `host.slots`.
          return entry.kind === "element" && entry.flow === undefined && entry.name !== "template"
            ? rendered.replace(/^<[^\s/>]+/, (tag) => `${tag} {@attach ${alias}.a}`) : rendered;
        }).join("");
        const ownership = localOwnership(context, firstHtml, firstRetention);
        const read = locals.filter((name) => new RegExp(`\\b${name}\\b`).test(`${ownership}${markup}`));
        declarations += `{#snippet ${snippet}(${alias}: any)}${read.map((name) => `{@const ${name} = ${alias}.s.${name}}`).join("")}${ownership}${markup}{/snippet}`;
        const present = plainSourceCondition(content, carrier, scope, lowering, context);
        slots.push(`${objectKey(slot)}: [${snippet}, { ${read.join(", ")} }, ${carrier === undefined}${present === undefined ? "" : `, false, ${present}`}]`);
      }
      const at = place++;
      context.listedChildren.set(child.children, { list, place: at, depth, slots: hoisted });
      return [...warnings, `[[${[String(at), ...keys].join(", ")}], ${quote(child.name)}, { ${props.join(", ")} }, { ${slots.join(", ")} }]`];
    });
    const built = items(node.children.filter((child) => slotOf(child) === slotName), scope, [], []);
    declarations += `{@const ${list} = childList(() => [${built.join(", ")}])}`;
    bindings.push(`${quote(slotName)}: ${list}`);
  }
  return { declarations, binding: `{...{ ${quote(LISTS_PROP)}: { ${bindings.join(", ")} } }}` };
}

/**
 * A `<slot of>` outlet's props, by accepted tag, as live's `childSlotProps` checks them against the
 * child's slot declaration: a static prop converts by its declared type; a bound one passes its
 * declared type's check (HR007) and, null or rejected, takes its default; a declared default fills a
 * prop the outlet leaves out; an undeclared or missing required prop warns. Undefined when no accepted
 * tag declares or is given any.
 */
function outletPropsSource(node: SlotNode, context: RenderContext): string | undefined {
  const name = node.name!;
  const given = node.props ?? [];
  const outlet = `<slot of name="${name}">`;
  const file = context.definition.source.file;
  const accepts = entryTags(context.definition.contract, node.of!);
  const warn = (prop: string, message: string): string =>
    `warnUnless(false, ${quote(`${file}#${context.definition.contract.tag}:of:${name}:${prop}`)}, ${quote(`${file}: HR007: ${message}`)}); `;
  const shapes = accepts.flatMap((tag) => {
    const accepted = context.componentGraph?.get(tag);
    const declared = accepted?.contract.slots?.[name]?.props ?? {};
    if (accepted === undefined || given.length + Object.keys(declared).length === 0) return [];
    let warnings = "";
    const values = given.map((prop) => {
      const key = quote(prop.name);
      const contract = declared[prop.name];
      if (contract === undefined) {
        warnings += warn(prop.name, `${outlet} gives prop \`${prop.name}\`, which \`${tag}\`'s slot \`${name}\` does not declare.`);
        return prop.raw === undefined ? `t[${key}] = s[${key}];` : `t[${key}] = ${quote(prop.raw)};`;
      }
      if (prop.raw !== undefined) return `t[${key}] = ${literalValueSource(invocationValue(contract, prop.raw, "html", true) ?? null)};`;
      const node = normalizeType(contract.type);
      const typed = { name: prop.name, ...node.kind === "terminal" && node.name === "unknown" ? {} : { type: contract.type }, ...contract.default === undefined ? {} : { default: contract.default } };
      const check = slotPropValueSource(context.definition, name, typed, true);
      if (check !== undefined && "type" in typed) context.usesSlotPropChecks = true;
      return check === undefined ? `t[${key}] = s[${key}];` : `t[${key}] = (${check})(s[${key}]);`;
    });
    for (const [prop, contract] of Object.entries(declared)) {
      if (given.some((entry) => entry.name === prop)) continue;
      if (contract.required) warnings += warn(prop, `${outlet} must give prop \`${prop}\`, which \`${tag}\`'s slot \`${name}\` declares as required.`);
      if (contract.default !== undefined) values.push(`t[${quote(prop)}] = ${literalValueSource(contract.default)};`);
    }
    if (warnings !== "") context.usesSlotPropChecks = true;
    return [`${quote(tag)}: (s: Record<string, unknown>) => { ${warnings}const t: Record<string, unknown> = {}; ${values.join(" ")} return t; }`];
  });
  if (shapes.length === 0) return undefined;
  const variable = `htmlNextOutletProps${context.outletProps.length}`;
  context.outletProps.push(`const ${variable}: Record<string, ((s: Record<string, unknown>) => Record<string, unknown>) | undefined> = { ${shapes.join(", ")} };`);
  return variable;
}

function renderNode(node: TemplateNode, root: boolean, scope: Scope, lowering: Lowering,
  context: RenderContext, blockInputs?: string[]): string {
  if (node.kind === "text") {
    if (context.boundSelect && context.selectSelection === undefined && node.expressionPlan === undefined && node.segments === undefined) return escapeHtml(node.value);
    if (context.preformatted) return `{${textSource(node, scope, lowering, context)}}`;
    // Template text reads as authored, with Svelte's whitespace handling: each run of ASCII
    // whitespace is one space, and Svelte drops it at the start and end of a tag.
    return (node.segments ?? [node]).map((segment) => segment.expressionPlan === undefined
      ? escapeHtml(segment.value.replace(/[\t\n\f\r ]+/g, " ")) : `{${textSource(segment, scope, lowering, context)}}`).join("");
  }
  if (node.kind === "slot") {
    if (node.flow !== undefined) return renderEach(node, scope, lowering, context);
    const fallback = (node.fallback ?? []).map((child, index, nodes) => isEdgeSpace(nodes, index) ? '{" "}' : renderNode(child, false, scope, lowering, context)).join("");
    const name = quote(node.name ?? "");
    if (node.of !== undefined) {
      // `<slot of>` renders the consumer's snippet for this slot of the child `of` names, in its contexts,
      // with the props the child's slot declaration shapes (`outletPropsSource`).
      context.usesChildOutlets = true;
      const placed = context.freshIdentifier("placed");
      const outlet = context.freshIdentifier("outlet");
      const values = (node.props ?? []).flatMap((prop) => {
        if (prop.raw !== undefined) return [];
        const value = lowering.value(prop.expressionPlan.ast, scope);
        return [`${objectKey(prop.name)}: ${mayProduceInvalidResult(prop.expressionPlan.ast, scope) ? retained(context, value, "undefined as unknown") : value}`];
      }).join(", ");
      const shapes = outletPropsSource(node, context);
      const given = shapes === undefined ? `{ ${values} }` : `(${shapes}[${placed}.tag]?.({ ${values} }) ?? { ${values} })`;
      return `{#if true}{@const ${outlet} = {}}{@const ${placed} = childSlot(${lowering.value(node.of.expressionPlan.ast, scope)}, ${name}, ${outlet})}{#if ${placed}}{#key ${placed}.owner}<HtmlNextContextScope contexts={${placed}.contexts} release={${placed}.release}>{@render ${placed}.snippet(${placed}.args(${given}))}</HtmlNextContextScope>{/key}${fallback === "" ? "" : `{:else}${fallback}`}{/if}{/if}`;
    }
    const selected = context.freshIdentifier("slot");
    const scoped = (node.props?.length ?? 0) > 0;
    if (!scoped && context.plainSlots.has(node.name ?? "")) {
      context.usesChildOutlets = true;
      const outlet = context.freshIdentifier("outlet");
      return `{#if true}{@const ${outlet} = {}}{@const ${selected} = htmlNextPlain(${name}, ${outlet})}{#if ${selected}}{#key ${selected}.owner}<HtmlNextContextScope contexts={${selected}.contexts} release={${selected}.release}>{@render ${selected}.snippet(${selected}.args({}))}</HtmlNextContextScope>{/key}${fallback === "" ? "" : `{:else}${fallback}`}{/if}{/if}`;
    }
    if (scoped) context.usesScopedSlots = true;
    const defaultSlot = node.name === undefined;
    const hasChildren = context.definition.contract.props.children === undefined;
    const supplied = defaultSlot ? `slots?.[""]${scoped && hasChildren ? " ?? (children === undefined ? undefined : null)" : ""}` : `slots?.[${name}]`;
    const checked = scoped ? `checkedSlot(${supplied}, ${name})` : supplied;
    const values = scoped ? `{ ${node.props!.map((prop) => {
      const value = lowering.value(prop.expressionPlan.ast, scope);
      // A null value, and one its declared type rejects, takes the prop's default, or null, as live gives
      // it; an invalid result keeps the last value.
      const proven = prop.type !== undefined && provenSlotProp(prop.type, typeOf(prop.expressionPlan.ast, scope));
      const given = proven ? undefined : slotPropValueSource(context.definition, node.name, prop, true);
      if (given !== undefined && prop.type !== undefined) context.usesSlotPropChecks = true;
      const source = given === undefined ? value : `(${given})(${value})`;
      return `${objectKey(prop.name)}: ${mayProduceInvalidResult(prop.expressionPlan.ast, scope) ? retained(context, source, `${slotPropDefaultSource(prop)} as unknown`) : source}`;
    }).join(", ")} }` : "{}";
    const children = !scoped && defaultSlot && hasChildren ? "{:else if children}{@render children()}" : "";
    return `{#if true}{@const ${selected} = ${checked}}{#if ${selected}}{@render ${selected}(${values})}${children}${fallback === "" ? "" : `{:else}${fallback}`}{/if}{/if}`;
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
    const alias = context.localName(node.flow.alias, "value");
    const local: RootScope = withReferenceTypes({
      ...(scope as RootScope),
      code: new Map([...scope.code, [node.flow.alias, alias]]),
      types: new Map([...scope.types, [node.flow.alias, node.flow.aliasType === undefined ? typeOf(value, scope) : present(node.flow.aliasType)]]),
    }, [[node.flow.alias, node.flow.binding === undefined ? referenceType(value, scope) : undefined]]);
    if (node.flow.binding !== undefined) {
      context.usesInputStatus = true;
      const binding = node.flow.binding;
      const computed = (context.definition.declarations ?? []).some(declaration => declaration.kind === "computed" && declaration.name === binding.name);
      const computedStatus = context.availability.get(binding.name) ?? (computed ? scope.code.get(binding.name)?.replace(/\.get\(\)$/, ".status()") : undefined);
      const read = Object.hasOwn(context.definition.contract.props, binding.name)
        ? `inputStatus(${quote(binding.name)}, ${binding.handlesError})`
        : computedStatus !== undefined ? `requireInputStatus(${computedStatus}, ${binding.handlesError})`
        : `requireInputStatus((${lowering.value(value, scope)}) === undefined ? UNRESOLVED_INPUT : READY_INPUT, ${binding.handlesError})`;
      return `{#if true}{@const ${alias} = ${read}}${renderNode(body, root, local, lowering, context)}{/if}`;
    }
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
    const alias = flow.alias === undefined ? undefined : context.localName(flow.alias, "value");
    const local: RootScope = flow.alias === undefined ? scope as RootScope : withReferenceTypes({
      ...(scope as RootScope),
      code: new Map([...scope.code, [flow.alias, alias!]]),
      types: new Map([...scope.types, [flow.alias, value === undefined ? { type: { kind: "terminal", name: "unknown" }, nullable: true } : typeOf(value, scope)]]),
    }, [[flow.alias, value === undefined ? undefined : referenceType(value, scope)]]);
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
  // Svelte drops whitespace at a block's edges, so a space kept there is an expression.
  if (node.name === "template") return content ?? node.children.map((child, index, nodes) => isEdgeSpace(nodes, index) ? '{" "}' : renderNode(child, false, scope, lowering, context)).join("");
  const component = node.name.includes("-");
  if (component) context.imports.add(node.name);
  const name = component ? componentName(node.name) : node.name;
  const childProps = component ? context.propContractsByTag?.get(node.name) : undefined;
  const childProp = (attributeName: string): readonly [string, PropContract] | undefined =>
    Object.entries(childProps ?? {}).find(([prop]) => asciiLowerCase(prop) === attributeName || kebabCase(prop) === attributeName);
  let snippetDeclarations = "";
  let componentChildren = node.children;
  const slotBindings: string[] = [];
  // A child an `as` list holds leaves out the slots the list renders, and gives the list its contexts.
  const listed = component ? context.listedChildren.get(node.children) : undefined;
  const listing = component ? childListSource(node, scope, lowering, context) : undefined;
  if (listing !== undefined) snippetDeclarations += listing.declarations;
  if (component) {
    const accepting = context.componentGraph?.get(node.name)?.contract.slots;
    const projection = node.children.flatMap(child => {
      const assignment = child.kind === "element" ? child.attributes.find(attribute => attribute.kind === "literal" && attribute.name === "slot") : undefined;
      const slot = assignment?.kind === "literal" ? assignment.value : "";
      return accepting?.[slot]?.as === undefined ? [child] : acceptedProjection([child]);
    });
    const groups = new Map<string, TemplateNode[]>();
    const defaults: TemplateNode[] = [];
    for (const child of projection) {
      const assigned = child.kind === "element" ? child.attributes.find((entry) => entry.kind === "literal" && entry.name === "slot") : undefined;
      if (assigned?.kind !== "literal") { defaults.push(child); continue; }
      const group = groups.get(assigned.value) ?? [];
      group.push(child); groups.set(assigned.value, group);
    }
    componentChildren = defaults.map(projectedNode);
    const target = context.componentGraph?.get(node.name);
    if (listed?.slots.has("") === true) componentChildren = [];
    if (groups.has("") || (childProps?.children !== undefined || target !== undefined && repeatedSlotNames(target).has("")) && defaults.length > 0) {
      const unnamed = projection.filter((child) => {
        const assigned = child.kind === "element" ? child.attributes.find((entry) => entry.kind === "literal" && entry.name === "slot") : undefined;
        return assigned?.kind !== "literal" || assigned.value === "";
      });
      groups.set("", unnamed);
      componentChildren = [];
    }
    for (const [slot, children] of groups) {
      if (listed?.slots.has(slot) === true) continue;
      const contracts = context.slotsByTag?.get(node.name);
      const contract = contracts?.find((entry) => entry.name === slot);
      const scoped = (contract?.props?.length ?? 0) > 0;
      const carrier = children.find((child): child is ElementNode => child.kind === "element" && child.name === "template" && child.attributes.some(attribute => attribute.kind === "literal" && attribute.name === "slot"));
      if (scoped && carrier === undefined) { slotBindings.push(`${objectKey(slot)}: null`); continue; }
      const alias = context.freshIdentifier("slotProps");
      const snippet = context.freshIdentifier(`${isScriptIdentifier(slot) ? slot : "default"}Slot`);
      const projectedScope: Scope = !scoped ? scope : withReferenceTypes({
        ...scope,
        code: new Map([...scope.code, ...contract!.props!.map((prop) => [prop, `${alias}[${quote(prop)}]`] as const)]),
        types: new Map<string, Static>([...scope.types, ...contract!.props!.map((prop) => [prop, slotPropStatic(contract!.declared?.[prop])] as const)]),
      }, contract!.props!.map(prop => [prop, undefined]));
      const firstHtml = context.htmlSites;
      const firstRetention = context.retentions.size;
      // A slot's first `<template slot>` is its whole content, as in the live runtime.
      const content = scoped ? carrier!.children : (carrier === undefined ? children : [carrier]).map(projectedNode);
      const markup = content.map((child) => renderNode(child, false, projectedScope, lowering, context)).join("");
      const ownership = localOwnership(context, firstHtml, firstRetention);
      snippetDeclarations += `{#snippet ${snippet}(${alias}: Record<string, any>)}${ownership}${markup}{/snippet}`;
      // A snippet that renders nothing still fills its slot, so a slot of only `$if` elements passes
      // its snippet while one renders, and the receiving slot shows its fallback otherwise.
      const present = plainSourceCondition(children, carrier, scope, lowering, context);
      const target = context.componentGraph?.get(node.name);
      const shared = target !== undefined && repeatedSlotNames(target).has(slot) || [...context.componentGraph?.values() ?? []]
        .some(definition => Object.values(definition.contract.slots ?? {}).some(declared => declared.as !== undefined && declared.accepts?.includes(node.name)));
      const source = shared && !scoped && carrier === undefined ? `plainSnippet(${snippet})` : snippet;
      slotBindings.push(`${objectKey(slot)}: ${present === undefined ? source : `${present} ? ${source} : undefined`}`);
    }
  }
  const forwards = node.attributes.some(attribute => attribute.kind === "forward");
  const componentStyle = component && node.attributes.some(attribute => attribute.kind === "attribute" && attribute.target === "style");
  const htmlInputs = component && (forwards || componentStyle) && Object.keys(childProps ?? {}).length > 0 ? invocationSchema(childProps!) : undefined;
  if (htmlInputs !== undefined) context.usesHtmlInputs = true;
  const authoredDecorations = node.attributes.filter((entry) => entry.kind === "attribute" && (entry.target === "class" || entry.target === "style" || !component && entry.target === undefined && (entry.name === "class" || entry.name === "style" && (forwards || node.attributes.some(write => write.kind === "attribute" && write.target === "style"))) && !entry.twoWay));
  const ownsClasses = authoredDecorations.some((entry) => entry.kind === "attribute" && (entry.target === "class" || entry.target === undefined && entry.name === "class")) || !component && forwards && node.attributes.some(entry => entry.kind === "literal" && entry.name === "class" && entry.value === "");
  const ownsStyles = authoredDecorations.some((entry) => entry.kind === "attribute" && (entry.target === "style" || entry.target === undefined && entry.name === "style"));
  const decoratesClasses = ownsClasses;
  const decoratesStyles = ownsStyles && !componentStyle;
  const hasDecorations = decoratesClasses || decoratesStyles;
  const decorations = forwards && (ownsClasses || ownsStyles) ? node.attributes.filter(entry => entry.kind === "forward"
    || entry.kind === "literal" && (entry.name === "class" && ownsClasses || entry.name === "style" && ownsStyles) && !node.attributes.some(write => write.kind === "attribute" && write.target === undefined && write.name === entry.name)
    || authoredDecorations.includes(entry as never)) : authoredDecorations;
  const ownedRules = decorations.flatMap((entry) => {
    if (entry.kind === "forward") return [...ownsClasses ? ["class"] : [], ...ownsStyles ? ["style"] : []].map(name =>
      `{ kind: "attribute" as const, name: ${quote(name)}, read: () => Object.hasOwn(forwardedAttributes(rest), ${quote(name)}) ? rest[${quote(name)}] : Symbol.for('html-next.no-attribute') }`);
    if (entry.kind === "literal") return `{ kind: "attribute" as const, name: ${quote(entry.name)}, read: () => ${quote(entry.value)} }`;
    if (entry.kind !== "attribute" || entry.expressionPlan === undefined) fail("HT030", "An uncompiled decoration cannot be converted.");
    const plan = entry.expressionPlan;
    if (entry.target === undefined && entry.name === "style") {
      const read = conformingRead(plan, scope, context, lowering.attribute(plan.ast, scope, "style"));
      const literal = node.attributes.find(write => write.kind === "literal" && write.name === "style");
      const initial = literal?.kind === "literal" ? quote(literal.value) : "Symbol.for('html-next.invalid-result')";
      const value = read.invalid ? retained(context, read.source, initial) : read.source;
      return `{ kind: "attribute" as const, name: "style", read: () => ${value} }`;
    }
    const guard = declaredReadGuard(plan, scope, context);
    const source = entry.target === "class" ? lowering.condition(plan.ast, scope) : entry.target === undefined ? lowering.attribute(plan.ast, scope, entry.name) : lowering.text(plan.ast, scope);
    return `{ kind: ${quote(entry.target ?? "attribute")} as const, name: ${quote(entry.name)}, read: () => (${guard === undefined ? source : `(${guard}) ? ${source} : Symbol.for('html-next.invalid-result')`}) }`;
  });
  const rules = `[${ownedRules.join(", ")}]`;
  if (hasDecorations) context.usesDecorations = true;
  if (decoratesStyles || componentStyle) context.usesStyleDecorations = true;
  const literals: string[] = [];
  const selectedBindings: string[] = [];
  const statusBindings: string[] = [];
  const literalInputs: string[] = [];
  const inputDeclarations: string[] = blockInputs ?? [];
  const nativeBindings: string[] = [];
  const bindings: string[] = slotBindings.length === 0 ? [] : [childProps?.slots === undefined
    ? `slots={{ ${slotBindings.join(", ")} }}`
    : `{...{ ${quote(SLOTS_PROP)}: { ${slotBindings.join(", ")} } }}`];
  if (listing !== undefined) bindings.push(listing.binding);
  if (listed !== undefined) bindings.push(`{...{ ${quote(ENTRY_PROP)}: [${listed.list}, [${[String(listed.place), ...context.eachKeys.slice(listed.depth)].join(", ")}]] }}`);
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
  // The scoped styles' root and limits are the root's and each invoked component's tag, as classes.
  const scopeClasses = [
    ...(root && context.hostClass ? [context.definition.contract.tag] : []),
    ...(component && context.styledComponents.has(node.name) ? [node.name] : []),
  ];
  const authoredStyle = root ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "style") : undefined;
  const rootScope = root ? scope as RootScope : undefined;
  const reflectedNames = new Set(rootScope?.props.map((prop) => propAttribute(rootScope.tag, prop)) ?? []);
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
    const authoredDefault = literalValue?.kind === "literal" && node.attributes.indexOf(literalValue) > node.attributes.findLastIndex(entry => entry.kind === "forward");
    const defaultValue = quote(literalValue?.kind === "literal" ? literalValue.value : node.name === "textarea" ? node.children.filter((child) => child.kind === "text").map((child) => child.value).join("") : "");
    const defaultChecked = node.attributes.some((entry) => entry.kind === "literal" && entry.name === "checked");
    const defaults = attribute.name === "checked" ? `{ checked: ${inheritsBinding ? `${context.rootBindingAttributeName}("checked") !== undefined || ` : ""}${defaultChecked} }`
      : `{ value: ${inheritsBinding && node.name === "input" && !authoredDefault ? `String(${context.rootBindingAttributeName}("value") ?? ${defaultValue})` : defaultValue} }`;
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
    const keys = `[${path.slice(1).map((segment) => typeof segment === "object" ? lowering.value(segment.expression, scope) : JSON.stringify(segment)).join(", ")}]`;
    // An emptied control's null reverts the state to its declared value; the writer returns what the
    // state took, so the control is not echoed that value.
    const revert = bindingRevertSource(context.definition, path[0] as string, path.length === 1 ? undefined : keys);
    const written = revert === undefined ? value : `(${value} ?? ${revert})`;
    const write = path.length === 1 ? `const written = ${written}; if (!Object.is(${destination}, written)) ${destination} = written as typeof ${destination}; return written;`
      : `const written = ${written}; writePath(${destination}, ${keys}, written); return written;`;
    return `(${value}: unknown) => { if (${value} !== Symbol.for('html-next.invalid-result')) { ${write} } return ${value}; }`;
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
    const read = retained(context, `(() => { if (!(${guard ?? "true"})) return Symbol.for('html-next.invalid-result'); const ${candidate}: unknown = ${raw}; return acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(contract.type))}, ${contract.default !== undefined}) ? { value: ${candidate}, raw: ${candidate} } : Symbol.for('html-next.invalid-result'); })()`, initial);
    inputDeclarations.push(`{@const ${input} = ${read}}`);
    literalInputs.push(`[${quote(prop)}]: { get raw() { return ${input}.raw; } }`);
    return `${input}.value`;
  };
  if (node.name === "option" && context.boundSelect && context.selectSelection === undefined) {
    const selected = node.attributes.some((entry) => entry.kind === "literal" && entry.name === "selected");
    bindings.push(`{...(typeof document === 'undefined' && (${context.boundSelect}) ? { "data-html-next-option-default": ${quote(String(selected))} } : {})}`);
  }
  // Invocation metadata precedes authored attributes and must survive ordered forwarding.
  const ordered: string[] = forwards ? [...bindings] : [];
  let capturedBindings = 0;
  for (const attribute of node.attributes) {
    const literalStart = literals.length, bindingStart = bindings.length;
    try {
    if (attribute.kind === "forward") {
      const ordinarySelect = root && node.name === "select" && !context.rootBindings?.includes("value");
      const omitted = root && !component ? [...new Set([...(context.rootBindings ?? []), ...node.name === "select" ? ["value"] : []])] : [];
      const forwarded = `forwardedAttributes(rest${omitted.length > 0 ? `, ${JSON.stringify(omitted)}` : ""})`;
      literals.push(`{...${htmlInputs === undefined ? forwarded : `htmlAttributeInputs(${forwarded}, ${htmlInputs})`}}`);
      if (ordinarySelect) {
        context.usesAttributeBinding = true;
        const candidate = context.freshIdentifier("htmlNextSelectAttribute");
        const value = `(() => { const ${candidate}: unknown = rest.value; return ${lowering.attribute({ kind: "id", name: candidate }, unknownValueScope(candidate), "value")}; })()`;
        literals.push(`{...(typeof document === 'undefined' ? { value: ${value} } : {})}`);
        bindings.push(`{@attach ${context.bindingHelperName}("value", () => ${value})}`);
      }
      continue;
    }
    if (componentStyle && isStyleWrite(attribute)) continue;
    if (forwards && attribute.kind === "literal" && node.attributes.some(binding => binding.kind === "attribute" && binding.target === undefined && binding.name === attribute.name)) continue;
    if (forwards && attribute.kind === "literal" && (attribute.name === "style" || attribute.name === "class" && !ownsClasses)) { literals.push(`${attribute.name}={${quote(attribute.value)}}`); continue; }
    if (attribute.kind === "literal" && !component && attributeNamespace(attribute.name) !== undefined) {
      context.usesAttributeBinding = true; context.usesNamespacedAttributes = true;
      literals.push(`{...(typeof document === 'undefined' ? { ${objectKey(attribute.name)}: ${quote(attribute.value)} } : {})}`);
      bindings.push(`{@attach ${context.bindingHelperName}(${quote(attribute.name)}, () => ${quote(attribute.value)}, undefined, true, ${quote(attributeNamespace(attribute.name)!)})}`);
      continue;
    }
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
        (ownsClasses && attribute.name === "class" || ownsStyles && attribute.name === "style")) continue;
      if (node.name === "input" && (attribute.name === "value" || attribute.name === "checked")) {
        const value = attribute.name === "checked" ? "true" : quote(attribute.value);
        literals.push(`{...(typeof document === 'undefined' ? { ${attribute.name}: ${value} } : { ${attribute.name === "checked" ? "defaultChecked" : "defaultValue"}: ${value} })}`);
        continue;
      }
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
      if (component && attribute.name === "class" && scopeClasses.length > 0) {
        literals.push(`class={${quote([...scopeClasses, attribute.value].join(" "))}}`);
        continue;
      }
      const declared = childProp(attribute.name);
      if (declared !== undefined && declared[1].select === undefined && node.attributes.some((entry) =>
        entry.kind === "attribute" && entry.target === undefined && childProp(entry.name)?.[0] === declared[0])) continue;
      // Svelte rejects a static `slot` on an element inside `{#if}` or `{#each}`, so projected
      // content, which may be conditional or repeated, spreads it.
      if (declared === undefined && attribute.name === "slot" && !component &&
        node.attributes.some((entry) => entry.kind === "literal" && entry.name === "data-slotted")) literals.push(`{...{ slot: ${quote(attribute.value)} }}`);
      else if (declared === undefined && Object.hasOwn(Object.prototype, attribute.name)) literals.push(componentPropAttribute(attribute.name === "__proto__" ? "__Proto__" : attribute.name[0]!.toUpperCase() + attribute.name.slice(1), quote(attribute.value)));
      else if (declared === undefined && !component && caseSensitiveAttribute(attribute.name)) literals.push(...nativeAttribute(attribute.name, quote(attribute.value), context));
      else if (declared === undefined) literals.push(!component && isNativeBooleanAttribute(attribute.name) ? attribute.name : `${attribute.name}=${attribute.name === "slot" || !component && PLAIN_ATTRIBUTE.test(attribute.value) ? literalAttribute(attribute.value) : `{${quote(attribute.value)}}`}`);
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
      if (!component && attribute.name === "class" && attribute.target === undefined && !attribute.twoWay) continue;
      if (root && reflectedNames.has(attribute.name) && attribute.twoWay !== true) continue;
      const statusProp = component ? childProp(attribute.name)?.[0] : undefined;
      const statusExpression = attribute.expressionPlan.ast;
      const observed = context.observe(scope);
      if (statusProp !== undefined && attribute.twoWay !== true && attribute.target === undefined && statusExpression.kind !== "id" && attribute.expressionPlan.dependencies.some(path => {
        const root = path.split(".")[0]!;
        return observed.code.get(root) !== scope.code.get(root);
      })) {
        context.usesInputStatus = true; context.usesInputExpressions = true;
        const contract = childProp(attribute.name)![1];
        const input = context.freshIdentifier("htmlNextBoundInput");
        const candidate = context.freshIdentifier("htmlNextInputSnapshot");
        const read = conformingRead(attribute.expressionPlan, scope, context, lowering.value(statusExpression, observed));
        const literal = node.attributes.find(entry => entry.kind === "literal" && childProp(entry.name)?.[0] === statusProp);
        const initial = literal?.kind === "literal" ? `{ value: ${literalPropValue(literal.value, contract)}, status: READY_INPUT } as any` : "undefined as any";
        const accepts = contract.select === undefined ? `${!contract.required ? `${candidate}.value === null || ` : ""}acceptsBindingDestination(${candidate}.value, ${JSON.stringify(normalizeType(contract.type))}, ${contract.default !== undefined})` : "true";
        const snapshot = retained(context, `((${candidate}) => !${candidate}.status.ready || (${candidate}.value !== Symbol.for('html-next.invalid-result') && (${accepts})) ? ${candidate} : Symbol.for('html-next.invalid-result'))(evaluateInput(() => (${read.source}) as any, READY_INPUT))`, initial);
        context.usesComponentBindings = true;
        inputDeclarations.push(`{@const ${input} = ${snapshot}}`);
        statusBindings.push(`${quote(statusProp)}: () => ${input}`);
        bindings.push(componentPropAttribute(statusProp, `${input}?.value`));
        continue;
      }
      if (statusProp !== undefined && statusExpression.kind === "id") {
        const read = scope.code.get(statusExpression.name);
        const prop = Object.hasOwn(context.definition.contract.props, statusExpression.name) && read === `checkedProps[${quote(statusExpression.name)}]`;
        const computed = (context.definition.declarations ?? []).some(declaration => declaration.kind === "computed" && declaration.name === statusExpression.name);
        const status = context.availability.get(statusExpression.name);
        if (prop || status !== undefined || computed && read?.endsWith(".get()")) statusBindings.push(`${quote(statusProp)}: () => ({ value: ${lowering.value(statusExpression, scope)}, status: ${prop ? `inputStatus(${quote(statusExpression.name)}, true)` : status ?? read!.replace(/\.get\(\)$/, ".status()")} })`);
      }
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
          const value = literal?.kind === "literal" ? boundLiteralInput(declared[0], declared[1], source, guard, literal.value) : retained(context, `(() => { if (!(${guard ?? "true"})) return Symbol.for('html-next.invalid-result'); const ${candidate}: unknown = ${source}; return acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(declared[1].type))}, ${declared[1].default !== undefined}) ? ${candidate} : Symbol.for('html-next.invalid-result'); })()`, initial);
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
      else if (attribute.target === "class" || attribute.target === "style" || !component && ownsStyles && attribute.target === undefined && attribute.name === "style") continue;
      else {
        const declared = childProp(attribute.name);
        if (declared?.[1].select !== undefined) { selectedBindingInput(declared[0], attribute); continue; }
        const read = conformingRead(attribute.expressionPlan, scope, context, declared === undefined
          ? lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name) : lowering.value(attribute.expressionPlan.ast, scope));
        const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === attribute.name);
        const initial = literal?.kind === "literal" ? declared === undefined ? quote(literal.value) : `${literalPropValue(literal.value, declared[1])} as any` : forwards ? "Symbol.for('html-next.invalid-result')" : "undefined as any";
        let value: string;
        if (declared !== undefined && declared[1].select === undefined) {
          if (literal?.kind === "literal") value = boundLiteralInput(declared[0], declared[1], lowering.value(attribute.expressionPlan.ast, scope), declaredReadGuard(attribute.expressionPlan, scope, context), literal.value);
          else if (attribute.expressionPlan.ast.kind === "literal" && attribute.expressionPlan.ast.dimension === undefined &&
            parseTypedValue(attribute.expressionPlan.ast.value, declared[1].type, "$", "value").ok) value = read.source;
          else {
            context.usesComponentBindings = true;
            const candidate = context.freshIdentifier("htmlNextBindingValue");
            value = retained(context, `(() => { const ${candidate}: unknown = ${read.source}; return ${candidate} !== Symbol.for('html-next.invalid-result') && acceptsBindingDestination(${candidate}, ${JSON.stringify(normalizeType(declared[1].type))}, ${declared[1].default !== undefined}) ? ${candidate} : Symbol.for('html-next.invalid-result'); })()`, initial);
          }
        } else value = read.invalid ? retained(context, read.source, initial) : read.source;
        if (!component && attributeNamespace(attribute.name) !== undefined) {
          context.usesAttributeBinding = true; context.usesNamespacedAttributes = true;
          bindings.push(`{...(typeof document === 'undefined' ? { ${objectKey(attribute.name)}: ${value} } : {})}`);
          bindings.push(`{@attach ${context.bindingHelperName}(${quote(attribute.name)}, () => ${value}, undefined, false, ${quote(attributeNamespace(attribute.name)!)})}`);
        } else if (node.name === "select" && attribute.name === "value" || node.name === "input" && ["value", "checked"].includes(attribute.name)) {
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
        } else if (forwards && !component && read.invalid) bindings.push(`{...((candidate: unknown) => candidate === Symbol.for('html-next.invalid-result') ? {} : { ${objectKey(svgAttributeName(attribute.name))}: candidate })(${value})}`);
        else if (component) bindings.push(componentPropAttribute(declared?.[0] ?? attribute.name, value));
        else bindings.push(...nativeAttribute(svgAttributeName(attribute.name), value, context));
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
          bindings.push(`{@attach setProperty(${quote(attribute.name)}, () => ${source})}`);
          if (SSR_BOOLEAN_PROPERTIES.has(attribute.name) || SSR_STRING_PROPERTIES.has(attribute.name)) {
            const boolean = SSR_BOOLEAN_PROPERTIES.has(attribute.name);
            let rendered = boolean ? `Boolean(${source})` : `String(${source})`;
            if (read.invalid) {
              const candidate = context.freshIdentifier("htmlNextPropertyValue");
              const serialized = boolean ? `Boolean(${candidate})` : `String(${candidate})`;
              const name = asciiLowerCase(attribute.name);
              const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === name);
              const initialValue = literal?.kind === "literal" ? quote(literal.value) : "undefined";
              const initialAttribute = context.freshIdentifier("htmlNextPropertyAttribute");
              const initialSource = root ? `(Object.keys(rest).includes(${quote(name)}) ? rest[${quote(name)}] : ${initialValue})` : initialValue;
              const initialResult = context.freshIdentifier("htmlNextInitialProperty");
              const initial = `(() => { const ${initialAttribute}: unknown = ${initialSource}; const ${initialResult} = ${lowering.attribute({ kind: "id", name: initialAttribute }, unknownValueScope(initialAttribute), name)}; return ${boolean ? `${initialResult} !== undefined` : initialResult}; })()`;
              rendered = retained(context, `(() => { const ${candidate}: unknown = ${source}; return ${candidate} === Symbol.for('html-next.invalid-result') ? ${candidate} : ${serialized}; })()`, initial);
            }
            if (node.name === "option" && attribute.name === "value") optionPropertyValue = rendered;
            bindings.push(`{...(typeof document === 'undefined' ? { ${objectKey(asciiLowerCase(attribute.name))}: ${rendered} } : {})}`);
          }
        }
        if (root) { context.rootAttributeBindings.add(attribute.name); context.rootAttributeBindings.add(asciiLowerCase(attribute.name)); }
      }
    }
    } finally {
      if (forwards) ordered.push(...literals.slice(literalStart), ...bindings.slice(bindingStart));
      capturedBindings = bindings.length;
    }
  }
  if (nativeBindings.length > 0) bindings.push(`{...{ ${quote(NATIVE_BINDINGS_PROP)}: { ${nativeBindings.join(", ")} } }}`);
  if (root && !component) {
    for (const name of context.rootBindings ?? []) {
      const read = `${context.nativeBindingReadName}(${quote(name)})`;
      const source = `(${read} === undefined ? Symbol.for('html-next.invalid-result') : ${read}!())`;
      const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === name);
      const authoredLast = literal?.kind === "literal" && node.attributes.indexOf(literal) > node.attributes.findLastIndex(entry => entry.kind === "forward");
      const caller = `(Object.keys(rest).includes(${quote(name)}) ? rest[${quote(name)}] : ${literal?.kind === "literal" ? quote(literal.value) : "undefined"})`;
      const unboundInput = authoredLast ? quote(literal.value) : caller;
      if (nativeControlBinding(node.name, name)) {
        context.usesControls = true;
        const defaults = name === "checked" ? `{ checked: ${context.rootBindingAttributeName}(${quote(name)}) !== undefined || ${literal !== undefined} }`
          : node.name === "textarea" ? `{ value: ${quote(node.children.filter((child) => child.kind === "text").map((child) => child.value).join(""))} }`
          : `{ value: String(${authoredLast ? quote(literal.value) : `${context.rootBindingAttributeName}(${quote(name)}) ?? ${quote(literal?.kind === "literal" ? literal.value : "")}`}) }`;
        context.usesAttributeBinding = true;
        const unbound = context.freshIdentifier("htmlNextAttributeValue");
        const unboundScope = unknownValueScope(unbound);
        const unboundSource = `(() => { const ${unbound}: unknown = ${authoredLast ? quote(literal.value) : caller}; return ${lowering.attribute({ kind: "id", name: unbound }, unboundScope, name)}; })()`;
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
        const serialized = lowering.attribute({ kind: "id", name: candidate }, local, name);
        if (authoredLast) bindings.push(`{...(typeof document === 'undefined' ? { ${objectKey(name)}: ${quote(literal.value)} } : {})}`);
        bindings.push(`{@attach ${context.bindingHelperName}(${quote(name)}, () => { const ${candidate}: unknown = ${read} === undefined ? ${unboundInput} : ${read}!(); if (${candidate} === Symbol.for('html-next.invalid-result')) return ${candidate}; const value = ${serialized}; if (${read} !== undefined) ${context.rootBindingAttributeName}(${quote(name)}, value); return ${authoredLast ? quote(literal.value) : "value"}; })}`);
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
  if (statusBindings.length > 0) bindings.push(`${STATUS_INPUTS_PROP}={{ ${statusBindings.join(", ")} }}`);
  // Svelte preserves NUL-named component props; a spread adds a proxy to every invocation.
  if (literalInputs.length > 0) bindings.push(`${LITERAL_INPUTS_PROP}={{ ${literalInputs.join(", ")} }}`);
  if (component && !root && !decoratesClasses && scopeClasses.length > 0 && !node.attributes.some((attribute) => attribute.name === "class")) {
    // ponytail: an invocation that binds `class` keeps its binding and leaves the scope unlimited there.
    literals.push(`class={${quote(scopeClasses.join(" "))}}`);
  }
  const attributes = [...(selectedOption === undefined ? [] : [selectedOption]), ...(forwards ? ordered : literals)];
  if (!component && (node.attributes.some(attribute => caseSensitiveAttribute(attribute.name)) ||
    root && rootScope!.props.some(prop => caseSensitiveAttribute(propAttribute(rootScope!.tag, prop)))) &&
    !node.attributes.some(attribute => attribute.name === "is")) {
    // Svelte preserves spread attribute case on elements with `is`. Undefined emits no attribute
    // and leaves the native element intact; quoted spread keys keep non-ASCII names distinct.
    attributes.push("is={undefined}");
  }
  if (root) {
    // Every converted root bounds the styles of the components around it, as Vue's does: a slot's
    // `:slotted()` rules stop at a projected component, its root included. A delegated root's is its child's.
    if (!component) attributes.push(`${VUE_ROOT_ATTRIBUTE}=""`);
    attributes.push("{...rootAttrs()}");
    if (component) attributes.push(`{...{ ${quote(ROOT_OWNER_PROP)}: true }}`);
    attributes.push(rootScope!.preservesRootFocus
      ? "{@attach (element: Element) => { rootElement = element; if (rootFocusPending) { (element as HTMLElement).focus({ preventScroll: true }); rootFocusPending = false; } return () => { rootFocusPending ||= element.ownerDocument.activeElement === element; if (rootElement === element) rootElement = undefined; }; }}"
      : component
      ? "{@attach (element: Element) => { rootElement = element; return () => { if (rootElement === element) rootElement = undefined; }; }}"
      : "bind:this={rootElement}");
    if (!forwards && authoredClass?.kind === "literal" && !decoratesClasses) {
      const base = forwards && ownsClasses ? "undefined" : classBaseSource(node, root, scopeClasses);
      if (component) attributes.push(`class={${base}}`);
      else {
        context.usesAttributeBinding = true;
        context.rootAttributeBindings.add("class");
        attributes.push(`{...(typeof document === 'undefined' ? { class: ${base} } : {})}`);
        attributes.push(`{@attach ${context.bindingHelperName}("class", () => ${base})}`);
      }
    }
    else if (!forwards && !decoratesClasses && scopeClasses.length > 0) context.rootScope = scopeClasses.join(" ");
    if (!forwards && authoredStyle?.kind === "literal" && !decoratesStyles) {
      attributes.push(`style={${quote(authoredStyle.value)}}`);
    }
    if ((scope as RootScope).stateNames.length > 0) attributes.push(`data-${(scope as RootScope).tag}-state={hostState || undefined}`);
    for (const prop of rootScope!.props) {
      const name = propAttribute(rootScope!.tag, prop);
      const authored = node.attributes.find((attribute) => attribute.name === name);
      const bound = authored?.kind === "attribute";
      const fallback = authored?.kind === "literal" ? quote(authored.value) : "undefined";
      const type = normalizeType(rootScope!.propContracts[prop]!.type);
      const separator = type.kind === "separated-list" ? quote(type.separator === "space" ? " " : ", ") : undefined;
      const value = scope.code.get(prop) ?? prop;
      const serialized = separator === undefined
        ? `${context.reflectedPropName}(${quote(prop)}, ${value})`
        : `Array.isArray(${value}) ? ${value}.join(${separator}) : String(${value})`;
      attributes.push(...nativeAttribute(name, `${!bound ? `${context.inputNames.get(prop)} == null ? ${fallback} : ` : ""}${value} == null ? undefined : (${serialized})`, context));
    }
  }
  if (hasDecorations) {
    if (component) {
      if (decoratesClasses) {
        const base = forwards && ownsClasses ? "undefined" : classBaseSource(node, root, scopeClasses);
        attributes.push(componentPropAttribute(childProp("class")?.[0] ?? "class", `classText(${base}, ${rules})`));
      }
      if (decoratesStyles) {
        const literal = node.attributes.find(entry => entry.kind === "literal" && entry.name === "style");
        attributes.push(componentPropAttribute(childProp("style")?.[0] ?? "style", `styleText(${!forwards && literal?.kind === "literal" ? quote(literal.value) : quote("")}, ${rules})`));
      }
    } else {
      context.usesDecorationAttachment = true;
      if (decoratesClasses) {
        const base = forwards && ownsClasses ? "undefined" : classBaseSource(node, root, scopeClasses);
        context.usesAttributeBinding = true;
        if (root) context.rootAttributeBindings.add("class");
        attributes.push(`{...(typeof document === 'undefined' ? { class: classText(${base}, ${rules}, ${quote(scopeClasses.join(" "))}) } : {})}`);
        attributes.push(`{@attach ${context.bindingHelperName}("class", () => ${base})}`);
      }
      if (decoratesStyles) {
        const literal = node.attributes.find((entry) => entry.kind === "literal" && entry.name === "style");
        const base = `[${literal?.kind === "literal" ? quote(literal.value) : quote("")}${root ? ", rest.style" : ""}].filter(Boolean).join("; ")`;
        const empty = literal?.kind === "literal" ? quote("") : root ? `(rest.style == null || rest.style === false ? undefined : ${quote("")})` : "undefined";
        attributes.push(`style={(typeof document === 'undefined' ? styleText(${forwards ? quote("") : base}, ${rules}) : ${base}) || ${empty}}`);
      }
      attributes.push(`{@attach decorate(${rules}, { ${forwards ? "ordered: true, " : ""}scope: ${quote(scopeClasses.join(" "))}, hashed: ${context.styleOwner !== undefined} })}`);
    }
  }
  attributes.push(...(forwards ? bindings.slice(capturedBindings) : bindings));
  if (componentStyle) {
    const styleRules = styleWriteRules(node.attributes, (attribute, fallback) => {
      const plan = attribute.expressionPlan!;
      const source = attribute.target === "style" ? lowering.text(plan.ast, scope) : lowering.attribute(plan.ast, scope, "style");
      const read = conformingRead(plan, scope, context, source);
      return read.invalid ? retained(context, read.source, fallback === undefined ? "Symbol.for('html-next.invalid-result')" : quote(fallback)) : read.source;
    }, "rest");
    const value = `styleText("", ${styleRules})`;
    attributes.push(htmlInputs === undefined ? `style={${value}}` : `{...htmlAttributeInputs({ style: ${value} }, ${htmlInputs})}`);
  }

  if (forwards && !component && !decoratesClasses && scopeClasses.length > 0) {
    const attachments = attributes.filter(attribute => attribute.startsWith("{@attach") || attribute.startsWith("bind:"));
    const inputs = attributes.filter(attribute => !attachments.includes(attribute));
    const input = context.freshIdentifier("htmlNextAttributes");
    attributes.splice(0, attributes.length,
      `{...((${input}: Record<string, any>) => ({ ...${input}, class: [${quote(scopeClasses.join(" "))}, ${input}.class] }))(${jsxAttributeRecord(inputs)})}`,
      ...attachments);
  }
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
  if (htmlInputs !== undefined) {
    const attachments = attributes.filter(attribute => attribute.startsWith("{@attach") || attribute.startsWith("bind:"));
    const inputs = attributes.filter(attribute => !attachments.includes(attribute)).map(attribute => {
      if (!attribute.includes("\0") || attribute.startsWith("{")) return attribute;
      const equals = attribute.indexOf("=");
      return `{...{ ${quote(attribute.slice(0, equals))}: ${attribute.slice(equals + 2, -1)} }}`;
    });
    attributes.splice(0, attributes.length, `{...(invocationProps(${jsxAttributeRecord(inputs)}, ${htmlInputs}, ${JSON.stringify([STATUS_INPUTS_PROP, BINDING_INPUTS_PROP, LITERAL_INPUTS_PROP])}) as any)}`, ...attachments);
  }
  if (!component && (forwards || node.attributes.some(attribute => Object.hasOwn(Object.prototype, attribute.name)))) {
    const attachments = attributes.filter(attribute => attribute.startsWith("{@attach") || attribute.startsWith("bind:"));
    const inputs = attributes.filter(attribute => !attachments.includes(attribute));
    attributes.splice(0, attributes.length, `{...nativeAttributes(${jsxAttributeRecord(inputs)})}`, ...attachments);
  }
  if (!component && isVoidElement(node.name)) return layoutElement(name, attributes);
  const previousBoundSelect = context.boundSelect;
  const previousSelectSelection = context.selectSelection;
  if (node.name === "select") context.boundSelect = controlledNames.has("value") ? true
    : root && context.rootBindings?.includes("value") ? `${context.nativeBindingReadName}("value") !== undefined` : false;
  if (node.name === "select") context.selectSelection = selectSelectionName;
  const previousPreformatted = context.preformatted;
  if (node.name === "pre" || node.name === "textarea" || node.name === "option") context.preformatted = true;
  const childNodes = content === undefined ? componentChildren.map((child) => renderNode(child, false, scope, lowering, context)) : [content];
  // Svelte drops whitespace at the start and end of a tag, so the markup leaves it out.
  if (!context.preformatted && componentChildren[0]?.kind === "text" && content === undefined) childNodes[0] = childNodes[0]!.replace(/^ /, "");
  if (!context.preformatted && componentChildren.at(-1)?.kind === "text" && content === undefined) childNodes[childNodes.length - 1] = childNodes.at(-1)!.replace(/ $/, "");
  context.preformatted = previousPreformatted;
  const children = childNodes.join("");
  context.boundSelect = previousBoundSelect;
  context.selectSelection = previousSelectSelection;
  let markup = layoutElement(name, attributes, childNodes);
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

/** Where the shared render module's import goes, once the component's code shows what it calls. */
const RENDER_IMPORT = "\0html-next:render-import";

function svelteImport(names: readonly string[]): string[] {
  return [names.length === 0 ? 'import type { Snippet } from "svelte";' : `import { ${[...names, "type Snippet"].join(", ")} } from "svelte";`];
}

/** The options `rootAttributes` takes, only those that differ from its defaults. */
function rootAttributeOptions(scope: string | undefined, nativeRoot: boolean, omit: readonly string[], clientOmit: readonly string[], server: string | undefined): string {
  const options = [
    "metadataOnly: true",
    ...(scope === undefined ? [] : [`scope: ${quote(scope)}`]),
    ...(nativeRoot ? [] : ["forwardBindings: true"]),
    ...(omit.length === 0 ? [] : [`omit: ${JSON.stringify(omit)}`]),
    ...(clientOmit.length === 0 ? [] : [`clientOmit: ${JSON.stringify(clientOmit)}`]),
    ...(server === undefined ? [] : [`server: () => ${server}`]),
  ];
  return options.length === 0 ? "" : `, { ${options.join(", ")} }`;
}

const LINE_WIDTH = 100;

/**
 * An element's markup. Svelte renders whitespace between elements as a space, so lines break inside
 * tags: a long start tag puts each attribute on its own line, and long content puts each child
 * element on its own, hugging the tags around it, or after a line break where a space separates it.
 */
function layoutElement(name: string, attributes: readonly string[], children?: readonly string[]): string {
  const indent = (markup: string): string => markup.replaceAll("\n", "\n\t");
  const flat = `<${name}${attributes.map((attribute) => ` ${attribute}`).join("")}`;
  const broken = flat.length > LINE_WIDTH || flat.includes("\n");
  const start = broken ? `<${name}${attributes.map((attribute) => `\n\t${indent(attribute)}`).join("")}` : flat;
  if (children === undefined) return `${start}${broken ? "\n" : ""}>`;
  const inline = `${start}${broken ? "\n" : ""}>${children.join("")}</${name}>`;
  const elements = children.length > 0 && children.every((child) => child === " " || child.startsWith("<") && child.endsWith(">"));
  if (!elements || !inline.includes("\n") && inline.length <= LINE_WIDTH) return inline;
  return `${start}${children.map((child, index) => child === " " ? ""
    : `${children[index - 1] === " " ? ">\n\t" : "\n\t>"}${indent(child.slice(0, -1))}`).join("")}\n></${name}>`;
}

interface RootScope extends Scope {
  readonly tag: string;
  readonly props: readonly string[];
  readonly propContracts: Readonly<Record<string, PropContract>>;
  readonly stateNames: readonly string[];
  readonly preservesRootFocus: boolean;
}

export function generateSvelteOutput(definition: ComponentDefinition, version: string, options: SvelteConversionOptions = {}): SvelteConversionOutput {
  definition = condenseWhitespace(definition);
  const { importedNames, refs } = checkSupported(definition);
  const target = targetComponent(definition);
  const usesController = (definition.module ?? definition.controller) !== undefined;
  const styles = compileComponentStylesForSvelte(definition.css, definition, undefined, options.componentGraph);
  const hostStateNames = componentStateNames(definition, options.componentGraph);
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const seeded = states.filter(state => state.initializer !== undefined);
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const data = declarations.filter((declaration): declaration is DataDeclaration => declaration.kind === "data");
  const contexts = declarations.filter((declaration): declaration is ContextDeclaration => declaration.kind === "context");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const code = new Map(target.props.map((prop) => [prop.name, `checkedProps[${quote(prop.name)}]`]));
  const types = new Map<string, Static>(target.props.map((prop) => [prop.name, { type: prop.contract.select === undefined ? normalizeType(prop.contract.type) : { kind: "union", members: prop.contract.select.options.map((option) => option.type) }, nullable: true }]));
  const expressionScope: Scope = { ...referenceContext(definition), code, types };
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
    + "applyNamespacedAttributes htmlNextPrepared htmlNextPreparationId htmlNextPlaced htmlNextAccepted htmlNextPlain checkListedProp retainedBindingInput htmlPropValue parseHtmlLiteral acceptsBindingDestination classText styleText Decoration Props Snippet untrack useComponentHost useLifecycle propValidityState getContext setContext getAllContexts HtmlNextContextScope rootElement rootFocusPending event children slots rest rootAttrs rootMetadata nativeAttributes htmlAttributeInputs invocationProps forwardedAttrs forwardedAttributes next guard detail warnUnless write isString isNumber isInteger isBoolean rootAttributes publishState injectContext writePath checkedSlot setProperty decorate checkedProps acceptedProps inputAccepted propValidityContract propInputValues hostState hostStateTokens checkedProp selectedPropNode selectedBindingNode mountPropValidity updatePropValidity attachGenericBinding attachBoundControl syncBoundControl controlDefaults prepareHydrationControls observeBoundOptions BoundDefaults attachNativeEvents dispatchDeclared dispatchDeclaredTargets reflectedProp retainedSanitizedHtml useDataRead cycleCheckedComputed retainedValue retainedStructuralValue truthy text attribute math arithmetic concat join sortBy eachRows uniqueKeys").split(" "));
  for (const name of ["PropInputs", "InputBindings", "propInputs", "statusInputs", "inputVersion", "inputStatus", "inputReads", "checkPropInput", "requireInputStatus", "READY_INPUT", "UNRESOLVED_INPUT", "inputComputed", "inputRead", "inputDefault", "evaluateInput", "initializedState", "copyStateSeed"]) reserved.add(name);
  for (const name of [...importedNames, ...SVELTE_RENDER_EXPORTS]) reserved.add(name);
  const inputNames = new Map(target.props.map((prop) => [prop.name, freshIdentifier("htmlNextInputValue")]));
  for (const name of inputNames.values()) reserved.add(name);
  const declarationName = (name: string): string => !isScriptIdentifier(name) || reserved.has(name) || name.startsWith("$") || /^retained\d+$|^htmlSite\d+$|^htmlNextStructural\d+$/.test(name) ? freshIdentifier("htmlNextValue") : name;
  const contextNames = new Map<ContextDeclaration, string>();
  for (const declaration of contexts) {
    const alias = declaration.as ?? declaration.name;
    const variable = freshIdentifier("htmlNextContext");
    contextNames.set(declaration, variable);
    code.set(alias, `${variable}.value`);
    const provider = options.componentGraph?.get(declaration.from)?.declarations?.find(value => value.kind === "state" && value.name === declaration.name);
    const declared = provider?.kind === "state" ? declarationTypeNode(provider.type, provider.shape) : undefined;
    types.set(alias, declared === undefined ? { type: { kind: "terminal", name: "unknown" }, nullable: true } : { ...present(declared), nullable: true });
  }
  // Each slot's `as` list, which the consumer builds (`childListSource`): entries typed by the accepted components' props.
  const listRoots = Object.entries(definition.contract.slots ?? {}).flatMap(([slot, declared]) => {
    if (declared.as === undefined) return [];
    const variable = declarationName(declared.as);
    taken.add(variable);
    const fields = new Map<string, PropContract>();
    for (const tag of declared.accepts ?? []) {
      for (const [name, prop] of Object.entries(options.componentGraph?.get(tag)?.contract.props ?? {})) if (!fields.has(name)) fields.set(name, prop);
    }
    code.set(declared.as, variable);
    types.set(declared.as, { type: { kind: "list", item: { kind: "object", open: false, fields: [...fields].map(([name, prop]) => ({ name, optional: false,
      type: prop.required || "default" in prop ? normalizeType(prop.type) : { kind: "union", members: [normalizeType(prop.type), { kind: "terminal", name: "null" }] } })) } }, nullable: false });
    // ponytail: the TypeScript type leaves out an optional prop's null, which the template's reads handle, so `$row[$column.field]` checks.
    return [{ variable, slot, as: declared.as, type: `readonly Readonly<{ ${[...fields].map(([name, prop]) => `${quote(name)}: ${typeSource(prop.type)};`).join(" ")} }>[]` }];
  });
  // A component another accepts gives its list entry its contexts, which content placed for it reads.
  const accepted = [...options.componentGraph?.values() ?? []].some((other) =>
    Object.values(other.contract.slots ?? {}).some((slot) => slot.as !== undefined && slot.accepts?.includes(definition.contract.tag) === true));
  const plainSlots = new Set(repeatedSlotNames(definition));
  if (accepted) for (const slot of definition.slots ?? []) plainSlots.add(slot.name ?? "");
  for (const name of plainSlots) if (Object.keys(definition.contract.slots?.[name]?.props ?? {}).length > 0 ||
    definition.slots?.some(slot => (slot.name ?? "") === name && (slot.props?.length ?? 0) > 0)) plainSlots.delete(name);
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
  // A named declared script's status is the component's own state, read as a <data> read's is.
  const scriptNames = new Map<string, string>();
  for (const script of definition.scripts ?? []) {
    if (script.name === undefined) continue;
    const name = freshIdentifier(`htmlNextScript${scriptNames.size}`);
    scriptNames.set(script.name, name);
    code.set(script.name, name);
    types.set(script.name, { type: { kind: "object", open: false, fields: [
      { name: "pending", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "ok", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "error", type: { kind: "terminal", name: "unknown" }, optional: false },
    ] }, nullable: false });
  }
  const headed = declaresHead(definition);
  const computedNames = new Map<ReactiveDeclaration, string>();
  for (const declaration of [...states, ...computed]) {
    const name = declarationName(declaration.name);
    if (declaration.kind === "computed") computedNames.set(declaration, name);
    code.set(declaration.name, declaration.kind === "computed" ? `${name}.get()` : declaration.initializer !== undefined ? `${name}.value` : name);
    const declared = declarationTypeNode(declaration.type, declaration.shape);
    // An initializer does not constrain later writes to untyped state.
    const inferred = declaration.kind === "state" || declaration.expression === undefined
      ? { type: { kind: "terminal", name: "unknown" }, nullable: true } as Static
      : typeOf(declaration.expression.ast, expressionScope);
    const typed = declared === undefined ? inferred : present(declared);
    types.set(declaration.name, { ...typed, nullable: typed.nullable || declaration.expression === undefined || declaration.kind === "computed" });
  }
  const availability = new Map([
    ...seeded.map(state => [state.name, code.get(state.name)!.replace(/\.value$/, ".status()")] as const),
    ...contexts.map(context => [context.as ?? context.name, `${contextNames.get(context)!}.status`] as const),
  ]);
  const scope: RootScope = {
    ...expressionScope,
    tag: definition.contract.tag,
    props: target.props.map((prop) => prop.name),
    propContracts: definition.contract.props,
    stateNames: hostStateNames,
    preservesRootFocus: rootArms(definition.template) !== undefined,
    code,
    types,
  };
  const lowering = new Lowering("warnUnless");
  const context: RenderContext = { lowering, definition, availability, observe: source => inputScope(source, (name, read) => read !== scope.code.get(name) ? undefined
    : Object.hasOwn(definition.contract.props, name) ? `inputStatus(${quote(name)}, true)`
      : availability.get(name) ?? (computed.some(value => value.name === name) ? read.replace(/\.get\(\)$/, ".status()") : undefined)), handlerNames, inputNames, imports: new Set(), slotsByTag: options.slotsByTag, usesScopedSlots: false, propContractsByTag: options.propContractsByTag,
    componentGraph: options.componentGraph, eachKeys: [], listedChildren: new Map(), usesChildOutlets: false, plainSlots, outletProps: [],
    ...(styles.hashed === true ? { styleOwner: definition.contract.tag } : {}),
    hostClass: styles.components !== undefined, styledComponents: new Set(styles.components ?? []),
    htmlSites: 0, localHtmlSites: new Set(), optionHtmlSites: new Set(), retentions: new Map(), localRetentions: new Set(),
    usesAttributeBinding: false, usesComponentBindings: false, usesDeclaredFormats: false, usesProperties: false, usesDecorations: false, usesStyleDecorations: false, usesDecorationAttachment: false, rootBindings: options.rootBindings, initialBindingsName: freshIdentifier("htmlNextInitialBindings"), initialBindingReadName: freshIdentifier("htmlNextInitialBinding"), nativeBindingReadName: freshIdentifier("htmlNextNativeBinding"), rootBindingAttributeName: freshIdentifier("htmlNextRootBindingAttribute"), usesControls: false, usesNestedBindings: false, boundSelect: false, controlAttachmentName: freshIdentifier("htmlNextControl"), bindingHelperName: freshIdentifier("boundAttribute"),
    bindingValueName: freshIdentifier("boundValue"), rootAttributeBindings: new Set(),
    usesEvents: target.events.length > 0, refs, refsName: freshIdentifier("htmlNextRefs"),
    resetRootRefs: usesController || refs.size > 0 || handlers.some((handler) => handler.steps.some((step) => step.kind === "focus" || step.kind === "validate")),
    refAttachmentName: freshIdentifier("htmlNextRef"), refTargetName: freshIdentifier("htmlNextRefTarget"), reflectedPropName: freshIdentifier("htmlNextReflectProp"),
    preformatted: false, freshIdentifier,
    localName: (authored: string, fallback: string) => freshIdentifier(isScriptIdentifier(authored) && !reserved.has(authored) && !authored.startsWith("$") ? authored : fallback) };
  const iteratedRefs = iteratedRefNames(definition);
  const nestedDepthLimit = options.guardNestedDepth ? definitionMayInvokeComponents(definition) ? 32 : 33 : undefined;
  const nestedDepthName = freshIdentifier("htmlNextDepth");
  const markup = renderNode(definition.template, true, scope, lowering, context);
  const generics = selectorGenerics(definition.contract.props);
  const genericParameters = new Map(generics.map(({ from, parameter }) => [from, parameter]));
  const dependentParameters = new Map(generics.map(({ from, parameter }) => [from, `NoInfer<${parameter}>`]));
  const nativeAttributes = freshIdentifier("HTMLAttributes");
  const rawRest = freshIdentifier("restProps");
  const arms = rootArms(definition.template);
  const rootType = arms === undefined ? getDomInterface(definition.template.name) ?? "HTMLElement"
    : [...new Set(arms.map((arm) => getDomInterface(arm.name) ?? "HTMLElement"))].join(" | ");
  const eventCallbacks = target.events.flatMap((event) => [`on${event.name}`, `on${event.name}capture`]
    .filter((name) => definition.contract.props[name] === undefined)
    .map((name) => ({ name, type: `((event: CustomEvent<${event.detailType}>) => void) | null` })));
  const slotType = (slot: SlotContract): string => `Snippet<[${(slot.props?.length ?? 0) === 0 ? "Record<string, any>"
    : slot.declared !== undefined ? slotPropsType(slot.declared) : `Readonly<{ ${slot.props!.map((name) => `${quote(name)}: any;`).join(" ")} }>`}]>`;
  // An accepted child also takes snippets for the slots only its parent's `<slot of>` outlets render.
  const slotTypes = [...target.slots.map((slot) => `${quote(slot.name ?? "")}?: ${slotType(slot)} | null;`),
    ...(accepted ? Object.entries(definition.contract.slots ?? {}) : []).filter(([name]) => !target.slots.some((slot) => (slot.name ?? "") === name))
      .map(([name, declared]) => `${quote(name)}?: Snippet<[${Object.keys(declared.props).length === 0 ? "Record<string, any>" : slotPropsType(declared.props)}]> | null;`)];
  const slotsType = slotTypes.length === 0 ? "Record<string, Snippet<[Record<string, any>]> | null>" : `Readonly<{ ${slotTypes.join(" ")} }>`;
  // Each request is a function prop that answers it, and the event prop Svelte uses for declared events.
  const requestProps = target.requests.map((request) => ({
    request, listenerProp: `on${request.name}`, responder: freshIdentifier("htmlNextResponder"), listener: freshIdentifier("htmlNextRequestListener"),
  }));
  const omittedNative = ["children", "slots", ...target.props.map((prop) => prop.name), ...eventCallbacks.map((event) => event.name),
    ...requestProps.flatMap(({ request, listenerProp }) => [request.propName, listenerProp])];
  const propTypes = [...target.props.map((prop) =>
    `${quote(prop.name)}${prop.contract.required ? "" : "?"}: ${genericParameters.get(prop.name) ?? dependentPropTypeSource(prop.contract, dependentParameters)};`),
  ...requestProps.flatMap(({ request, listenerProp }) => [
    `${quote(request.propName)}?: ${responderType(request)} | null;`,
    `${quote(listenerProp)}?: (${requestListenerType(request)}) | null;`,
  ])].join("\n  ");
  const selectedInputs = new Map(target.props.filter((prop) => prop.contract.select !== undefined).map((prop) => [prop.name, {
    raw: freshIdentifier("htmlNextInput"), retain: freshIdentifier("htmlNextBoundInput"),
  }]));
  const structuredInputs = new Set(target.props.filter((prop) => prop.contract.select?.options.some((option) => hasStructuredHtmlInput(option.type))).map((prop) => prop.name));
  const structuredReader = (name: string): string => structuredInputs.has(name) ? ", parseHtmlLiteral" : "";
  const destructured = [...target.props.map((prop) => `${quote(prop.name)}: ${selectedInputs.get(prop.name)?.raw ?? inputNames.get(prop.name)}`),
    ...requestProps.flatMap(({ request, listenerProp, responder, listener }) => [`${quote(request.propName)}: ${responder}`, `${quote(listenerProp)}: ${listener}`])].join(", ");
  const hasProps = target.props.length > 0;
  const controllerStateTypes = Object.fromEntries(states.flatMap((state) => {
    const type = declarationTypeNode(state.type, state.shape);
    return type === undefined ? [] : [[state.name, type]];
  }));
  const usesControllerTypeChecks = usesController && Object.keys(controllerStateTypes).length > 0;
  const controllerTypesName = freshIdentifier("htmlNextControllerStateTypes");
  const publicChildren = definition.contract.props.children !== undefined;
  const publicSlots = definition.contract.props.slots !== undefined;
  const internalProps = [!publicChildren ? "children" : undefined, !publicSlots ? "slots" : undefined,
    ...(hasProps ? [`${quote(STATUS_INPUTS_PROP)}: statusInputs`] : [])].filter((name) => name !== undefined);
  const selectors = [...new Set(target.props.flatMap((prop) => prop.contract.select === undefined ? [] : [prop.contract.select.from]))];
  const validityContract = { props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) =>
    [name, { ...prop, type: prop.select === undefined ? normalizeType(prop.type)
      : { kind: "union" as const, members: prop.select.options.map((option) => option.type) } }])) };
  const inputSource = (name: string): string => {
    return selectedInputs.has(name)
      ? `(${selectedInputs.get(name)!.raw} === undefined && !Object.hasOwn((rest[${quote(BINDING_INPUTS_PROP)}] as object | undefined) ?? {}, ${quote(name)}) ? undefined : ${inputNames.get(name)}.value)`
      : inputNames.get(name)!;
  };
  const selectorSource = (name: string): string | undefined => {
    const selector = definition.contract.props[name];
    // A selecting prop is a finite ordinary type. Read its accepted value without
    // depending on the aggregate checkedProps, which also reads this selected input.
    return selector === undefined ? code.get(name)
      : `propInputs.value(${quote(name)}, ${inputSource(name)}, statusInputs as InputBindings | undefined, inputAccepted)`;
  };
  const literalInputName = freshIdentifier("htmlNextLiteralInput");
  // Native HTML parses the model once, while selected-type validity follows the current selector.
  const literalInitialsName = freshIdentifier("htmlNextLiteralInitials");
  const propTypeSource = (prop: (typeof target.props)[number], binding = false, values?: string): string => {
    const select = prop.contract.select;
    if (select === undefined) return JSON.stringify(normalizeType(prop.contract.type));
    const selector = values !== undefined && Object.hasOwn(definition.contract.props, select.from) ? `${values}[${quote(select.from)}]` : selectorSource(select.from);
    return `${binding ? "selectedBindingNode" : "selectedPropNode"}(${selector}, ${literalValueSource(select.options)})`;
  };
  const selectedInputSources = target.props.flatMap((prop) => {
    const input = selectedInputs.get(prop.name);
    if (input === undefined) return [];
    return [
      `const ${input.retain} = retainedBindingInput((value: unknown) => { acceptedProps[${quote(prop.name)}] = value; }, ${"default" in prop.contract ? literalValueSource(prop.contract.default) : "null"}${structuredReader(prop.name)});`,
      `let ${inputNames.get(prop.name)} = $derived.by(() => ${input.retain}((rest[${quote(BINDING_INPUTS_PROP)}] as Record<string, () => { value: unknown; attribute: string | undefined } | symbol> | undefined)?.[${quote(prop.name)}], () => ({ value: ${literalInputName}(${quote(prop.name)}, ${input.raw}, ${selectorSource(prop.contract.select!.from)}, true), raw: (rest[${quote(LITERAL_INPUTS_PROP)}] as Record<string, { raw: unknown }> | undefined)?.[${quote(prop.name)}]?.raw ?? ${input.raw} ?? null, html: Object.hasOwn((rest[${quote(LITERAL_INPUTS_PROP)}] as object | undefined) ?? {}, ${quote(prop.name)}) }), ${propTypeSource(prop, true)}));`,
    ];
  });
  const checkedPropSources = propInputOrder(target.props).map((prop) =>
    `    ${objectKey(prop.name)}: propInputs.value<${typeSource(prop.contract.type)}${prop.contract.required ? "" : " | null"}>(${quote(prop.name)}, ${inputSource(prop.name)}, statusInputs as InputBindings | undefined, inputAccepted),`);
  const inputReadNames = new Map(target.props.map(prop => [prop.name, {
    value: freshIdentifier("htmlNextInputRead"), status: freshIdentifier("htmlNextInputStatus"), supplied: freshIdentifier("htmlNextInputSupplied"),
  }]));
  const observedDeclarations = inputScope(scope, (name, read) => Object.hasOwn(definition.contract.props, name) ? `inputReads[${quote(name)}]!.status`
    : availability.get(name) ?? (computed.some(value => value.name === name) ? read.replace(/\.get\(\)$/, ".status()")
      : states.some(state => state.name === name) ? `((${read}) === undefined ? UNRESOLVED_INPUT : READY_INPUT)` : undefined));
  const stateSources = states.map((state) => {
    if (state.initializer === undefined) return `let ${code.get(state.name)!} = $state<${typeScript(scope.types.get(state.name)!)}>(${state.expression === undefined ? "null" : lowering.value(state.expression.ast, uncheckedReferences(scope))});`;
    const read = conformingRead(state.initializer, scope, context, lowering.value(state.initializer.ast, observedDeclarations));
    const node = declarationTypeNode(state.type, state.shape);
    const accepts = node === undefined ? "true" : strictTypeCheck(node, "next", context);
    const type = node === undefined ? "unknown" : typeScript(present(node));
    return `const ${code.get(state.name)!.replace(/\.value$/, "")}: ReturnType<typeof initializedState<${type}>> = initializedState<${type}>(() => evaluateInput(() => (${read.source}) as any), (next: unknown) => ${accepts}, copyStateSeed, () => ${lowering.use("warnUnless")}(false, ${quote(`initializer:${state.name}`)}, ${quote(`State \`${state.name}\` does not satisfy its declared type.`)}));`;
  });
  const computedSources = computed.map((value) => {
    const observed = observedDeclarations;
    const read = value.expression === undefined ? { source: "null", invalid: false }
      : conformingRead(value.expression, scope, context, lowering.value(value.expression.ast, observed));
    const type = typeScript(scope.types.get(value.name)!);
    const name = computedNames.get(value)!;
    return read.invalid ? `let ${name}Previous: ${type} = null;\nconst ${name}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => (${read.source}) as any, cycleCheckedComputed, next => (next as unknown) === Symbol.for("html-next.invalid-result") ? ${name}Previous : (${name}Previous = next));`
      : `const ${name}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => (${read.source}) as any, cycleCheckedComputed);`;
  });
  const handlerScope: Scope = withReferenceTypes({ ...scope, code: new Map(scope.code).set("$$event", "event"),
    types: new Map(scope.types).set("$$event", { type: { kind: "terminal", name: "event" }, nullable: false }) }, [["$$event", undefined]]);
  const usesTargetDispatch = handlers.some((handler) => handler.steps.some((step) => step.kind === "dispatch" && step.target !== undefined));
  const handlerSources = handlers.map((handler) => `function ${handlerNames.get(handler.name)!}(event: Event): void {\n${handler.steps.map((step) => {
    const condition = step.guard === undefined ? undefined : conformingCondition(step.guard, handlerScope, lowering, context);
    const guardName = condition === undefined ? undefined : context.freshIdentifier("guard");
    const guard = condition === undefined ? "" : `const ${guardName} = ${condition.source}; if (${condition.invalid ? `(${guardName} as unknown) !== Symbol.for('html-next.invalid-result') && ` : ""}${guardName}) `;
    if (step.kind === "dispatch") {
      const declaration = target.events.find((event) => event.name === step.event);
      if (declaration === undefined) fail("HT034", `Handler \`${handler.name}\` dispatches undeclared event \`${step.event}\`.`);
      const detail = context.freshIdentifier("detail");
      const source = step.value === undefined ? "undefined" : conformingRead(step.value, handlerScope, context, lowering.value(step.value.ast, handlerScope)).source;
      if (step.target !== undefined) {
        context.refs.add(step.target);
        return `  ${guard}{ const ${detail}: unknown = ${source}; if (${detail} !== Symbol.for('html-next.invalid-result')) dispatchDeclaredTargets(${context.refsName}.get(${quote(step.target)}), ${quote(step.event)}, ${detail}, ${JSON.stringify(declarationTypeNode(declaration.type, declaration.shape))}, ${JSON.stringify({ bubbles: declaration.bubbles, composed: declaration.composed, cancelable: declaration.cancelable })}); }`;
      }
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
    const destination = scope.code.get(state.name)!;
    const read = conformingRead(step.value, handlerScope, context, lowering.value(step.value.ast, handlerScope));
    const proven = !read.invalid && provenWrite(step, definition);
    // A proven write is never null; any other null or undefined reverts to the declared value.
    const source = proven ? read.source : withRevert(read.source, step.value.ast,
      revertSource(definition, step.writablePath, (segment) => lowering.value(segment.expression, handlerScope)));
    const destinationCheck = proven ? undefined : refusing(handlerDestinationCheck(declarationTypeNode(state.type, state.shape),
      step.writablePath, 1, "value", handlerScope, lowering, (type, value) => strictTypeCheck(type, value, context)));
    const nested = step.writablePath.length > 1;
    const writeTo = (value: string): string => nested ? `writePath(${destination}, [${step.writablePath.slice(1).map((segment) => typeof segment === "object"
      ? lowering.value(segment.expression, handlerScope) : JSON.stringify(segment)).join(", ")}], ${value})` : `${destination} = ${value}`;
    const declared = declarationTypeNode(state.type, state.shape);
    const sameKind = declared !== undefined && category(declared) === category(typeOf(step.value.ast, handlerScope).type);
    if (destinationCheck === undefined && !read.invalid) {
      return `  ${guard}${(proven ? increment(step, definition, destination) : undefined) ?? writeTo(nested || sameKind || declared === undefined ? source : `${source} as typeof ${destination}`)};`;
    }
    // A `$state` variable is written through a setter; a path below it, through `writePath`.
    return `  ${guard}${lowering.use("write")}((next) => ${nested ? writeTo("next") : `(${writeTo("next")})`}, ${source}${writeCheck(destinationCheck, definition, handler, step)});`;
  }).join("\n")}\n}`)
    // A handler that never reads its event takes no parameter.
    .map((source) => /\bevent\b/.test(source.slice(source.indexOf("{"))) ? source : source.replace("(event: Event)", "()"));
  const focusReads: string[] = [];
  if (scope.preservesRootFocus) {
    const match = definition.template.flow;
    const focusCode = new Map(scope.code);
    const focusTypes = new Map(scope.types);
    let focusScope: Scope = { ...scope, code: focusCode, types: focusTypes };
    if (match?.kind === "match" && match.expressionPlan !== undefined) {
      const expression = lowering.value(match.expressionPlan.ast, scope);
      focusReads.push(`  void (${expression});`);
      if (match.alias !== undefined) {
        focusCode.set(match.alias, `(${expression})`);
        focusTypes.set(match.alias, typeOf(match.expressionPlan.ast, scope));
        focusScope = withReferenceTypes(focusScope, [[match.alias, referenceType(match.expressionPlan.ast, scope)]]);
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
  let script = [
    `<script lang="ts"${generics.length === 0 ? "" : ` generics=${quote(generics.map(({ declaration }) => declaration.replaceAll('"', "'")).join(", "))}`}>`,
    `import type { HTMLAttributes${nativeAttributes === "HTMLAttributes" ? "" : ` as ${nativeAttributes}`} } from "svelte/elements";`,
    ...(options.modulePreparation === undefined ? [] : [`import { usePreparedModule } from ${quote(options.bindingsSpecifier ?? "./bindings.svelte")};`]),
    ...svelteImport([...(nestedDepthLimit !== undefined || context.imports.size > 0) ? ["getContext", "setContext"] : [], ...accepted ? ["getAllContexts"] : [], ...(hasProps || usesController || (options.rootBindings?.length ?? 0) > 0 || context.usesControls || context.usesAttributeBinding || scope.preservesRootFocus) ? ["untrack"] : []]),
    RENDER_IMPORT,
    ...(usesController ? [`import { useComponentHost } from ${quote(options.hostSpecifier ?? "./host.svelte")};`] : []),
    ...(requestProps.length === 0 ? [] : [
      ...(usesController ? [
        `import { ${REQUEST_CHECK} } from ${quote(options.propsSpecifier ?? "./props")};`,
        `import { ${REQUEST_HELPERS.join(", ")} } from ${quote(options.requestsSpecifier ?? "./requests")};`,
      ] : []),
      `import type { ${REQUEST_TYPES.join(", ")} } from ${quote(options.requestsSpecifier ?? "./requests")};`,
    ]),
    ...(definition.lifecycle === undefined ? [] : [`import { useLifecycle } from ${quote(options.connectionSpecifier ?? "./connection.svelte")};`]),
    ...(!headed ? [] : ["/* html-next head imports */"]),
    ...(computed.length > 0 || seeded.length > 0 ? [`import { cycleCheckedComputed${seeded.length > 0 ? ", initializedState" : ""} } from ${quote(options.reactivitySpecifier ?? "./reactivity.svelte")};`] : []),
    ...(data.some((declaration) => declaration.source !== undefined) ? [`import { useDataRead } from ${quote(options.dataSpecifier ?? "./data.svelte")};`] : []),
    ...(templateForwardsAttributes(definition.template) ? [`import { forwardedAttributes } from ${quote(options.attributesSpecifier ?? "./attributes")};`] : []),
    ...(!context.usesNamespacedAttributes ? [] : [`import { applyNamespacedAttributes } from ${quote(options.attributesSpecifier ?? "./attributes")};`]),
    ...(context.usesControls ? [`import { attachGenericBinding, attachBoundControl, syncBoundControl, controlDefaults, prepareHydrationControls, observeBoundOptions, type BoundDefaults } from ${quote(options.controlSpecifier ?? "./control")};`] : []),
    ...(context.usesEvents ? [`import { attachNativeEvents${target.events.length === 0 ? "" : ", dispatchDeclared" + (usesTargetDispatch ? ", dispatchDeclaredTargets" : "")} } from ${quote(options.eventsSpecifier ?? "./events")};`] : []),
    ...(context.htmlSites === 0 ? [] : [`import { retainedSanitizedHtml } from ${quote(options.htmlSpecifier ?? "./html")};`]),
    ...(context.usesDecorations ? [`import { classText, type Decoration } from ${quote(options.decorationsSpecifier ?? "./decorations")};`] : []),
    ...(context.usesStyleDecorations ? [`import { styleText } from ${quote(options.styleSpecifier ?? "./style/style.js")};`] : []),
    ...((context.usesComponentBindings || context.usesDeclaredFormats) ? [`import { acceptsBindingDestination } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...(!context.usesSlotPropChecks ? [] : [`import { ${SLOT_PROP_IMPORT} } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(!context.usesHtmlInputs ? [] : [`import { htmlAttributeInputs, invocationProps } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(!context.usesEntryChecks ? [] : [`import { checkPropInput as checkListedProp } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(usesControllerTypeChecks ? [`import { acceptsControllerWrite } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...(hasProps || context.usesInputStatus || computed.length > 0 || seeded.length > 0 || contexts.length > 0 ? [`import { ${hasProps ? "PropInputs, type InputBindings, checkPropInput, mountPropValidity, updatePropValidity, " : ""}requireInputStatus, READY_INPUT, UNRESOLVED_INPUT${computed.length === 0 ? "" : ", inputComputed"}${computed.length === 0 && seeded.length === 0 && !context.usesInputExpressions ? "" : ", inputRead, inputDefault"}${context.usesInputExpressions || seeded.length > 0 ? ", evaluateInput" : ""}${seeded.length === 0 ? "" : ", copyStateSeed"}${usesController && hasProps ? ", propValidityState" : ""}${selectors.length === 0 ? "" : ", selectedPropNode, selectedBindingNode, retainedBindingInput, htmlPropValue"}${structuredInputs.size > 0 ? ", parseHtmlLiteral" : ""} } from ${quote(options.propsSpecifier ?? "./props")};`] : []),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.svelte`)};`),
    ...(context.usesChildOutlets ? [`import HtmlNextContextScope from ${quote(options.contextSpecifier ?? SVELTE_CONTEXT_SPECIFIER)};`] : []),
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
    ...(options.modulePreparation === undefined ? [] : [`const htmlNextPreparationId = $props.id();`, `const htmlNextPrepared = usePreparedModule(() => import(${quote((definition.module ?? definition.controller)!)}), ${JSON.stringify({ tag: definition.contract.tag, source: options.modulePreparation.source })}, htmlNextPreparationId);`]),
    `const rest = ${options.modulePreparation === undefined ? `${rawRest} as Record<string, unknown>` : `$derived(htmlNextPrepared.attributes(${rawRest} as Record<string, unknown>))`};`,
    ...(hasProps ? [`const ${context.reflectedPropName} = reflectedProp();`] : []),
    ...(publicSlots ? [`let slots = $derived(rest[${quote(SLOTS_PROP)}] as Record<string, Snippet<[Record<string, any>]> | null> | undefined);`] : []),
    // The compiled consumer's lists, or the accepted children that join them (`acceptChildren`).
    ...(listRoots.length === 0 ? [] : [`const htmlNextAccepted = acceptChildren({ ${listRoots.map(({ slot }) => `${quote(slot)}: ${JSON.stringify(definition.contract.slots![slot]!.accepts ?? [])}`).join(", ")} }, () => rest[${quote(LISTS_PROP)}]);`]),
    ...listRoots.map(({ variable, slot, type }) => `let ${variable} = $derived.by(() => htmlNextAccepted.list(${quote(slot)}) as ${type});`),
    // The child's own props reach its entry through `inputReads`, declared below, so they are read late.
    // A consumer that builds no list gives the child its slot snippets through `slots` and `children`.
    // Own and borrowed outlets share the child's source frame for ordinary content.
    ...(accepted ? [`const htmlNextPlaced = ownChild(() => rest[${quote(ENTRY_PROP)}], getAllContexts(), ${hasProps ? "() => inputReads" : "undefined"}, { tag: ${quote(definition.contract.tag)}, props: ${JSON.stringify(target.props.map((prop) => prop.name))}, slots: () => ({ ...slots${publicChildren ? "" : ', ...(children === undefined ? {} : { "": children })'} }), root: () => rootElement });`] : []),
    ...(plainSlots.size === 0 ? [] : [`const htmlNextPlain = usePlainSlots((name: string) => ((slots as Readonly<Record<string, Snippet<[any]> | null>> | undefined)?.[name] ?? (name === "" ? ${publicChildren ? "undefined" : "children"} : undefined))${accepted ? ", htmlNextPlaced" : ""});`]),
    ...context.outletProps,
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
      `untrack(() => ${context.initialBindingsName});`,
      `function ${context.rootBindingAttributeName}(name: string, value?: unknown): unknown {`,
      `  if (arguments.length > 1) ${initialBindingMap}.set(name, value);`,
      `  return untrack(() => ${initialBindingMap}.has(name) ? ${initialBindingMap}.get(name) : (${context.initialBindingsName} as Record<string, unknown>)[name]);`,
      "}",
    ]),
    `const rootAttrs = rootAttributes(() => rest${rootAttributeOptions(context.rootScope, nativeRoot, [...context.rootAttributeBindings], nativeRoot ? context.rootBindings ?? [] : [], initialBindingSources.length === 0 ? undefined : context.initialBindingsName)});`,
    "let rootElement = $state<Element | undefined>(undefined);",
    ...(scope.preservesRootFocus ? ["let rootFocusPending = false;"] : []),
    ...(context.implicitOptionValueName === undefined ? [] : [
      `function ${context.implicitOptionValueName}(value: unknown): string {`,
      "  const text = String(value ?? '');",
      // Native option values collapse only ASCII whitespace; NBSP is significant.
      "  return /^[\\t\\n\\f\\r ]|[\\t\\n\\f\\r ]$|[\\t\\n\\f\\r]| {2}/.test(text) ? text.replace(/[\\t\\n\\f\\r ]+/g, ' ').replace(/^ | $/g, '') : text;",
      "}",
    ]),
    ...(context.usesControls ? [
      `function ${context.controlAttachmentName}(name: "value" | "checked", read: () => unknown, defaults: BoundDefaults, update?: (value: unknown) => unknown, options: { nativeProperty?: boolean; observeOptions?: boolean } = {}) {`,
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
    ...(context.usesAttributeBinding ? [
      `function ${context.bindingHelperName}(name: string, read: () => unknown, update?: (value: any) => void, initialize = false, namespace?: string) {`,
      "  return (element: Element) => {",
      "    // An attribute binding writes only a result that differs from its last.",
      "    let last: string | null | undefined;",
      ...(styles.hashed !== true ? [] : [
        "    // Svelte's style class is all the class attribute holds before the binding first writes, and it stays.",
        "    const scoped = name === 'class' ? element.getAttribute('class') : null;",
      ]),
      "    const apply = (value: unknown) => {",
      "      if (value === Symbol.for('html-next.invalid-result')) return;",
      "      const output = value == null ? null : String(value);",
      "      if (output === last) return;",
      "      last = output;",
      ...(!context.usesNamespacedAttributes ? [] : [
        "      if (namespace !== undefined) { applyNamespacedAttributes(element, [[namespace, name, name.slice(name.indexOf(':') + 1), output, name === 'xlink:href']]); return; }",
      ]),
      ...(styles.hashed !== true ? [
        "      if (output === null) element.removeAttribute(name);",
        "      else element.setAttribute(name, output);",
      ] : [
        "      const written = scoped === null ? output : output === null ? scoped : `${output} ${scoped}`;",
        "      if (written === null) element.removeAttribute(name);",
        "      else element.setAttribute(name, written);",
      ]),
      "    };",
      "    // Options must expose their initial DOM value before the parent select binding runs.",
      "    if (initialize) apply(untrack(read));",
      "    $effect(() => apply(read()));",
      ...(context.usesControls ? ["    return update === undefined ? undefined : attachGenericBinding(element, update);"] : []),
      "  };",
      "}",
    ] : []),
    ...[...context.retentions].filter(([site]) => !context.localRetentions.has(site))
      .map(([site, entry]) => `const retained${site} = ${entry.initial === undefined ? "retainedStructuralValue()" : `retainedValue(${entry.initial})`};`),
    ...(hasProps ? [
      `const acceptedProps: Record<string, unknown> = { ${target.props.map((prop) => `${objectKey(prop.name)}: ${"default" in prop.contract ? literalValueSource(prop.contract.default) : "null"}`).join(", ")} };`,
      "let inputVersion = $state.raw(0);",
      `const propInputs: PropInputs = new PropInputs({ names: Object.keys(acceptedProps), values: acceptedProps, defaults: { ${target.props.filter(prop => "default" in prop.contract).map(prop => `${objectKey(prop.name)}: ${literalValueSource(prop.contract.default)}`).join(", ")} }, invalidate: () => { inputVersion += 1; }, check: (name, value, source, values) => { switch (name) {`,
      ...target.props.map(prop => `  case ${quote(prop.name)}: return checkPropInput(value, ${propTypeSource(prop, false, "values")}, false, ${!prop.contract.required});`),
      "  default: return { ok: false }; } } });",
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
      ...(options.modulePreparation === undefined ? [] : [`htmlNextPrepared.restore(propInputs, { ${propInputOrder(target.props).map(prop => `${objectKey(prop.name)}: ${inputSource(prop.name)}`).join(", ")} }, statusInputs);`]),
      "let checkedProps = $derived.by(() => { void inputVersion; return ({",
      ...checkedPropSources,
      "}); });",
      ...target.props.flatMap(prop => {
        const names = inputReadNames.get(prop.name)!;
        return [
          `let ${names.value} = $derived.by(() => { void checkedProps; return propInputs.read(${quote(prop.name)}); });`,
          `let ${names.status} = $derived.by(() => { void checkedProps; return propInputs.status(${quote(prop.name)}); });`,
          `let ${names.supplied} = $derived.by(() => { void checkedProps; return propInputs.supplied(${quote(prop.name)}); });`,
        ];
      }),
      `const inputReads: Record<string, { readonly value: unknown; readonly status: ReturnType<PropInputs["status"]>; readonly supplied: boolean }> = { ${target.props.map(prop => {
        const names = inputReadNames.get(prop.name)!;
        return `${quote(prop.name)}: { get value() { return ${names.value}; }, get status() { return ${names.status}; }, get supplied() { return ${names.supplied}; } }`;
      }).join(", ")} };`,
      "const inputStatus = (name: string, handlesError: boolean) => requireInputStatus(inputReads[name]!.status, handlesError);",
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
      return [`const ${variable} = injectContext<${typeScript(scope.types.get(declaration.as ?? declaration.name)!)}>(${quote(definition.contract.tag)}, ${quote(declaration.from)}, ${quote(declaration.name)});`];
    }),
    ...stateSources,
    ...states.filter((state) => options.publishedStates?.has(state.name) ?? true).map((state) => `publishState(${quote(definition.contract.tag)}, ${quote(state.name)}, () => ${code.get(state.name)}${availability.has(state.name) ? `, () => ${availability.get(state.name)}` : ""});`),
    ...dataSources,
    ...computedSources,
    ...seeded.map(state => `${code.get(state.name)!.replace(/\.value$/, "")}.start();`),
    ...(scope.preservesRootFocus ? [
      "$effect.pre(() => {",
      ...focusReads,
      "  untrack(() => { rootFocusPending = rootElement !== undefined && rootElement.ownerDocument.activeElement === rootElement; });",
      "});",
    ] : []),
    ...Array.from({ length: context.htmlSites }, (_, index) => index)
      .filter((site) => !context.localHtmlSites.has(site))
      .map((site) => `const htmlSite${site} = ${retainedHtmlSource(context, site)};`),
    ...(hostStateNames.length === 0 ? [] : [
      `let hostState = $derived([${hostStateNames.map((state) => `...hostStateTokens(${quote(state)}, ${code.get(state) ?? state})`).join(", ")}].join(" "));`,
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
      ...(iteratedRefs.size === 0 ? [] : [
        `    if (${JSON.stringify([...iteratedRefs])}.includes(name)) return () => {`,
        `      const recorded = ${context.refsName}.get(name);`,
        `      if (Array.isArray(recorded)) ${context.refsName}.set(name, recorded.filter(member => member !== element));`,
        "      if (current === element) current = undefined;",
        "    };",
      ]),
      "  };",
      "}",
      `function ${context.refTargetName}(name: string): Element | undefined {`,
      `  const recorded = ${context.refsName}.get(name);`,
      "  return Array.isArray(recorded) ? recorded[0] : recorded;",
      "}",
    ]),
    ...(!headed ? [] : [
      ...[...scriptNames.values()].map((name) => `let ${name} = $state<ScriptStatus>({ pending: false, ok: false, error: null });`),
      ...(definition.head === undefined ? [] : ["const htmlNextHeadKept: unknown[] = [];", `useHead(() => rootElement ?? null, () => ${headEntriesSource(definition, (expression) =>
        conformingRead(expression, scope, context, lowering.value(expression.ast, scope)).source, "htmlNextHeadKept")});`]),
      ...(definition.scripts === undefined ? [] : [`const htmlNextHeadScripts = useScripts(() => rootElement ?? null, ${headScriptsSource(definition, (name, event) => {
        const handler = handlers.findIndex((candidate) => candidate.name === name);
        return `${handlerNames.get(name)!}(${handlerSources[handler]!.includes("(event: Event)") ? event : ""})`;
      }, (name) => ({ read: scriptNames.get(name)!, write: (value) => `${scriptNames.get(name)!} = ${value}` }))});`]),
    ]),
    ...(usesController ? [
      ...(usesControllerTypeChecks ? [`const ${controllerTypesName}: Record<string, Parameters<typeof acceptsControllerWrite>[1]> = ${JSON.stringify(controllerStateTypes)};`] : []),
      `useComponentHost(${options.modulePreparation === undefined ? `() => import(${quote((definition.module ?? definition.controller)!)})` : "htmlNextPrepared.load"}, {`,
      ...(options.modulePreparation === undefined ? [] : ["  attach: htmlNextPrepared.attach,"]),
      "  root: () => rootElement ?? null,",
      `  ownsRoot: () => rest[${quote(ROOT_OWNER_PROP)}] !== true,`,
      ...(definition.module === undefined ? [] : ["  module: true,"]),
      `  definition: ${quote(definition.source.file)}, tag: ${quote(definition.contract.tag)}, controller: ${quote(options.controllerSpecifier ?? (definition.module ?? definition.controller)!)},`,
      `  props: () => ${hasProps ? "checkedProps" : "({})"}, propNames: ${JSON.stringify(target.props.map((prop) => prop.name))},`,
      ...(hasProps ? [
        "  inputs: propInputs, inputTrack: (name, kind) => { void inputReads[name]![kind]; },",
        `  propInputs: (name: string) => { ${target.props.filter((prop) => selectedInputs.has(prop.name)).map((prop) => `if (name === ${quote(prop.name)}) return ${inputNames.get(prop.name)}.raw;`).join(" ")} const literal = rest[${quote(LITERAL_INPUTS_PROP)}] as Record<string, { raw: unknown }> | undefined; return literal !== undefined && Object.hasOwn(literal, name) ? literal[name]!.raw : ({ ${target.props.filter((prop) => !selectedInputs.has(prop.name)).map((prop) => `${objectKey(prop.name)}: ${inputNames.get(prop.name)} ?? null`).join(", ")} } as Record<string, unknown>)[name]; },`,
        "  propValidity: (name: string) => propValidityState({ contract: propValidityContract, values: propInputValues }, name),",
      ] : []),
      `  state: { ${states.map((state) => `${objectKey(state.name)}: { get: () => ${code.get(state.name)}, set: (value: unknown) => untrack(() => { ${state.initializer === undefined ? `if (!Object.is(${code.get(state.name)}, value)) ` : ""}${code.get(state.name)} = value as typeof ${code.get(state.name)}; }) }`).join(", ")} },`,
      `  computed: { ${[...[...computed, ...contexts].map((value) => { const name = value.kind === "context" ? value.as ?? value.name : value.name; return `${objectKey(name)}: () => ${code.get(name)}`; }),
        ...listRoots.map(({ as, variable }) => `${objectKey(as)}: () => ${variable}`)].join(", ")} },`,
      ...(!accepted && listRoots.length === 0 ? [] : [`  placed: ${!accepted ? "htmlNextAccepted.roots" : listRoots.length === 0 ? "htmlNextPlaced" : "(name: string) => [...htmlNextPlaced(name), ...htmlNextAccepted.roots(name)]"},`]),
      ...(computed.length === 0 && availability.size === 0 ? [] : [`  availability: { ${[...computed.map(value => `${objectKey(value.name)}: () => ${computedNames.get(value)!}.status()`), ...[...availability].map(([name, status]) => `${objectKey(name)}: () => ${status}`)].join(", ")} },`]),
      `  data: { ${data.map((value) => `${objectKey(value.name)}: () => ${code.get(value.name)}`).join(", ")} },`,
      ...(scriptNames.size === 0 ? [] : ["  scripts: htmlNextHeadScripts,"]),
      ...(usesControllerTypeChecks ? [`  acceptsState: (name: string, keys: readonly string[], value: unknown) => acceptsControllerWrite(value, ${controllerTypesName}[name], keys),`] : []),
      ...controllerInitials(definition, "  "),
      `  refs: ${context.refsName},`,
      `  dispatch: (root: Element, name: string, detail?: unknown) => { switch (name) { ${target.events.map((event) => `case ${quote(event.name)}: return dispatchDeclared(root, name, detail, ${JSON.stringify(declarationTypeNode(event.type, event.shape))}, ${JSON.stringify({ bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable })});`).join(" ")} default: return root.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false })); } },`,
      ...(requestProps.length === 0 ? [] : [
        `  request: ${frameworkRequestSource(target.requests, definition.source.file)},`,
        `  responders: ${respondersSource(target.requests, (prop) => requestProps.find(({ request }) => request.propName === prop)!.responder,
          (request) => requestProps.find((entry) => entry.request === request)!.listener)},`,
      ]),
      "});",
    ] : []),
    ...handlerSources,
    ...(definition.lifecycle === undefined ? [] : [`useLifecycle(() => rootElement ?? null, ${(["connect", "disconnect"] as const).map((type) => {
      const handler = handlers.findIndex((candidate) => candidate.name === definition.lifecycle![type]);
      if (handler < 0) return "undefined";
      // A handler that reads $event gets a connection event, as a controller's host.on callback does.
      return `() => ${handlerNames.get(handlers[handler]!.name)!}(${handlerSources[handler]!.includes("(event: Event)") ? `new Event(${quote(type)})` : ""})`;
    }).join(", ")});`]),
  ].join("\n").replace(/<\/script/gi, match => "<\\/" + match.slice(2)) + "\n</script>";
  const headSpecifier = quote(options.headSpecifier ?? "./head.svelte");
  if (headed) script = script.replace("/* html-next head imports */", [
    `import { ${["headAttribute", "headAttributes", "headJson", "headText", "useHead", "useScripts"].filter((name) => new RegExp(`\\b${name}\\b`).test(script)).join(", ")} } from ${headSpecifier};`,
    `import type { ${["DeclaredScript", "HeadEntry", "HeadScript", "ScriptStatus"].filter((name) => new RegExp(`\\b${name}\\b`).test(script)).join(", ")} } from ${headSpecifier};`,
  ].join("\n"));
  const open = script.slice(0, script.indexOf("\n"));
  let body = script.slice(open.length + 1, script.lastIndexOf("\n</script>"));
  let template = markup;
  // The root is a variable only for code that reads it.
  const ROOT_ELEMENT = /^let rootElement = \$state<Element \| undefined>\(undefined\);\n?/m;
  if (!/\brootElement\b/.test(body.replace(ROOT_ELEMENT, "")) && !/\brootElement\b/.test(template.replace("bind:this={rootElement}", ""))) {
    body = body.replace(ROOT_ELEMENT, "");
    template = template.replace(/\s*bind:this=\{rootElement\}/, "");
  }
  const rendered = [...new Set([...lowering.helpers(), ...context.usesSlotPropChecks ? ["warnUnless"] : [], ...SVELTE_RENDER_COMPONENTS.filter((name) => new RegExp(`\\b${name}\\b`).test(`${body}\n${template}`))])].sort();
  body = body.replace(`${RENDER_IMPORT}\n`, rendered.length === 0 ? "" : `import { ${rendered.join(", ")} } from ${quote(options.renderSpecifier ?? SVELTE_RENDER_SPECIFIER)};\n`);
  // Svelte's convention indents the script under its tag.
  body = lowering.referenceDeclarations().join("\n") + "\n" + body;
  const formatted = formatSvelteScript(body, `${definition.contract.name}.ts`).trimEnd().split("\n").map((line) => line === "" ? line : `\t${line}`).join("\n");
  const style = styles.css === "" ? "" : `\n<style>\n${formatSvelteScript(styles.css, `${definition.contract.name}.css`).trimEnd().split("\n").map((line) => line === "" ? line : `\t${line}`).join("\n")}\n</style>\n`;
  const component = `<!-- Generated by HTML Next ${version} for Svelte 5. Do not edit. -->\n${open}\n${formatted}\n</script>\n\n${template}\n${style}`;
  return { component, usesHtml: context.htmlSites > 0,
    helpers: [
      ...(templateForwardsAttributes(definition.template) || context.usesNamespacedAttributes ? ["attributes" as const] : []),
      ...(options.modulePreparation === undefined ? [] : ["bindings" as const]),
      ...(hasProps || context.usesSlotPropChecks || context.usesHtmlInputs || context.usesInputStatus || computed.length > 0 || seeded.length > 0 || contexts.length > 0 || usesControllerTypeChecks || context.usesComponentBindings || context.usesDeclaredFormats || target.events.length > 0 ||
        (usesController && requestProps.length > 0) ? ["props" as const] : []),
      ...(context.htmlSites > 0 ? ["html" as const] : []),
      ...(context.usesEvents ? ["events" as const] : []),
      ...(context.usesControls ? ["control" as const] : []),
      ...(context.usesDecorations ? ["decorations" as const] : []),
      ...(context.usesStyleDecorations ? ["style" as const] : []),
      ...(data.some((declaration) => declaration.source !== undefined) ? ["data" as const] : []),
      ...(usesController ? ["host" as const] : []),
      ...(usesController || definition.lifecycle !== undefined || headed || data.some((declaration) => declaration.source !== undefined) ? ["connection" as const] : []),
      ...(computed.length > 0 || seeded.length > 0 || usesController ? ["reactivity" as const] : []),
      ...(rendered.length > 0 ? ["render" as const] : []),
      ...(requestProps.length > 0 ? ["requests" as const] : []),
      ...(headed ? ["head" as const] : []),
      ...(context.usesChildOutlets ? ["context" as const] : []),
    ] };
}
