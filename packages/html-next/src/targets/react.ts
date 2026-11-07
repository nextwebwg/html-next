import { entryTags } from "../entry-origin.js";
import { literalValueSource } from "./shared.js";
import { ITERATION_INDEX } from "../expression.js";
import { attributeNamespace } from "../dom-attributes.js";
import { namespacedAttributeSource } from "./shared.js";
import { referenceContext, referenceType, uncheckedReferences, withReferenceTypes } from "./reference-types.js";
import { TypeScriptLowering } from "./typed-lowering.js";
/** React output is compiled from the same checked component definition as the browser runtime. */
import { bindingRevertSource, controllerInitials, revertSource, withRevert } from "./state-roots.js";
import { isScriptIdentifier } from "./shared.js";
import { fail } from "../diagnostics.js";
import { compilePath, isEnumeratedBoolean, type ExpressionNode } from "../expression.js";
import { parseDuration } from "../duration.js";
import { asciiLowerCase, componentName, kebabCase, propAttribute } from "../names.js";
import { isPreformattedElement } from "../language.js";
import { getDomInterface } from "../platform.js";
import { retainedSlotNames, definitionMayInvokeComponents, elementMatchRoot, iteratedRefNames, rootArms, templateForwardsAttributes, type ComponentDefinition, type ContextDeclaration, type DataDeclaration, type ElementNode, type EventBinding, type HandlerDeclaration, type ReactiveDeclaration, type SlotContract, type SlotNode, type TemplateNode } from "../template.js";
import { REACT_EVENTS_EXPORTS } from "./react-events.js";
import { REACT_RENDER_EXPORTS, REACT_RENDER_SPECIFIER } from "./react-render.js";
import { formatReact, jsxAttributeRecord } from "./vue-format.js";
import { invocationSchema } from "./invocation-attributes.js";
import { isStyleWrite, styleWriteRules } from "./style-writes.js";
import { compileComponentStylesForConversion, componentStateNames } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import { propInputOrder, targetComponent } from "./backend.js";
import { declaresHead, headEntriesSource, headScriptsSource } from "./head-target.js";
import { frameworkRequestSource, REQUEST_CHECK, REQUEST_HELPERS, REQUEST_TYPES, requestListenerType, respondersSource, responderType } from "./requests-target.js";
import { condenseWhitespace, dependentPropTypeSource, isNativeBooleanAttribute, isVoidElement, NUMERIC_ATTRIBUTES, objectKey, propKey, quote, selectorGenerics, SLOT_PROP_IMPORT, slotPropsType, slotPropValueSource, slotPropDefaultSource, typeSource, SSR_BOOLEAN_PROPERTIES, SSR_STRING_PROPERTIES } from "./shared.js";
import { category, inputScope, Lowering, mayProduceInvalidResult, present, provenSlotProp, type Scope, slotPropStatic, type Static, typeOf, typeScript, UNKNOWN } from "./vue-lowering.js";
import { declaredReferenceGuard, destinationTypeCheck, handlerDestinationCheck, provenWrite, refusing, selfStep, writeCheck } from "./type-guards.js";
import { declarationTypeNode, formatType, normalizeType, parseTypeExpression, parseTypedValue, type TypeNode } from "../type-system.js";
import { invocationValue } from "../prop-values.js";
import type { PropContract } from "../types.js";
import postcss from "postcss";
import { parseFragment } from "parse5";

/**
 * Identifiers the generated component already uses: JavaScript names, the helpers it imports, its
 * own locals, and the parameters of the callbacks it writes. Authored names avoid them. The
 * rendering and events modules' names come from their sources, so a new helper is never missed.
 */
const REACT_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements",
  "interface", "package", "private", "protected", "public", "await", "arguments", "eval", "async", "of", "type",
  "React", "ReactNode", "Symbol", "Object", "String", "Number", "Boolean", "Array", "Math", "JSON", "Error", "Event",
  "CustomEvent", "Promise", "Proxy", "Reflect", "Map", "Set", "WeakMap", "undefined", "NaN", "Infinity", "window",
  "document", "console", "globalThis",
  "styleObject", "styleBinding", "styleText", "applyNamespacedAttributes", "namespacedAttributeProps", "htmlNextPrepared", "props", "renderedIdentity", "rootMetadata", "htmlAttributeInputs", "invocationProps", "forwardedAttributes", "nativeAttrs", "nativeAttributes", "_nativeConstructor", "children", "slots", "hasMounted", "acceptedProps", "inputAccepted", "checkedProps",
  "propInputValues", "reflectedAttrs", "hostState", "rootRef", "ownedRootRef", "propValidityContract", "propValidityElement",
  "applyClassBindingRef", "classText", "propInputs", "usePropInputs", "checkPropInput", "BINDING_INPUTS_PROP", "requireInputStatus", "READY_INPUT", "UNRESOLVED_INPUT",
  "inputComputed", "inputRead", "inputDefault", "evaluateInput",
  "propValidityCleanup", "refElements", "refTarget", "latestHandlers", "nestedDepth", "rootFocusPending",
  "controllerStateTypes", "rerender", "element", "paths", "event", "value", "next", "previous", "update", "scoped", "node",
  "ref", "cleanup", "restoreParent", "binding", "attrs", "detail", "name", "keys", "path",
  "checkedProp", "mountPropValidity", "updatePropValidity", "PropBoundary", "propValidityState",
  "selectedPropNode", "acceptsControllerWrite",
  "attachBoundControl", "syncBoundControl", "attachGenericBinding", "writeBoundPath", "useDataRead", "SanitizedHtml",
  "useComponentHost", "useLifecycle", "componentContext", "NestedDepthContext", "ScopedAttachment",
  "htmlNextChildSlots", "htmlNextOutletProps", "htmlNextLists", "htmlNextPlain", "htmlNextContent", "_htmlNextAs", "_htmlNextEntry",
  ...REACT_RENDER_EXPORTS, ...REACT_EVENTS_EXPORTS,
]);

/** Names a template local (a loop item or `$with` alias) must not shadow inside the markup it scopes. */
const REACT_LOCAL_RESERVED = new Set([...REACT_RENDER_EXPORTS, "dispatchDeclaredTargets", "htmlNextAuthoredCheck",
  "htmlNextAuthoredCheckReported", "applyClassBindingRef", "classText", "Symbol", "Object", "String", "Number", "Array", "Math"]);

/** A generated name the component builds from an index, such as `attachEvents2`, or a private `__` name. */
const GENERATED_NAME = /^(?:__|_|attachEvents\d|controlRef|controlValue|previousProperty|propertyRef|genericCleanup|HtmlNextContext_)/;

function componentPropAttribute(name: string, value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && name !== "__proto__"
    ? `${name}={${value}}` : `{...{ ${objectKey(name)}: ${value} }}`;
}

/** The component tags a template invokes, whose imported names the component's scope holds. */
function componentTagsIn(node: TemplateNode, tags = new Set<string>()): Set<string> {
  if (node.kind === "text") return tags;
  if (node.kind === "slot") {
    for (const child of node.fallback ?? []) componentTagsIn(child, tags);
    return tags;
  }
  if (node.name.includes("-") && getDomInterface(node.name) === undefined) tags.add(node.name);
  for (const child of node.children) componentTagsIn(child, tags);
  return tags;
}

/** An authored name as a JavaScript identifier: `step-up` becomes `stepUp`. */
function identifierFor(name: string): string {
  const camel = name.replace(/[^A-Za-z0-9_$]+(.)?/g, (_match, next: string | undefined) => next?.toUpperCase() ?? "");
  return /^[0-9]/.test(camel) || camel === "" ? `_${camel}` : camel;
}

function pascal(name: string): string {
  const identifier = identifierFor(name);
  return identifier[0]!.toUpperCase() + identifier.slice(1);
}

/** Where the shared rendering module's import goes; filled once the component's code is known. */
const RENDER_IMPORT = "\u0000render-import";
const STYLE_IMPORT = "\u0000style-import";
/** Rendering helpers a component names directly, as opposed to the expression helpers its lowering records. */
const REACT_RENDER_COMPONENTS = ["useLiveState", "useReflectedProp", "HtmlNextInput", "HtmlNextTextarea", "HtmlNextValueInput", "HtmlNextValueTextarea", "HtmlNextValueSelect", "HtmlNextSelect", "isString", "isNumber", "isInteger", "isBoolean", "warnUnless", "RetainedText", "RetainedValue", "OutputValue", "cycleCheckedComputed", "KeyedBoundary",
  "rootMetadata", "hostStateTokens", "renderPlainSlot", "renderScopedSlot", "markProjected", "writeStatePath", "rememberParent", "useOwnedRootRef", "useRootHandle",
  "identityKey", "useChildLists", "useChildEntry", "ChildSlot", "ChildEntries", "usePlainSlots", "PlainSlot", "PlainSlots", "PlainChildren"] as const;

export interface ReactConversionOptions {
  readonly modulePreparation?: { readonly source: string };
  readonly bindingsSpecifier?: string;
  /** Preact shares JSX lowering while retaining its own DOM attribute and ref behavior. */
  readonly target?: "react" | "preact";
  /**
   * The linked graph's definitions, by tag. A `:state()` condition on another component resolves
   * against them, and the component's root carries the states their styles test on it.
   */
  readonly componentGraph?: ReadonlyMap<string, ComponentDefinition>;
  /** The states a `<context>` reader can read, from `publishedStates`; without it, every state is published. */
  readonly publishedStates?: ReadonlySet<string> | undefined;
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  readonly propsByTag?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly propContractsByTag?: ReadonlyMap<string, Readonly<Record<string, PropContract>>>;
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
  readonly propsSpecifier?: string;
  readonly attributesSpecifier?: string;
  readonly styleSpecifier?: string;
  readonly eventsSpecifier?: string;
  readonly controlSpecifier?: string;
  readonly dataSpecifier?: string;
  readonly htmlSpecifier?: string;
  readonly hostSpecifier?: string;
  readonly contextSpecifier?: string;
  readonly depthSpecifier?: string;
  readonly renderSpecifier?: string;
  /** The request steps, which a component that declares requests imports. */
  readonly requestsSpecifier?: string;
  readonly headSpecifier?: string;
  readonly guardNestedDepth?: boolean;
  readonly controllerSpecifier?: string;
}

export interface ReactConversionOutput {
  readonly component: string;
  readonly css: string;
  readonly helpers: readonly ("attributes" | "bindings" | "props" | "events" | "control" | "data" | "html" | "host" | "context" | "depth" | "render" | "requests" | "head" | "style")[];
}

interface RootAttributes {
  readonly tag: string;
  readonly reflections: readonly string[];
  readonly captureRoot: boolean;
  readonly hostState: boolean;
}

interface EventAttachment {
  readonly name: string;
  /** Only native listeners: the element's ref is `useNativeEvents`'s callback. */
  readonly listensOnly: boolean;
  /** The root's ref alone, with its native location retained for disposal. */
  readonly forwardsOnly: boolean;
  readonly remembersParent: boolean;
  readonly scoped: boolean;
  readonly bindings: readonly EventBinding[];
  readonly forward: boolean;
  readonly ref?: string;
  readonly orderedClasses?: boolean;
  readonly properties: readonly { readonly name: string; readonly value: string; readonly accepts?: string; readonly namespace?: string; readonly url?: boolean; readonly target?: "class" | "attribute" }[];
  readonly importantStyles: readonly { readonly name: string; readonly value: string }[];
  readonly genericWrites: readonly { readonly state: string; readonly path: string; readonly dynamic: boolean }[];
  readonly control?: {
    readonly name: "value" | "checked";
    readonly value: string;
    readonly defaults: string;
    readonly nativeProperty: boolean;
    readonly accepts?: string;
    readonly write?: { readonly state: string; readonly path: string; readonly dynamic: boolean };
  };
}

interface RenderState {
  readonly preact: boolean;
  readonly definition: ComponentDefinition;
  readonly observe: (scope: Scope) => Scope;
  readonly status: (name: string, read: string) => string | undefined;
  readonly slotsByTag: ReadonlyMap<string, readonly SlotContract[]> | undefined;
  readonly propsByTag: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  readonly propContractsByTag: ReadonlyMap<string, Readonly<Record<string, PropContract>>> | undefined;
  readonly componentGraph: ReadonlyMap<string, ComponentDefinition> | undefined;
  /** Columns as markup: the component declares an `as` list, whose entries key by identity. */
  readonly lists: boolean;
  readonly sharedPlain: boolean;
  /** Each accepted child the consumer gives an entry, by its attributes: its entry's key segments (`entryKeySource`). */
  readonly entrySites: Map<readonly unknown[], readonly KeySegment[]>;
  /** The key of the row each `$each` is rendering, by that `$each`'s attributes, as source. */
  readonly rowKeys: Map<readonly unknown[], string>;
  usesChildSlots?: boolean;
  /** The nodes being rendered come after an accepting slot's outlet. */
  afterOutlet?: boolean;
  /** Each `<slot of>` outlet's props checks, by accepted tag: `htmlNextOutletProps0`, … */
  readonly outletProps: string[];
  readonly classOwners: string[];
  nextSlotAlias: number;
  nextRetainedAlias: number;
  usesHtml: boolean;
  usesPlainSlots: boolean;
  usesScopedSlots: boolean;
  usesSlotPropChecks?: boolean;
  usesHtmlInputs?: boolean;
  usesStyle?: boolean;
  usesKeyedLists: boolean;
  usesRetainedText: boolean;
  usesRetainedValue: boolean;
  usesOutputValue: boolean;
  usesInputStatus?: boolean;
  usesInputExpressions?: boolean;
  /** A free name in the component's scope, for an element's event hook. */
  readonly allocate: (base: string) => string;
  /** Inside a preformatted element such as <pre> or <textarea>, whose text is kept exactly, as Vue keeps it. */
  preformatted: boolean;
}

interface RenderScope extends Scope {
  readonly local?: boolean;
}


function contextExportName(tag: string, name: string): string {
  const suffix = name.replace(/[^A-Za-z0-9$]/g, (character) => `_u${character.charCodeAt(0).toString(16)}_`);
  return `HtmlNextContext_${componentName(tag)}_${suffix}`;
}

const REACT_ATTRIBUTES: Readonly<Record<string, string>> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly",
  autofocus: "autoFocus", autocomplete: "autoComplete", maxlength: "maxLength",
  minlength: "minLength", crossorigin: "crossOrigin", srcset: "srcSet",
  contenteditable: "contentEditable", inputmode: "inputMode", spellcheck: "spellCheck", colspan: "colSpan", rowspan: "rowSpan",
};

/** A value as HTML Next text: absent and null are empty, as in the live runtime. */
function nullableText(value: string, lowering: Lowering): string {
  return `${lowering.use("text")}(${value})`;
}

const adjustedSvgAttributes = new Map<string, string>();

function reactAttribute(name: string, svg = false): string {
  if (svg) {
    let adjusted = adjustedSvgAttributes.get(name);
    if (adjusted === undefined) {
      const fragment = parseFragment(`<svg ${name}></svg>`);
      const element = fragment.childNodes[0] as { attrs?: readonly { name: string }[] } | undefined;
      adjusted = element?.attrs?.[0]?.name ?? name;
      adjustedSvgAttributes.set(name, adjusted);
    }
    name = adjusted;
  }
  return Object.hasOwn(REACT_ATTRIBUTES, name) ? REACT_ATTRIBUTES[name]! : svg && !/^(?:aria|data)-/.test(name)
    ? name.replace(/[-:]([a-z])/g, (_, letter: string) => letter.toUpperCase()) : name;
}

function reactStyleProperty(name: string): string {
  if (name.startsWith("--")) return name;
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()).replace(/^Ms/, "ms");
}

function literalStyle(value: string, importantStyles: Array<{ readonly name: string; readonly value: string }>): string[] {
  const rule = postcss.parse(`x { ${value} }`).first;
  if (rule?.type !== "rule") return [];
  return rule.nodes.flatMap((node) => {
    if (node.type === "comment") return [];
    if (node.type !== "decl") fail("HT030", "React conversion of this inline style is not implemented.");
    if (node.important) importantStyles.push({ name: node.prop, value: node.value });
    return [`${quote(reactStyleProperty(node.prop))}: ${quote(node.value + (node.important ? " !important" : ""))}`];
  });
}

/**
 * Authored text as JSX text, written as authored with JSX's own whitespace handling: each run of
 * ASCII whitespace is one space. Text JSX would read as markup, that starts or ends with a space a
 * formatter could move to a line edge, or that holds other whitespace (a non-breaking space) a
 * compiler could trim there, stays a string expression, as does preformatted text.
 */
function jsxText(value: string, preformatted: boolean): string {
  const collapsed = preformatted ? value : value.replace(/[\t\n\f\r ]+/g, " ");
  return preformatted || /[{}<>&]|^ | $|[^\S ]/.test(collapsed) ? `{${quote(collapsed)}}` : collapsed;
}

/**
 * One text node's authored and computed parts as a template literal, without the indentation at
 * its ends: the live runtime renders them as one Text node, which a browser shapes as one run.
 */
function jsxTextParts(segments: readonly { readonly value: string; readonly computed?: string }[], preformatted: boolean): string {
  const parts = segments.map((segment) => segment.computed !== undefined ? segment
    : { text: preformatted ? segment.value : segment.value.replace(/[\t\n\f\r ]+/g, " ") });
  const first = parts[0];
  if (!preformatted && first !== undefined && "text" in first && /^[\t\f\r ]*\n/.test(segments[0]!.value)) first.text = first.text.replace(/^ /, "");
  const last = parts.at(-1);
  if (!preformatted && last !== undefined && "text" in last && /\n[\t\f\r ]*$/.test(segments.at(-1)!.value)) last.text = last.text.replace(/ $/, "");
  return `{\`${parts.map((part) => "text" in part ? part.text.replace(/[\\`]|\$(?=\{)/g, (character) => `\\${character}`) : `\${${part.computed}}`).join("")}\`}`;
}

function selectedOptionDefaults(node: ElementNode): boolean[] {
  const defaults: boolean[] = [];
  const visit = (children: readonly TemplateNode[]): void => {
    for (const child of children) {
      if (child.kind !== "element") continue;
      if (child.name === "option") defaults.push(child.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "selected"));
      else visit(child.children);
    }
  };
  visit(node.children);
  return defaults;
}

function authoredControlDefaults(node: ElementNode, name: "value" | "checked"): string {
  const authored = node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "value");
  const authoredValue = node.name === "textarea" && node.children.every((child) => child.kind === "text" && child.expressionPlan === undefined && child.segments === undefined)
    ? node.children.map((child) => child.kind === "text" ? child.value : "").join("")
    : authored?.kind === "literal" ? authored.value : "";
  return JSON.stringify(node.name === "select" ? { options: selectedOptionDefaults(node) }
    : name === "checked" ? { checked: node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "checked") }
      : { value: authoredValue });
}

function withoutAuthoredSelection(node: TemplateNode): TemplateNode {
  if (node.kind !== "element") return node;
  return {
    ...node,
    attributes: node.name === "option"
      ? node.attributes.filter((attribute) => !(attribute.kind === "literal" && attribute.name === "selected"))
      : node.attributes,
    children: node.children.map(withoutAuthoredSelection),
  };
}

function localScope(scope: RenderScope, names: readonly (readonly [string, Static, (string | undefined)?, (TypeNode | undefined)?])[]): RenderScope {
  const code = new Map(scope.code);
  const types = new Map(scope.types);
  for (const [name, type, alias] of names) {
    code.set(name, alias ?? name);
    types.set(name, type);
  }
  return withReferenceTypes({ ...scope, code, types, local: true }, names.map(([name, , , type]) => [name, type]));
}

function localIdentifier(name: string, scope: RenderScope, state: RenderState): string {
  if (isScriptIdentifier(name) && !REACT_LOCAL_RESERVED.has(name) && !GENERATED_NAME.test(name)) return name;
  let alias: string;
  do alias = `__htmlNextLocal${state.nextRetainedAlias++}`;
  while ([...scope.code.values()].includes(alias) || scope.code.has(alias));
  return alias;
}

function renderNode(node: TemplateNode, scope: RenderScope, lowering: Lowering, imports: Set<string>, handlers: ReadonlySet<string>, attachments: EventAttachment[], state: RenderState, rootTag?: RootAttributes, projected = false, inSvg = false): string {
  // Content after an accepting slot's outlet renders in a component of its own, so it reads the `as`
  // lists after the outlet's wrapped children have joined them, on the server and in the first render.
  if (state.afterOutlet === true && (node.kind !== "text" || node.segments !== undefined || node.expressionPlan !== undefined)) {
    state.afterOutlet = false;
    const content = renderNode(node, scope, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg);
    state.afterOutlet = true;
    return `<KeyedBoundary renderRows={() => <>${content}</>} />`;
  }
  if (node.kind === "text") {
    if (node.segments !== undefined) {
      const parts: { value: string; computed?: string }[] = [];
      const retained: { alias: string; value: string; guard?: string }[] = [];
      for (const segment of node.segments) {
        const plan = segment.expressionPlan;
        if (plan === undefined) { parts.push({ value: segment.value }); continue; }
        const guard = declaredReferenceGuard(plan, scope, state.definition, undefined, lowering);
        if (mayProduceInvalidResult(plan.ast, scope) || guard !== undefined) {
          state.usesRetainedValue = true;
          const alias = `__retained${state.nextRetainedAlias++}`;
          retained.push({ alias, value: lowering.value(plan.ast, scope), ...(guard === undefined ? {} : { guard }) });
          const local = localScope(scope, [[alias, typeOf(plan.ast, scope)]]);
          parts.push({ value: segment.value, computed: nullableText(lowering.text({ kind: "id", name: alias }, local), lowering) });
        } else parts.push({ value: segment.value, computed: nullableText(lowering.text(plan.ast, scope), lowering) });
      }
      let content = jsxTextParts(parts, state.preformatted);
      for (const part of retained.toReversed()) content = `<RetainedValue value={${part.value}} accepts={() => ${part.guard ?? "true"}} render={(${part.alias}) => <>${content}</>} />`;
      return content;
    }
    const plan = node.expressionPlan;
    if (plan === undefined) return jsxText(node.value, state.preformatted);
    const guard = declaredReferenceGuard(plan, scope, state.definition, undefined, lowering);
    const text = nullableText(lowering.text(plan.ast, scope), lowering);
    if (mayProduceInvalidResult(plan.ast, scope) || guard !== undefined) {
      state.usesRetainedText = true;
      return `<RetainedText value={${lowering.value(plan.ast, scope)}} text={${lowering.use("text")}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} />`;
    }
    return `{${text}}`;
  }
  if (node.flow !== undefined) {
    const { flow, ...body } = node;
    if (flow.kind === "if") {
      if (flow.testPlan === undefined) fail("HT030", `Uncompiled condition ${flow.test}.`);
      const condition = lowering.condition(flow.testPlan.ast, scope);
      const content = renderNode(body, scope, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg);
      if (!mayProduceInvalidResult(flow.testPlan.ast, scope)) return `{${condition} ? (${content}) : null}`;
      state.usesRetainedValue = true;
      const alias = `__retained${state.nextRetainedAlias++}`;
      const acceptedScope = localScope(scope, [[alias, typeOf(flow.testPlan.ast, scope)]]);
      return `<RetainedValue value={${lowering.value(flow.testPlan.ast, scope)}} accepts={() => true} render={(${alias}, hasValue) => hasValue && ${lowering.condition({ kind: "id", name: alias }, acceptedScope)} ? (${content}) : null} />`;
    }
    if (flow.kind === "with") {
      if (flow.expressionPlan === undefined) fail("HT030", `Uncompiled expression ${flow.expr}.`);
      if (flow.binding !== undefined) state.usesInputStatus = true;
      const read = lowering.value(flow.expressionPlan.ast, scope);
      const computed = (state.definition.declarations ?? []).find(declaration => declaration.kind === "computed" && declaration.name === flow.binding?.name);
      const computedStatus = computed === undefined ? undefined : scope.code.get(computed.name)?.replace(/\.get\(\)$/, ".status()");
      const value = flow.binding === undefined ? read : `requireInputStatus(${Object.hasOwn(state.definition.contract.props, flow.binding.name)
        ? `propInputs.status(${quote(flow.binding.name)})` : computedStatus ?? state.status(flow.binding.name, read) ?? `((${read}) === undefined ? UNRESOLVED_INPUT : READY_INPUT)`}, ${flow.binding.handlesError})`;
      const alias = localIdentifier(flow.alias, scope, state);
      const scoped = localScope(scope, [[flow.alias, flow.aliasType === undefined ? typeOf(flow.expressionPlan.ast, scope) : present(flow.aliasType), alias, flow.aliasType ?? referenceType(flow.expressionPlan.ast, scope)]]);
      const content = renderNode(body, scoped, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg);
      if (flow.binding !== undefined || !mayProduceInvalidResult(flow.expressionPlan.ast, scope)) return `{(() => { const ${alias} = ${value}; return (${content}); })()}`;
      state.usesRetainedValue = true;
      return `<RetainedValue value={${value}} accepts={() => true} render={(${alias}, hasValue) => hasValue ? (${content}) : null} />`;
    }
    if (flow.kind === "each") {
      if (flow.listPlan === undefined) fail("HT030", `Uncompiled list ${flow.list}.`);
      const item = localIdentifier(flow.item, scope, state);
      const index = localIdentifier(flow.index ?? "index", scope, state);
      const itemType = typeOf(flow.listPlan.ast, scope).type;
      const itemContract = referenceType(flow.listPlan.ast, scope);
      const filterScope = localScope(scope, [
        [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN, item, itemContract?.kind === "list" ? itemContract.item : undefined],
      ]);
      const scoped = localScope(filterScope, [
        [flow.index ?? ITERATION_INDEX, { type: { kind: "terminal", name: "number" }, nullable: false }, index],
        [ITERATION_INDEX, { type: { kind: "terminal", name: "number" }, nullable: false }, index],
      ]);
      const retainedList = mayProduceInvalidResult(flow.listPlan.ast, scope);
      const listAlias = retainedList ? `__retained${state.nextRetainedAlias++}` : undefined;
      const listScope = listAlias === undefined ? scope : localScope(scope, [[listAlias, typeOf(flow.listPlan.ast, scope)]]);
      const list = lowering.list(listAlias === undefined ? flow.listPlan.ast : { kind: "id", name: listAlias }, listScope, item, {
        ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
        itemScope: filterScope,
        sort: (flow.sortKeys ?? []).map(({ path, descending }) => `${descending ? "-" : ""}${path.join(".")}`),
        ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
      });
      const keyed = flow.keyPlan === undefined ? index : lowering.value(flow.keyPlan.ast, scoped);
      // An `as` list's entry keys by its identity, as live keys by `Object.is`.
      const key = state.lists && flow.keyPlan !== undefined && typeOf(flow.keyPlan.ast, scoped).type.kind === "object" ? `identityKey(${keyed})` : keyed;
      // An accepted child in these rows keys its entry by the row's key.
      if (node.kind === "element") state.rowKeys.set(node.attributes, key);
      const child = renderNode(body, scoped, lowering, imports, handlers, attachments, state, undefined, projected, inSvg);
      const checked = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list, `(${item}, ${index}) => ${key}`);
      const rows = lowering.eachRows(checked);
      const renderRows = `${rows}.map(({ item: ${item}, index: ${index} }) => <React.Fragment key={${key}}>${child}</React.Fragment>)`;
      const content = flow.keyPlan === undefined
        ? listAlias === undefined ? `{${renderRows}}` : `<>{${renderRows}}</>`
        : `<KeyedBoundary renderRows={() => ${renderRows}} />`;
      if (flow.keyPlan !== undefined) state.usesKeyedLists = true;
      if (listAlias === undefined) return content;
      state.usesRetainedValue = true;
      return `<RetainedValue value={${lowering.value(flow.listPlan.ast, scope)}} accepts={() => true} render={(${listAlias}, hasValue) => hasValue ? (${content}) : null} />`;
    }
    if (flow.kind === "match") {
      if (node.kind !== "element") fail("HT030", "React conversion of this $match is not implemented.");
      if (node.name !== "template") return renderNode(elementMatchRoot(node), scope, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg);
      const alias = flow.alias === undefined ? undefined : localIdentifier(flow.alias, scope, state);
      const scoped = flow.alias === undefined ? scope : localScope(scope, [[flow.alias,
        flow.expressionPlan === undefined ? UNKNOWN : typeOf(flow.expressionPlan.ast, scope), alias, flow.expressionPlan === undefined ? undefined : referenceType(flow.expressionPlan.ast, scope)]]);
      const withAlias = (content: string): string => {
        if (flow.alias === undefined) return content;
        if (flow.expressionPlan === undefined) fail("HT030", `Uncompiled expression ${flow.expr}.`);
        const value = lowering.value(flow.expressionPlan.ast, scope);
        if (!mayProduceInvalidResult(flow.expressionPlan.ast, scope)) {
          return `{(() => { const ${alias} = ${value}; return (${content}); })()}`;
        }
        state.usesRetainedValue = true;
        return `<RetainedValue value={${value}} accepts={() => true} render={(${alias}, hasValue) => hasValue ? (${content}) : null} />`;
      };
      const arms = node.children.filter((child): child is ElementNode => child.kind === "element");
      // Live builds a newly chosen arm afresh, so a nested arm is keyed: React must not reuse the
      // previous arm's DOM when both have the same shape. A root switch follows live's own rules.
      const renderArm = (body: ElementNode, index: number): string => {
        const content = renderNode(body, scoped, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg);
        return rootTag === undefined ? `<React.Fragment key={${index}}>${content}</React.Fragment>` : content;
      };
      const retainsChoice = arms.some((arm) => arm.flow?.kind === "when" && arm.flow.testPlan !== undefined &&
        mayProduceInvalidResult(arm.flow.testPlan.ast, scoped));
      if (retainsChoice) {
        state.usesRetainedValue = true;
        let choice = "-1";
        for (let index = arms.length - 1; index >= 0; index -= 1) {
          const arm = arms[index]!;
          if (arm.flow?.kind === "else") choice = String(index);
          else if (arm.flow?.kind === "when" && arm.flow.testPlan !== undefined) {
            const test = lowering.condition(arm.flow.testPlan.ast, scoped);
            choice = `(() => { const test = ${test}; return test === Symbol.for("html-next.invalid-result") ? test : test ? ${index} : ${choice}; })()`;
          } else fail("HT030", "React conversion of an invalid $match arm is not implemented.");
        }
        let selected = "null";
        for (let index = arms.length - 1; index >= 0; index -= 1) {
          const { flow: _choice, ...body } = arms[index]!;
          selected = `selected === ${index} ? (${renderArm(body, index)}) : (${selected})`;
        }
        const markup = `<RetainedValue value={${choice}} render={(selected) => ${selected}} />`;
        return withAlias(markup);
      }
      let expression = "null";
      for (const [index, arm] of [...arms.entries()].toReversed()) {
        const { flow: choice, ...choiceBody } = arm;
        if (choice?.kind === "else") expression = `(${renderArm(choiceBody, index)})`;
        else if (choice?.kind === "when" && choice.testPlan !== undefined) {
          expression = `${lowering.condition(choice.testPlan.ast, scoped)} ? (${renderArm(choiceBody, index)}) : (${expression})`;
        } else fail("HT030", "React conversion of an invalid $match arm is not implemented.");
      }
      if (flow.alias === undefined) return `{${expression}}`;
      return withAlias(`<>{${expression}}</>`);
    }
    fail("HT030", `React conversion of $${flow.kind} is not implemented.`);
  }
  if (node.kind === "slot" && node.of !== undefined) {
    // `<slot of>` places a slot of the accepted child its entry stands for (components#columns-as-markup).
    // A static prop is given as its text; the child's slot declaration converts it (`outletPropsSource`).
    state.usesChildSlots = true;
    const values = (node.props ?? []).map((prop) => `${objectKey(prop.name)}: ${prop.raw !== undefined ? quote(prop.raw) : lowering.value(prop.expressionPlan.ast, scope)}`);
    const fallback = (node.fallback ?? []).map((child) => renderNode(child, scope, lowering, imports, handlers, attachments, state, undefined, false, inSvg)).join("");
    const shapes = outletPropsSource(node, state);
    return `<ChildSlot entry={${lowering.value(node.of.expressionPlan.ast, scope)}} name=${quote(node.name ?? "")}${values.length === 0 ? "" : ` values={{ ${values.join(", ")} }}`} slots={htmlNextChildSlots}${shapes === undefined ? "" : ` shapes={${shapes}}`} file=${quote(state.definition.source.file)} fallback={<>${fallback}</>} />`;
  }
  if (node.kind === "slot") {
    const name = quote(node.name ?? "");
    // A slot with `as` renders its content as its lists read it, each accepted child with its entry.
    const accepting = state.definition.contract.slots?.[node.name ?? ""]?.as !== undefined;
    const supplied = accepting ? `htmlNextLists.content[${name}]`
      : node.name === undefined ? "props.children" : `props.slots?.[${name}]`;
    const fallback = (node.fallback ?? []).map((child) => renderNode(child, scope, lowering, imports, handlers, attachments, state, undefined, false, inSvg)).join("");
    if (accepting) state.afterOutlet = true;
    if ((node.props?.length ?? 0) > 0) {
      state.usesScopedSlots = true;
      // A null value, and one its declared type rejects, takes the prop's default, or null; a value whose
      // static type is the declared one needs no check.
      let checked = false;
      const retained: { alias: string; value: string }[] = [];
      const values = node.props!.map((prop) => {
        const value = lowering.value(prop.expressionPlan.ast, scope);
        const proven = prop.type !== undefined && provenSlotProp(prop.type, typeOf(prop.expressionPlan.ast, scope));
        const source = proven ? undefined : slotPropValueSource(state.definition, node.name, prop, true);
        if (source !== undefined) checked = true;
        if (source !== undefined && prop.type !== undefined) state.usesSlotPropChecks = true;
        const given = source === undefined ? value : `(${source})(${value})`;
        if (!mayProduceInvalidResult(prop.expressionPlan.ast, scope)) return `${objectKey(prop.name)}: ${given}`;
        state.usesRetainedValue = true;
        const alias = `__retained${state.nextRetainedAlias++}`;
        retained.push({ alias, value: given });
        return `${objectKey(prop.name)}: ${alias}Ready ? ${alias} : ${slotPropDefaultSource(prop)}`;
      }).join(", ");
      let content = `renderScopedSlot(${supplied}, { ${values} }${checked ? " as any" : ""}, ${name}, <>${fallback}</>)`;
      for (const part of retained.toReversed()) content = `<RetainedValue value={${part.value}} render={(${part.alias}, ${part.alias}Ready) => ${content}} />`;
      return retained.length === 0 ? `{${content}}` : content;
    }
    state.usesPlainSlots = true;
    return state.sharedPlain ? `{htmlNextPlain.frames.has(${name}) ? <PlainSlot frame={htmlNextPlain.frames.get(${name})} content={${supplied} as ReactNode} fallback={<>${fallback}</>} /> : renderPlainSlot(${supplied}, <>${fallback}</>)}` : `{renderPlainSlot(${supplied}, <>${fallback}</>)}`;
  }
  if (node.name === "template") {
    const html = node.attributes.find((attribute) => attribute.kind === "directive" && attribute.name === "html");
    if (html?.kind === "directive" && html.expressionPlan !== undefined) {
      state.usesHtml = true;
      const guard = declaredReferenceGuard(html.expressionPlan, scope, state.definition, undefined, lowering);
      // An invalid result, or a declared reference that does not conform, keeps the last content.
      if (guard !== undefined || mayProduceInvalidResult(html.expressionPlan.ast, scope)) {
        state.usesRetainedValue = true;
        const alias = `__retained${state.nextRetainedAlias++}`;
        return `<RetainedValue value={${lowering.text(html.expressionPlan.ast, scope)}} accepts={() => ${guard ?? "true"}} render={(${alias}) => <SanitizedHtml value={${nullableText(alias, lowering)}}${projected ? " projected" : ""} />} />`;
      }
      return `<SanitizedHtml value={${nullableText(lowering.text(html.expressionPlan.ast, scope), lowering)}}${projected ? " projected" : ""} />`;
    }
    const value = node.attributes.find((attribute) => attribute.kind === "directive" && attribute.name === "value");
    if (value?.kind === "directive" && value.expressionPlan !== undefined) {
      const guard = declaredReferenceGuard(value.expressionPlan, scope, state.definition, undefined, lowering);
      if (mayProduceInvalidResult(value.expressionPlan.ast, scope) || guard !== undefined) {
        state.usesRetainedText = true;
        return `<><RetainedText value={${lowering.value(value.expressionPlan.ast, scope)}} text={${lowering.use("text")}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} /></>`;
      }
      return `<>{${nullableText(lowering.text(value.expressionPlan.ast, scope), lowering)}}</>`;
    }
    if (node.attributes.length === 1 && node.attributes[0]?.kind === "literal" && node.attributes[0].name === "slot") {
      return `<template slot=${quote(node.attributes[0].value)}${projected ? ' data-slotted=""' : ""}>${node.children.map((child) => renderNode(child, scope, lowering, imports, handlers, attachments, state, undefined, false, inSvg)).join("")}</template>`;
    }
    if (node.attributes.length > 0) fail("HT030", "React conversion of this <template> attribute is not implemented.");
    return `<>${node.children.map((child) => renderNode(child, scope, lowering, imports, handlers, attachments, state, undefined, projected, inSvg)).join("")}</>`;
  }
  const component = node.name.includes("-") && getDomInterface(node.name) === undefined;
  const outputValue = node.name === "output" && node.attributes.some((attribute) =>
    attribute.kind === "directive" && attribute.name === "value");
  const controlledNames = new Set(node.attributes.filter((attribute) =>
    attribute.kind === "attribute" && attribute.twoWay === true ||
    attribute.kind === "property" && ["input", "textarea", "select"].includes(node.name) && ["value", "checked"].includes(attribute.name)
  ).map((attribute) => attribute.name));
  const nativeValueAttribute = !component && !inSvg && ["input", "textarea", "select"].includes(node.name) && !controlledNames.has("value") && node.attributes.some(attribute =>
    attribute.name === "value" && (attribute.kind === "literal" || attribute.kind === "attribute" && attribute.twoWay !== true && attribute.target === undefined));
  // React DOM rewrites an input's name and type, and a textarea's default, whenever it commits one.
  const memoControl = !component && !outputValue && !inSvg && (node.name === "input" || node.name === "textarea" || state.preact && node.name === "select" && controlledNames.has("value"));
  const tag = outputValue ? "OutputValue" : component ? componentName(node.name) : nativeValueAttribute && !state.preact
    ? node.name === "input" ? "HtmlNextValueInput" : node.name === "select" ? "HtmlNextValueSelect" : "HtmlNextValueTextarea" : memoControl
    ? node.name === "input" ? "HtmlNextInput" : node.name === "select" ? "HtmlNextSelect" : "HtmlNextTextarea" : node.name;
  const svg = !component && (inSvg || node.name === "svg");
  if (component) imports.add(node.name);
  const componentContracts = component ? state.propContractsByTag?.get(node.name) : undefined;
  const findComponentPropName = (attributeName: string): string | undefined => componentContracts === undefined ? undefined
    : Object.keys(componentContracts).find((name) => asciiLowerCase(name) === attributeName || kebabCase(name) === attributeName);
  const boundPropAliases = new Map<string, string>();
  const boundPropSnapshots = new Set<string>();
  if (componentContracts !== undefined) for (const attribute of node.attributes) {
    if (attribute.kind !== "attribute" || attribute.target !== undefined || attribute.twoWay) continue;
    const name = findComponentPropName(attribute.name);
    if (name !== undefined) {
      boundPropAliases.set(name, `__retained${state.nextRetainedAlias++}`);
      const observed = state.observe(scope);
      if (attribute.expressionPlan!.ast.kind !== "id" && attribute.expressionPlan!.dependencies.some(path => {
        const root = path.split(".")[0]!;
        return observed.code.get(root) !== scope.code.get(root);
      })) boundPropSnapshots.add(name);
    }
  }
  const literals: string[] = [];
  const bindings: string[] = [];
  const inputBindings: string[] = [];
  const retainedBindings: Array<{ readonly alias: string; readonly value: string; readonly accepts?: string; readonly propName?: string; readonly initial?: string; readonly ready?: string }> = [];
  const classes: string[] = [];
  const classRules: string[] = [];
  const literalStyles: string[] = [];
  const reactiveStyles: string[] = [];
  const importantStyles: Array<{ readonly name: string; readonly value: string }> = [];
  const properties: Array<EventAttachment["properties"][number]> = [];
  // HTML attribute names are case-insensitive; uppercase bypasses Preact's case-sensitive
  // DOM-property lookup for attributes whose property has different behavior (output.value, constructor).
  const nativeAttribute = (name: string): boolean => state.preact && !component && !svg &&
    (name === "constructor" || name === "value" || name === "draggable");
  const serializedAttribute = (name: string): boolean => isEnumeratedBoolean(name) ||
    !component && (name === "type" || isNativeBooleanAttribute(name));
  const attributeValue = (node: ExpressionNode, valueScope: Scope, name: string): string =>
    lowering.attribute(node, valueScope, name, { enumeratedBooleanTokens: state.preact });
  // Serialized HTML attributes may have values outside JSX's ARIA enums. Keep their
  // DOM string representation without narrowing the public component prop types.
  const attributeBinding = (name: string, value: string): string => nativeAttribute(name)
    ? `{...{ ${quote(name.toUpperCase())}: ${value} }}`
    : serializedAttribute(name)
      ? `{...({ ${quote(reactAttribute(name, svg))}: ${value} } as Record<string, unknown>)}`
      : `${reactAttribute(name, svg)}={${value}}`;
  const genericWrites: Array<{ readonly state: string; readonly path: string; readonly dynamic: boolean }> = [];
  let scopedAttachment: { readonly attachment: EventAttachment; readonly ref: string; readonly paths: readonly string[] } | undefined;
  let control: EventAttachment["control"];
  let content: string | undefined;
  const forwards = node.attributes.some(attribute => attribute.kind === "forward");
  const componentStyle = component && node.attributes.some(attribute => attribute.kind === "attribute" && attribute.target === "style");
  const htmlInputs = component && (forwards || componentStyle) && Object.keys(componentContracts ?? {}).length > 0 ? invocationSchema(componentContracts!, reactAttribute) : undefined;
  if (htmlInputs !== undefined) state.usesHtmlInputs = true;
  const orderedClasses = forwards && node.attributes.some(attribute => attribute.kind === "attribute" && (attribute.target === "class" || attribute.target === undefined && attribute.name === "class"));
  const boundStyle = !component && node.attributes.some(attribute => attribute.kind === "attribute" && attribute.name === "style" && attribute.target === undefined && !attribute.twoWay);
  const orderedStyles = !component && forwards;
  if (componentStyle || boundStyle || forwards && !component) state.usesStyle = true;
  let orderedStyleValue = "undefined";
  const addStyle = (property: string): void => {
    if (orderedStyles) orderedStyleValue = `{ ...(${orderedStyleValue}), ${property} }`;
    else reactiveStyles.push(property);
  };
  const ordered: string[] = [];
  let capturedBindings = 0;
  for (const attribute of node.attributes) {
    const literalStart = literals.length, bindingStart = bindings.length;
    try {
    if (attribute.kind === "forward") {
      importantStyles.length = 0;
      if (orderedStyles) orderedStyleValue = `(Object.hasOwn(forwardedAttributes(nativeAttrs), "style") ? styleObject(nativeAttrs.style) : ${orderedStyleValue})`;
      if (orderedClasses) {
        const read = "Object.hasOwn(forwardedAttributes(nativeAttrs), 'className') ? nativeAttrs.className : Symbol.for('html-next.no-attribute')";
        properties.push({ name: "class", value: read, target: "attribute" });
        classRules.push(`{ kind: "attribute", name: "class", read: () => ${read} }`);
      }
      const forwarded = `forwardedAttributes(${state.preact && !svg ? "nativeAttributes" : "nativeAttrs"}${component ? "" : ", [\"style\"]"})`;
      literals.push(`{...${htmlInputs === undefined ? forwarded : `htmlAttributeInputs(${forwarded}, ${htmlInputs})`}}`);
      continue;
    }
    if (componentStyle && isStyleWrite(attribute)) continue;
    if (!component && attribute.kind === "attribute" && !attribute.twoWay && (attribute.target === "class" || attribute.target === undefined && attribute.name === "class")) {
      const plan = attribute.expressionPlan!;
      const guard = declaredReferenceGuard(plan, scope, state.definition, undefined, lowering);
      const value = attribute.target === "class" ? lowering.condition(plan.ast, scope) : attributeValue(plan.ast, scope, "class");
      const target = attribute.target === "class" ? "class" : "attribute";
      properties.push({ name: attribute.name, value, ...(guard === undefined ? {} : { accepts: guard }), target });
      classRules.push(`{ kind: ${quote(target)}, name: ${quote(attribute.name)}, read: () => ${guard === undefined ? value : `(${guard}) ? ${value} : Symbol.for("html-next.invalid-result")`} }`);
      continue;
    }
    const namespace = !component && (attribute.kind === "literal" || attribute.kind === "attribute" && attribute.target === undefined && !attribute.twoWay) ? attributeNamespace(attribute.name) : undefined;
    if (namespace !== undefined && (attribute.kind === "literal" || attribute.kind === "attribute")) {
      const value = attribute.kind === "literal" ? quote(attribute.value) : attributeValue(attribute.expressionPlan!.ast, scope, attribute.name);
      properties.push({ name: attribute.name, value, namespace, url: attribute.name === "xlink:href" });
      const serverName = attribute.name.replace(/:([a-z])/g, (_, letter: string) => letter.toUpperCase());
      literals.push(`{...(typeof document === "undefined" ? namespacedAttributeProps([${namespacedAttributeSource(attribute.name, value, serverName)}]) : {})}`);
      continue;
    }
    if (attribute.kind === "literal") {
      if (forwards && node.attributes.some(binding => binding.kind === "attribute" && binding.target === undefined && binding.name === attribute.name)) continue;
      const componentProp = component ? Object.entries(componentContracts ?? {})
        .find(([name]) => asciiLowerCase(name) === attribute.name || kebabCase(name) === attribute.name) : undefined;
      if (projected && attribute.name === "data-slotted") continue;
      if (componentProp !== undefined && attribute.name === "style") {
        const [name, contract] = componentProp;
        const parsed = parseTypedValue(attribute.value, contract.type, "$", "html");
        const accepted = parsed.ok && (contract.values === undefined || contract.values.includes(parsed.value as string | number | boolean));
        literals.push(componentPropAttribute(name, accepted ? JSON.stringify(parsed.value) : `${quote(attribute.value)} as any`));
      }
      else if (component && attribute.name === "style") literals.push(`style={${quote(attribute.value)} as any}`);
      else if (attribute.name === "class" && orderedClasses) {
        properties.push({ name: "class", value: quote(attribute.value), target: "attribute" });
        classRules.push(`{ kind: "attribute", name: "class", read: () => ${quote(attribute.value)} }`);
      }
      else if (attribute.name === "class" && forwards) literals.push(`className=${quote(attribute.value)}`);
      else if (attribute.name === "style" && orderedStyles) orderedStyleValue = `{ ${literalStyle(attribute.value, importantStyles).join(", ")} }`;
      else if (attribute.name === "style" && forwards) literals.push(`style={{ ${literalStyle(attribute.value, importantStyles).join(", ")} }}`);
      else if (attribute.name === "class") classes.push(quote(attribute.value));
      else if (attribute.name === "style") literalStyles.push(...literalStyle(attribute.value, importantStyles));
      else if (controlledNames.has(attribute.name)) continue;
      else if (nativeValueAttribute && attribute.name === "value") literals.push(state.preact ? attributeBinding(attribute.name, quote(attribute.value)) : `htmlNextValue=${quote(attribute.value)}`);
      else if (componentProp !== undefined) {
        const [name, contract] = componentProp;
        const parsed = parseTypedValue(attribute.value, contract.type, "$", "html");
        const accepted = parsed.ok && (contract.values === undefined || contract.values.includes(parsed.value as string | number | boolean));
        literals.push(componentPropAttribute(name, accepted ? JSON.stringify(parsed.value) : `${quote(attribute.value)} as any`));
      }
      else if (attribute.name === "__proto__") literals.push(componentPropAttribute("__Proto__", quote(attribute.value)));
      else if (nativeAttribute(attribute.name) || state.preact && isEnumeratedBoolean(attribute.name)) literals.push(attributeBinding(attribute.name, quote(attribute.value)));
      else if (isNativeBooleanAttribute(attribute.name)) literals.push(`${node.name === "input" && attribute.name === "checked" ? "defaultChecked" : reactAttribute(attribute.name, svg)}={true}`);
      else if (NUMERIC_ATTRIBUTES.has(attribute.name) && /^[+-]?\d+$/.test(attribute.value)) literals.push(`${reactAttribute(attribute.name, svg)}={${Number(attribute.value)}}`);
      else if (!component && ["input", "textarea", "select"].includes(node.name) && attribute.name === "value") literals.push(`defaultValue=${quote(attribute.value)}`);
      else literals.push(NUMERIC_ATTRIBUTES.has(attribute.name) && !component
        ? `${reactAttribute(attribute.name, svg)}={${quote(attribute.value)} as any}`
        : `${reactAttribute(attribute.name, svg)}=${quote(attribute.value)}`);
    } else if (attribute.kind === "attribute" && attribute.target === "class") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled binding ${attribute.expression}.`);
      const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (guard === undefined && !mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) classRules.push(`{ kind: "class", name: ${quote(attribute.name)}, read: () => ${lowering.condition(attribute.expressionPlan.ast, scope)} }`);
      else {
        const alias = `__retained${state.nextRetainedAlias++}`;
        state.usesRetainedValue = true;
        retainedBindings.push({ alias, value: lowering.condition(attribute.expressionPlan.ast, scope), ...(guard === undefined ? {} : { accepts: `() => ${guard}` }) });
        classRules.push(`{ kind: "class", name: ${quote(attribute.name)}, read: () => ${alias} ?? Symbol.for("html-next.invalid-result") }`);
      }
    } else if (attribute.kind === "attribute" && attribute.target === "style") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled binding ${attribute.expression}.`);
      const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (guard === undefined && !mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) {
        const text = lowering.text(attribute.expressionPlan.ast, scope);
        addStyle(`${quote(reactStyleProperty(attribute.name))}: String(${typeOf(attribute.expressionPlan.ast, scope).nullable ? `(${text}) ?? ""` : text})`);
      }
      else {
        const alias = `__retained${state.nextRetainedAlias++}`;
        state.usesRetainedValue = true;
        retainedBindings.push({ alias, value: lowering.value(attribute.expressionPlan.ast, scope), ...(guard === undefined ? {} : { accepts: `() => ${guard}` }) });
        const aliasScope = localScope(scope, [[alias, typeOf(attribute.expressionPlan.ast, scope)]]);
        addStyle(`${quote(reactStyleProperty(attribute.name))}: ${alias} == null ? undefined : String(${lowering.text({ kind: "id", name: alias }, aliasScope)})`);
      }
      const overridden = importantStyles.findIndex((style) => style.name === attribute.name);
      if (overridden >= 0) importantStyles.splice(overridden, 1);
    } else if (attribute.kind === "attribute" && attribute.twoWay === true) {
      if (attribute.expressionPlan === undefined || attribute.writablePath === undefined ||
        typeof attribute.writablePath[0] !== "string") {
        fail("HT030", `React conversion of bind:${attribute.name} on this element is not implemented.`);
      }
      const path = attribute.writablePath.slice(1);
      const dynamic = path.some((segment) => typeof segment === "object");
      const pathSource = `[${path.map((segment) => typeof segment === "object"
        ? lowering.value(segment.expression, scope) : JSON.stringify(segment)).join(", ")}]`;
      if (!component && ["input", "textarea", "select"].includes(node.name) && ["value", "checked"].includes(attribute.name) &&
        (attribute.name !== "checked" || node.name === "input")) {
        if (control !== undefined) fail("HT030", `React conversion of bind:${attribute.name} on this element is not implemented.`);
        const name = attribute.name as "value" | "checked";
        const value = lowering.value(attribute.expressionPlan.ast, scope);
        const defaults = authoredControlDefaults(node, name);
        control = { name, value, write: { state: attribute.writablePath[0], path: pathSource, dynamic },
          defaults, nativeProperty: false };
        const initial = name === "checked"
          ? `Boolean(${value})`
          : node.name === "select" ? `${value} as React.SelectHTMLAttributes<HTMLSelectElement>["defaultValue"]` : `String(${value} ?? "")`;
        const authored = name === "checked" ? `(${defaults}).checked`
          : node.name === "select" ? "undefined" : `(${defaults}).value`;
        bindings.push(memoControl
          ? `htmlNextDefault=${quote(name === "checked" ? "defaultChecked" : "defaultValue")} htmlNextAuthored={${authored}} htmlNextInitial={${initial}}`
          : `${name === "checked" ? "defaultChecked" : "defaultValue"}={hasMounted.current ? ${authored} : ${initial}}`);
      } else {
        genericWrites.push({ state: attribute.writablePath[0], path: pathSource, dynamic });
        bindings.push(`{...{ ${quote(nativeAttribute(attribute.name) ? attribute.name.toUpperCase() : attribute.name)}: ${attributeValue(attribute.expressionPlan.ast, scope, attribute.name)} }}`);
      }
    } else if (attribute.kind === "attribute" && attribute.twoWay !== true && attribute.target === undefined) {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled binding ${attribute.expression}.`);
      const componentPropName = component ? [...state.propsByTag?.get(node.name) ?? []]
        .find((name) => asciiLowerCase(name) === attribute.name || kebabCase(name) === attribute.name) : undefined;
      const componentPropContract = componentPropName === undefined ? undefined : componentContracts?.[componentPropName];
      const value = component && (componentPropName !== undefined || state.propsByTag?.get(node.name) === undefined)
        ? lowering.value(attribute.expressionPlan.ast, scope)
        : attributeValue(attribute.expressionPlan.ast, scope, attribute.name);
      const nativeValue = componentPropContract === undefined && (typeOf(attribute.expressionPlan.ast, scope).nullable || typeOf(attribute.expressionPlan.ast, scope).null === true) ? `(${value}) ?? undefined` : value;
      const sourceGuard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (nativeValueAttribute && attribute.name === "value") bindings.push(state.preact ? attributeBinding(attribute.name, nativeValue) : `htmlNextValue={${nativeValue}}`);
      else if ((node.name === "input" || node.name === "textarea") && attribute.name === "value") bindings.push(`defaultValue={${nativeValue}}`);
      else if (node.name === "input" && attribute.name === "checked") bindings.push(`defaultChecked={Boolean(${lowering.value(attribute.expressionPlan.ast, scope)})}`);
      else if (componentPropContract !== undefined) {
        const alias = boundPropAliases.get(componentPropName!)!;
        state.usesRetainedValue = true;
        const select = componentPropContract.select;
        const selectorContract = select === undefined ? undefined : componentContracts?.[select.from];
        const selectorLiteral = select === undefined ? undefined : node.attributes.find((entry) =>
          entry.kind === "literal" && findComponentPropName(entry.name) === select.from);
        const selectorAlias = select === undefined ? undefined : boundPropAliases.get(select.from);
        const selectorValue = select === undefined ? undefined : (selectorAlias === undefined ? undefined : `${selectorAlias}${boundPropSnapshots.has(select.from) ? "?.value" : ""}`)
          ?? (selectorLiteral?.kind === "literal" ? (() => {
            const parsed = selectorContract === undefined ? undefined
              : parseTypedValue(selectorLiteral.value, selectorContract.type, "$", "html");
            return JSON.stringify(parsed?.ok ? parsed.value : selectorLiteral.value);
          })() : selectorContract !== undefined && "default" in selectorContract ? JSON.stringify(selectorContract.default) : "undefined");
        const fixedSelector = selectorAlias !== undefined || selectorValue === undefined || selectorValue === "undefined"
          ? undefined : JSON.parse(selectorValue) as unknown;
        const fixedOption = select?.options.find(option => option.value === fixedSelector);
        const typeCheck = select === undefined || selectorContract === undefined
          ? destinationTypeCheck(normalizeType(componentPropContract.type), "candidate")
          : selectorAlias === undefined ? fixedOption === undefined ? "false" : destinationTypeCheck(fixedOption.type, "candidate")
          : `(${select.options.map((option) => `(${selectorValue} === ${JSON.stringify(option.value)} && ${destinationTypeCheck(option.type, "candidate")})`).join(" || ")})`;
        const accepts = `(candidate) => ${sourceGuard === undefined ? "" : `(${sourceGuard}) && `}(candidate === undefined${componentPropContract.required ? "" : " || candidate === null"} || ${typeCheck})`;
        const snapshot = boundPropSnapshots.has(componentPropName!);
        if (snapshot) {
          state.usesInputStatus = true; state.usesInputExpressions = true;
          const observed = lowering.value(attribute.expressionPlan.ast, state.observe(scope));
          const input = state.allocate("inputSnapshot");
          retainedBindings.push({ alias, value: `evaluateInput(() => ${sourceGuard === undefined ? observed : `((${sourceGuard}) ? ${observed} : Symbol.for("html-next.invalid-result"))`}, READY_INPUT)`,
            accepts: `(snapshot) => { const ${input} = snapshot as ReturnType<typeof evaluateInput>; return !${input}.status.ready || (${accepts})(${input}.value); }`, propName: componentPropName! });
          inputBindings.push(`${quote(componentPropName!)}: () => ${alias}`);
        } else retainedBindings.push({ alias, value, accepts, propName: componentPropName! });
        bindings.push(componentPropAttribute(componentPropName!, `${alias}${snapshot ? "?.value" : ""}`));
        const expression = attribute.expressionPlan.ast;
        if (expression.kind === "id") {
          const read = scope.code.get(expression.name);
          const prop = Object.hasOwn(state.definition.contract.props, expression.name) && read === `checkedProps[${quote(expression.name)}]`;
          const computed = (state.definition.declarations ?? []).some(declaration => declaration.kind === "computed" && declaration.name === expression.name);
          if (prop || computed && read?.endsWith(".get()")) inputBindings.push(`${quote(componentPropName!)}: () => ({ value: ${alias}, status: ${prop ? `propInputs.status(${quote(expression.name)})` : read!.replace(/\.get\(\)$/, ".status()")} })`);
        }
      }
      else if (!component && attribute.name === "style") {
        let rendered = nativeValue;
        if (sourceGuard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) {
          const alias = `__retained${state.nextRetainedAlias++}`;
          const fallback = node.attributes.find(binding => binding.kind === "literal" && binding.name === "style");
          state.usesRetainedValue = true;
          retainedBindings.push({ alias, value: lowering.value(attribute.expressionPlan.ast, scope),
            ...(sourceGuard === undefined ? {} : { accepts: `() => ${sourceGuard}` }),
            ...(fallback?.kind === "literal" ? { initial: quote(fallback.value) } : {}) });
          rendered = alias;
        }
        importantStyles.length = 0;
        if (orderedStyles) orderedStyleValue = `styleObject(${rendered})`;
        else bindings.push(`style={styleObject(${rendered})}`);
      }
      else if (!component && (sourceGuard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope))) {
        const alias = `__retained${state.nextRetainedAlias++}`;
        state.usesRetainedValue = true;
        const fallback = node.attributes.find(binding => binding.kind === "literal" && binding.name === attribute.name);
        const initial = forwards && fallback?.kind === "literal" ? quote(fallback.value) : undefined;
        const ready = forwards && initial === undefined ? `${alias}Ready` : undefined;
        retainedBindings.push({ alias, value: lowering.value(attribute.expressionPlan.ast, scope),
          ...(sourceGuard === undefined ? {} : { accepts: `() => ${sourceGuard}` }), ...(initial === undefined ? {} : { initial }), ...(ready === undefined ? {} : { ready }) });
        const aliasScope = localScope(scope, [[alias, typeOf(attribute.expressionPlan.ast, scope)]]);
        const rendered = attributeValue({ kind: "id", name: alias }, aliasScope, attribute.name);
        const serialized = typeOf(attribute.expressionPlan.ast, scope).nullable ? `(${rendered}) ?? undefined` : rendered;
        bindings.push(ready === undefined ? attributeBinding(attribute.name, serialized)
          : `{...(${ready} ? { ${quote(reactAttribute(attribute.name, svg))}: ${serialized} } : {})}`);
      } else if (attribute.name === "__proto__") bindings.push(componentPropAttribute("__Proto__", nativeValue));
      else if (nativeAttribute(attribute.name) || serializedAttribute(attribute.name)) bindings.push(attributeBinding(attribute.name, nativeValue));
      else bindings.push(`${componentPropName ?? reactAttribute(attribute.name, svg)}={${NUMERIC_ATTRIBUTES.has(attribute.name) && !component ? `(${value}) as any` : nativeValue}}`);
    } else if (attribute.kind === "property") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled property ${attribute.expression}.`);
      const value = lowering.value(attribute.expressionPlan.ast, scope);
      if (["input", "textarea", "select"].includes(node.name) && ["value", "checked"].includes(attribute.name)) {
        if (control !== undefined || attribute.name === "checked" && node.name !== "input") {
          fail("HT030", `React conversion of .${attribute.name} on <${node.name}> is not implemented.`);
        }
        const name = attribute.name as "value" | "checked";
        const defaults = authoredControlDefaults(node, name);
        control = { name, value, defaults, nativeProperty: true };
        const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
        const retains = guard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope);
        const alias = retains ? `__retained${state.nextRetainedAlias++}` : value;
        if (retains) {
          state.usesRetainedValue = true;
          retainedBindings.push({ alias, value, accepts: `() => ${guard ?? "true"}` });
          if (guard !== undefined) control = { ...control, accepts: guard };
        }
        const selectValue = node.name === "select" && node.attributes.some((entry) => entry.kind === "literal" && entry.name === "multiple")
          ? `[String(${alias})]` : `String(${alias})`;
        const initial = name === "checked"
          ? `Boolean(${alias})`
          : node.name === "select" ? `${alias} == null ? undefined : ${selectValue} as React.SelectHTMLAttributes<HTMLSelectElement>["defaultValue"]`
            : `${alias} == null ? undefined : String(${alias})`;
        const authored = name === "checked" ? `(${defaults}).checked`
          : node.name === "select" ? "undefined" : `(${defaults}).value`;
        bindings.push(memoControl
          ? `htmlNextDefault=${quote(name === "checked" ? "defaultChecked" : "defaultValue")} htmlNextAuthored={${authored}} htmlNextInitial={${initial}}`
          : `${name === "checked" ? "defaultChecked" : "defaultValue"}={hasMounted.current ? ${authored} : ${initial}}`);
      } else if (attribute.name === "textContent") {
        const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
        if (guard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) {
          state.usesRetainedText = true;
          content = `<RetainedText value={${value}} text={${lowering.use("text")}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} />`;
        } else content = `{${nullableText(value, lowering)}}`;
      }
      else {
        const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
        const accepts = `(((${value}) as unknown) !== Symbol.for("html-next.invalid-result")${guard === undefined ? "" : ` && (${guard})`})`;
        properties.push({ name: attribute.name, value, accepts });
        const retained = (SSR_BOOLEAN_PROPERTIES.has(attribute.name) || SSR_STRING_PROPERTIES.has(attribute.name)) &&
          (guard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope));
        const alias = retained ? `__retained${state.nextRetainedAlias++}` : value;
        if (retained) {
          state.usesRetainedValue = true;
          retainedBindings.push({ alias, value, ...(guard === undefined ? {} : { accepts: `() => ${guard}` }) });
        }
        if (SSR_BOOLEAN_PROPERTIES.has(attribute.name)) bindings.push(`${attribute.name}={Boolean(${alias})}`);
        else if (SSR_STRING_PROPERTIES.has(attribute.name)) bindings.push(`${attribute.name}={${alias} == null ? undefined : String(${alias})}`);
      }
    } else if (attribute.kind === "directive" && attribute.name === "value") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled value ${attribute.expression}.`);
      const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      const retained = mayProduceInvalidResult(attribute.expressionPlan.ast, scope) || guard !== undefined;
      const raw = lowering.value(attribute.expressionPlan.ast, scope);
      const text = nullableText(lowering.text(attribute.expressionPlan.ast, scope), lowering);
      const accepts = guard;
      if (outputValue) {
        // Each output owns its synchronization, including outputs rendered inside $each.
        state.usesOutputValue = true;
        bindings.push(`htmlNextValue={${raw}}`, `htmlNextText={${lowering.use("text")}}`, `htmlNextRetain={${retained}}`);
        if (accepts !== undefined) bindings.push(`htmlNextAccepts={${accepts}}`);
      } else if (retained) {
        state.usesRetainedText = true;
        content = `<RetainedText value={${raw}} text={${lowering.use("text")}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} />`;
      } else content = `{${text}}`;
    } else if (attribute.kind === "directive" && attribute.name === "html") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled HTML ${attribute.expression}.`);
      state.usesHtml = true;
      const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (guard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) {
        state.usesRetainedValue = true;
        const alias = `__retained${state.nextRetainedAlias++}`;
        content = `<RetainedValue value={${lowering.text(attribute.expressionPlan.ast, scope)}} accepts={() => ${guard ?? "true"}} render={(${alias}) => <SanitizedHtml value={${nullableText(alias, lowering)}} />} />`;
      } else content = `<SanitizedHtml value={${nullableText(lowering.text(attribute.expressionPlan.ast, scope), lowering)}} />`;
    } else {
      fail("HT030", `React conversion of ${attribute.kind === "directive" ? `$${attribute.name}` : `:${attribute.name}`} is not implemented.`);
    }
    } finally {
      if (forwards) ordered.push(...literals.slice(literalStart), ...bindings.slice(bindingStart));
      capturedBindings = bindings.length;
    }
  }
  let componentChildren = node.children;
  let defaultTemplate = false;
  if (component) {
    const { slots, defaults } = slotGroups(node.children);
    // A slot's first `<template slot>` is its whole content, and the slot renders that template's children.
    const defaultCarrier = defaults.find((child): child is ElementNode => child.kind === "element" && child.name === "template"
      && child.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "slot"));
    componentChildren = defaultCarrier?.children ?? defaults;
    defaultTemplate = defaultCarrier !== undefined;
    // `templates`: a `<template slot>` for a slot without props renders afresh at each `<slot of>` outlet, so an entry gives it as a function.
    const slotsSource = (tag: string, groups: ReadonlyMap<string, readonly TemplateNode[]>, slotScope: RenderScope, _templates = false): string => `{ ${[...groups].map(([name, children]) => {
      const carrier = children.find((child): child is ElementNode => child.kind === "element" && child.name === "template");
      const contracts = state.slotsByTag?.get(tag);
      // A slot declared with props that no outlet of the component renders is placed by its parent's `<slot of>`.
      const declared = contracts?.some((slot) => slot.name === name) === true ? undefined : state.componentGraph?.get(tag)?.contract.slots?.[name];
      const contract = contracts?.find((slot) => slot.name === name)
        ?? (declared === undefined ? undefined : { name, required: false, props: Object.keys(declared.props), declared: declared.props });
      if ((contract?.props?.length ?? 0) > 0) {
        const alias = `__slotProps${state.nextSlotAlias++}`;
        const projectedScope: RenderScope = withReferenceTypes({
          ...slotScope,
          code: new Map([...slotScope.code, ...contract!.props!.map((prop) => [prop, `${alias}[${quote(prop)}]`] as const)]),
          types: new Map([...slotScope.types, ...contract!.props!.map((prop) => [prop, slotPropStatic(contract!.declared?.[prop])] as const)]),
          local: true,
        }, contract!.props!.map(prop => [prop, contract!.declared?.[prop] === undefined ? undefined : normalizeType(contract!.declared[prop]!.type)]));
        if (carrier !== undefined) return `${quote(name)}: (${alias}: Record<string, any>) => <>${carrier.children.map((child) => renderNode(child, projectedScope, lowering, imports, handlers, attachments, state, undefined, true, inSvg)).join("")}</>`;
      }
      const content = carrier === undefined ? children : carrier.children;
      if (carrier !== undefined) return `${quote(name)}: () => <>${content.map((child) => renderNode(child, slotScope, lowering, imports, handlers, attachments, state, undefined, true, inSvg)).join("")}</>`;
      return `${quote(name)}: ${content.length === 0 ? "undefined" : `<>${content.map((child) => renderNode(child, slotScope, lowering, imports, handlers, attachments, state, undefined, true, inSvg)).join("")}</>`}`;
    }).join(", ")} }`;
    // Columns as markup: a slot with `accepts` and `as` takes one entry per accepted child, which the
    // receiving component reads before it renders (components#columns-as-markup). The entries are
    // written first, so each accepted child knows its entry's key when it renders.
    const invoked = state.componentGraph?.get(node.name);
    const accepting = Object.entries(invoked?.contract.slots ?? {}).filter(([, declared]) => declared.as !== undefined && (declared.accepts?.length ?? 0) > 0);
    // Whitespace between accepted children is not content, and a table part's outlet must not render it.
    if (accepting.some(([slot]) => slot === "")) componentChildren = componentChildren.filter((child) => !isWhitespace(child));
    const lists = accepting.length === 0 ? undefined : `htmlNextAs={{ ${accepting.map(([slot, declared]) => {
      const group = slot === "" ? componentChildren : slots.get(slot) ?? [];
      const carrier = group.find((child): child is ElementNode => child.kind === "element" && child.name === "template"
        && child.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "slot"));
      return `${quote(declared.as!)}: [${childDescriptors(carrier?.children ?? group, scope, lowering, state, invoked!, slot, declared.accepts!, declared.as!, slotsSource)}]`;
    }).join(", ")} }}`;
    if (slots.size > 0) bindings.push(`slots={${slotsSource(node.name, slots, scope)}}`);
    if (lists !== undefined) bindings.push(lists);
    // An accepted child finds its logical projection and context providers through its entry key.
    const site = state.entrySites.get(node.attributes);
    if (site !== undefined) bindings.push(`htmlNextEntry={${entryKeySource(site, state.rowKeys)}}`);
  }
  if (classRules.length > 0) {
    const base = [...classes];
    const text = classes.length === 0 ? "undefined"
      : base.length === 1 ? base[0]! : `[${base.join(", ")}].filter(value => value != null).join(" ")`;
    const initial = `${lowering.use("classText")}(${text}, [${classRules.join(", ")}])`;
    const value = component || orderedClasses ? initial : `typeof document === "undefined" ? ${initial} : ${text}`;
    const prop = component ? findComponentPropName("class") : undefined;
    bindings.push(prop === undefined ? `className={${value}}` : componentPropAttribute(prop, value));
  } else if (classes.length > 0) {
    const value = `[${classes.join(", ")}].filter(Boolean).join(" ")`;
    const prop = component ? findComponentPropName("class") : undefined;
    bindings.push(prop === undefined ? `className={${value}}` : componentPropAttribute(prop, value));
  }
  if (componentStyle) {
    const rules = styleWriteRules(node.attributes, (attribute, fallback) => {
      const plan = attribute.expressionPlan!;
      const guard = declaredReferenceGuard(plan, scope, state.definition, undefined, lowering);
      const source = attribute.target === "style" ? lowering.text(plan.ast, scope) : attributeValue(plan.ast, scope, "style");
      if (guard === undefined && !mayProduceInvalidResult(plan.ast, scope)) return source;
      const alias = `__retained${state.nextRetainedAlias++}`;
      state.usesRetainedValue = true;
      retainedBindings.push({ alias, value: guard === undefined ? source : `(${guard}) ? ${source} : Symbol.for("html-next.invalid-result")`, initial: fallback === undefined ? 'Symbol.for("html-next.invalid-result")' : quote(fallback) });
      return alias;
    }, "nativeAttrs");
    const value = `styleText("", ${rules})`;
    bindings.push(htmlInputs === undefined ? `style={${value} as any}` : `{...htmlAttributeInputs({ style: ${value} }, ${htmlInputs})}`);
  }
  if (orderedStyles) {
    importantStyles.length = 0;
    bindings.push(`style={(${orderedStyleValue}) as React.CSSProperties}`);
  }
  else if (literalStyles.length > 0 || reactiveStyles.length > 0) bindings.push(`style={{ ${[
    ...literalStyles,
    ...reactiveStyles,
  ].join(", ")} } as unknown as React.CSSProperties}`);
  const classOnly = !component && rootTag === undefined && (node.events?.length ?? 0) === 0 && control === undefined && genericWrites.length === 0 && importantStyles.length === 0 && node.ref === undefined
    && properties.length > 0 && properties.every(property => property.target !== undefined);
  if (classOnly) {
    const owner = state.allocate("__htmlNextClassOwner");
    state.classOwners.push(owner);
    const values = properties.map(property => `[${property.target === "class" ? quote(property.name) : "null"}, ${property.accepts === undefined ? property.value : `(${property.accepts}) ? ${property.value} : Symbol.for("html-next.invalid-result")`}]`);
    bindings.push(`ref={element => applyClassBindingRef(element, ${owner}, { ${orderedClasses ? "ordered: true, " : ""}bindings: [${values.join(", ")}] })}`);
  } else if ((node.events?.length ?? 0) > 0 || rootTag?.captureRoot === true || control !== undefined || genericWrites.length > 0 || properties.length > 0 || importantStyles.length > 0 || node.ref !== undefined) {
    for (const event of node.events ?? []) if (!handlers.has(event.handler)) fail("HT033", `Handler \`${event.handler}\` is not declared.`);
    const dynamicPaths = [control?.write, ...genericWrites].map((write) => write?.dynamic === true
      ? `() => ${write.path} as unknown as readonly (string | number)[]` : "undefined");
    // A path that depends on the render goes through ScopedAttachment, whose ref stays the same between renders.
    const scoped = scope.local === true && (control !== undefined || properties.length > 0) || dynamicPaths.some((path) => path !== "undefined");
    const listensOnly = (node.events?.length ?? 0) > 0 && rootTag === undefined && control === undefined && genericWrites.length === 0
      && properties.length === 0 && importantStyles.length === 0 && node.ref === undefined;
    const forwardsOnly = rootTag !== undefined && !component && (node.events?.length ?? 0) === 0 && control === undefined && genericWrites.length === 0
      && properties.length === 0 && importantStyles.length === 0 && node.ref === undefined && rootArms(state.definition.template) === undefined;
    const name = forwardsOnly ? "ownedRootRef" : listensOnly ? state.allocate(`${identifierFor(node.events![0]!.handler)}Events`) : `attachEvents${attachments.length}`;
    const attachment: EventAttachment = { ...(orderedClasses ? { orderedClasses: true } : {}), name, listensOnly, forwardsOnly, remembersParent: !component && (rootTag !== undefined || node.ref !== undefined), scoped, bindings: node.events ?? [], forward: rootTag !== undefined, properties, genericWrites, importantStyles,
      ...(node.ref === undefined ? {} : { ref: node.ref }), ...(control === undefined ? {} : { control }) };
    attachments.push(attachment);
    if (scoped) {
      const ref = `__htmlNextScopedRef${attachments.length - 1}`;
      scopedAttachment = { attachment, ref, paths: dynamicPaths };
      bindings.push(`ref={${ref}}`);
    } else bindings.push(`ref={${name}}`);
  }
  const preformatted = state.preformatted;
  if (isPreformattedElement(node.name)) state.preformatted = true;
  let children = outputValue || node.name === "textarea" && control?.name === "value" ? ""
    : content ?? componentChildren.map((child) => renderNode(node.name === "select" && control?.name === "value" ? withoutAuthoredSelection(child) : child,
      scope, lowering, imports, handlers, attachments, state, undefined, component, svg && node.name !== "foreignObject")).join("");
  if (defaultTemplate) children = `{() => <>${children}</>}`;
  state.preformatted = preformatted;
  const boundReflections = rootTag === undefined ? [] : Object.keys(state.definition.contract.props).flatMap((name) => {
    const attributeName = propAttribute(state.definition.contract.tag, name);
    if (!node.attributes.some((attribute) => attribute.kind === "attribute" && attribute.name === attributeName)) return [];
    const value = `checkedProps[${quote(name)}]`;
    const serialized = `typeof ${value} === "object" ? JSON.stringify(${value}) : String(${value})`;
    return [`${quote(attributeName)}: ${value} == null ? undefined : (${serialized})`];
  });
  const reflections = boundReflections.length === 0 ? rootTag?.reflections ?? []
    : [`{...(Object.assign({}, reflectedAttrs, { ${boundReflections.join(", ")} }) as Record<string, unknown>)}`];
  if (inputBindings.length > 0) bindings.push(`{...{ [BINDING_INPUTS_PROP]: { ${inputBindings.join(", ")} } }}`);
  const attributes = [...rootTag === undefined ? [] : ["{...rootMetadata(nativeAttrs)}"], ...(forwards ? [...ordered, ...bindings.slice(capturedBindings)] : [...literals, ...bindings]), ...(projected ? [`data-slotted=${quote(projectedOwner(node))}`] : []),
    ...reflections, ...(rootTag === undefined ? [] : [
      ...(rootTag.hostState ? [`${stateAttribute(rootTag.tag)}={hostState}`] : []),
      `{...{ component: [renderedIdentity, ${quote(rootTag.tag)}].filter(Boolean).join(" ") }}`,
    ])];
  if (boundStyle || orderedStyles) {
    const style = orderedStyles ? orderedStyleValue : bindings.find(binding => binding.startsWith("style={"))?.slice(7, -1) ?? "{}";
    const ref = attributes.findIndex(attribute => attribute.startsWith("ref={"));
    const previous = ref < 0 ? undefined : attributes.splice(ref, 1)[0]!.slice(5, -1);
    const styleAttribute = attributes.findIndex(attribute => attribute.startsWith("style={"));
    if (styleAttribute >= 0) attributes.splice(styleAttribute, 1);
    attributes.push(`{...styleBinding((${style}) as React.CSSProperties${previous === undefined ? "" : `, ${previous}`})}`);
  }
  const finalAttributes = htmlInputs === undefined ? attributes : [`{...(invocationProps(${jsxAttributeRecord(attributes)}, ${htmlInputs}) as any)}`];
  const renderedAttributes = !state.preact && (tag === "HtmlNextInput" || tag === "HtmlNextValueInput")
    ? [`htmlNextAttributes={${jsxAttributeRecord(finalAttributes)}}`] : finalAttributes;
  const opening = `<${tag}${renderedAttributes.length === 0 ? "" : ` ${renderedAttributes.join(" ")}`}`;
  const markup = component && children === "" || !component && isVoidElement(node.name)
    ? `${opening} />` : `${opening}>${children}</${tag}>`;
  const selectorNames = new Set(Object.values(componentContracts ?? {}).flatMap((contract) => contract.select === undefined ? [] : [contract.select.from]));
  const scopedMarkup = scopedAttachment === undefined ? markup : `<ScopedAttachment attach={${scopedAttachment.attachment.name}}${!scopedAttachment.paths.some(path => path !== "undefined") ? "" : ` paths={[${scopedAttachment.paths.join(", ")}]}`} properties={[${scopedAttachment.attachment.properties.map((property) =>
    `{ name: ${quote(property.name)}, value: ${property.value}, accepted: ${property.accepts ?? "true"}${property.target === undefined ? "" : `, target: ${quote(property.target)}`}${property.namespace === undefined ? "" : `, namespace: ${quote(property.namespace)}, localName: ${quote(property.name.slice(property.name.indexOf(":") + 1))}, url: ${property.url === true}`} }`).join(", ")}]}${scopedAttachment.attachment.control === undefined ? "" :
    ` control={{ name: ${quote(scopedAttachment.attachment.control.name)}, value: ${scopedAttachment.attachment.control.value}, defaults: ${scopedAttachment.attachment.control.defaults}, nativeProperty: ${scopedAttachment.attachment.control.nativeProperty}, accepted: ${scopedAttachment.attachment.control.accepts ?? "true"} }}`} render={(${scopedAttachment.ref}) => ${markup}} />`;
  return retainedBindings.toSorted((a, b) => Number(selectorNames.has(b.propName ?? "")) - Number(selectorNames.has(a.propName ?? ""))).reduceRight((result, retained) =>
    `<RetainedValue value={${retained.value}}${retained.accepts === undefined ? "" : ` accepts={${retained.accepts}}`} render={(${retained.initial === undefined ? retained.alias : `${retained.alias}Read`}${retained.ready === undefined && retained.initial === undefined ? "" : `, ${retained.ready ?? `${retained.alias}Ready`}`}) => ${retained.initial === undefined ? result : `{ const ${retained.alias} = ${retained.alias}Ready ? ${retained.alias}Read : ${retained.initial}; return ${result}; }`}} />`, scopedMarkup);
}

/** A component invocation's children by the slot each is assigned to; `slot=""` names the default slot, as no `slot` does. */
function slotGroups(children: readonly TemplateNode[]): { readonly slots: Map<string, TemplateNode[]>; readonly defaults: TemplateNode[] } {
  const slots = new Map<string, TemplateNode[]>();
  const defaults: TemplateNode[] = [];
  for (const child of children) {
    if (child.kind !== "element") { defaults.push(child); continue; }
    const assigned = child.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "slot");
    if (assigned?.kind !== "literal" || assigned.value === "") { defaults.push(child); continue; }
    const group = slots.get(assigned.value) ?? [];
    group.push(child);
    slots.set(assigned.value, group);
  }
  return { slots, defaults };
}

const isWhitespace = (node: TemplateNode): boolean => node.kind === "text" && node.expressionPlan === undefined && node.segments === undefined && /^[\t\n\f\r ]*$/.test(node.value);

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function listed(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/**
 * A `<slot of>` outlet's props, by accepted tag, as live's `childSlotProps` checks them against the
 * child's slot declaration: a static prop converts by its declared type, a bound one its type rejects
 * warns (HR007), and it, a null one and a declared one the outlet leaves out take the declared default.
 * An undeclared or missing required prop warns. The name of a module constant, or undefined when no
 * accepted tag declares or is given any.
 */
function outletPropsSource(node: SlotNode, state: RenderState): string | undefined {
  const name = node.name ?? "";
  const given = node.props ?? [];
  const outlet = `<slot of name="${name}">`;
  const file = state.definition.source.file;
  const accepts = entryTags(state.definition.contract, node.of!);
  const shapes = accepts.flatMap((tag) => {
    const accepted = state.componentGraph?.get(tag);
    const declared = accepted?.contract.slots?.[name]?.props ?? {};
    if (accepted === undefined || given.length + Object.keys(declared).length === 0) return [];
    const warn = (prop: string, message: string): string => `warnUnless(false, ${quote(`${file}#${state.definition.contract.tag}:of:${name}:${prop}`)}, ${quote(`${warningPrefix(file)}${message}`)}); `;
    let warnings = "";
    const values = given.map((prop) => {
      const key = quote(prop.name);
      const contract = declared[prop.name];
      if (contract === undefined) {
        warnings += warn(prop.name, `${outlet} gives prop \`${prop.name}\`, which \`${tag}\`'s slot \`${name}\` does not declare.`);
        return `if (${key} in s) t[${key}] = s[${key}];`;
      }
      if (prop.raw !== undefined) return `t[${key}] = ${JSON.stringify(invocationValue(contract, prop.raw, "html", true) ?? null)};`;
      const type = normalizeType(contract.type);
      const absent = contract.default === undefined ? "null" : JSON.stringify(contract.default);
      if (type.kind === "terminal" && type.name === "unknown") return `if (${key} in s) t[${key}] = s[${key}] ?? ${absent};`;
      state.usesSlotPropChecks = true;
      const message = `${warningPrefix(file)}Slot \`${name}\` prop \`${prop.name}\` does not satisfy its declared type \`${formatType(type)}\`.`;
      return `if (${key} in s) { const y = s[${key}]; t[${key}] = y != null && typeof y !== "symbol" && warnUnless(acceptsSlotProp(y, ${JSON.stringify(type)}), ${quote(`${file}#slot:${name}:${prop.name}`)}, ${quote(message)}) ? y : ${absent}; }`;
    });
    for (const [prop, contract] of Object.entries(declared)) {
      if (given.some((entry) => entry.name === prop)) continue;
      if (contract.required) warnings += warn(prop, `${outlet} must give prop \`${prop}\`, which \`${tag}\`'s slot \`${name}\` declares as required.`);
      if (contract.default !== undefined) values.push(`t[${quote(prop)}] = ${JSON.stringify(contract.default)};`);
    }
    return [`${quote(tag)}: (s: Record<string, unknown>) => { ${warnings}const t: Record<string, unknown> = {}; ${values.join(" ")} return t; }`];
  });
  return shapes.length === 0 ? undefined : `htmlNextOutletProps${state.outletProps.push(`{ ${shapes.join(", ")} }`) - 1}`;
}

/** An authored warning's text: `HR007: …`, after the definition file when there is one. */
const warningPrefix = (file: string): string => file === "" ? "HR007: " : `${file}: HR007: `;

/**
 * An accepted child's entry key, as source: its sites in its slot's content, and the key of each
 * `$each` row it is in (by that `$each`'s attributes), from `rowKeys`.
 */
type KeySegment = string | readonly unknown[];
function entryKeySource(segments: readonly KeySegment[], rowKeys: ReadonlyMap<readonly unknown[], string>): string {
  return segments.map((segment) => typeof segment === "string" ? quote(segment) : `":" + identityKey(${rowKeys.get(segment) ?? "undefined"})`).join(" + ");
}

/**
 * The entries a consumer gives a slot with `accepts` (components#columns-as-markup), as array spread
 * source: one per accepted child in content order, following each child's `$if`, `$each`, `$with` and
 * `$match`, and `<template>` regions, with its declared props resolved and its slot content. Other
 * content is left out with a warning. Each accepted child's key segments are recorded in
 * `state.entrySites`, so the child finds its entry when it renders.
 */
function childDescriptors(
  children: readonly TemplateNode[], scope: RenderScope, lowering: Lowering, state: RenderState, receiver: ComponentDefinition,
  slot: string, accepts: readonly string[], as: string,
  slotsSource: (tag: string, groups: ReadonlyMap<string, readonly TemplateNode[]>, scope: RenderScope, templates: boolean) => string,
): string {
  const named = `\`${receiver.contract.tag}\`'s ${slot === "" ? "default slot" : `\`${slot}\` slot`}`;
  // The receiver warns under its own file, as live warns under the slot's definition.
  const leftOut = (key: string, message: string): string => `[{ leftOut: ${quote(`${receiver.contract.tag}:accepts:${slot}:${key}`)}, message: ${quote(message)} }]`;
  const spread = (items: readonly string[]): string => `[${items.map((item) => `...${item}`).join(", ")}]`;
  const items = (nodes: readonly TemplateNode[], itemScope: RenderScope, segments: readonly KeySegment[], rowKeys: ReadonlyMap<readonly unknown[], string>, top: boolean): string[] =>
    nodes.flatMap((child, site) => one(child, itemScope, [...segments, `${top ? "" : "."}${site}`], rowKeys));
  // One child, as array-expression sources.
  const one = (node: TemplateNode, itemScope: RenderScope, segments: readonly KeySegment[], rowKeys: ReadonlyMap<readonly unknown[], string>): string[] => {
    if (node.kind === "slot") return [];
    if (node.kind === "text") return isWhitespace(node) ? [] : [leftOut("#text", `${named} accepts ${listed(accepts)}; this text is left out.`)];
    // An element's own `$match` chooses among its children, which are its content.
    const child = node.name === "template" ? node : elementMatchRoot(node);
    const { flow, ...body } = child;
    const entry = (bodyScope: RenderScope, keySegments: readonly KeySegment[], keys: ReadonlyMap<readonly unknown[], string>): string => {
      if (body.name === "template") return spread(items(body.children, bodyScope, keySegments, keys, false));
      if (!accepts.includes(body.name)) {
        let preset: string | undefined;
        for (let root = state.componentGraph?.get(body.name)?.root; root?.kind === "component" && preset === undefined; root = state.componentGraph?.get(root.tag)?.root) {
          if (accepts.includes(root.tag)) preset = root.tag;
        }
        return preset === undefined ? leftOut(body.name, `${named} accepts ${listed(accepts)}; this \`<${body.name}>\` is left out.`)
          : leftOut(body.name, `\`<${body.name}>\` is a preset of \`${preset}\`, which ${named} accepts; a preset among accepted children is not supported yet, so it is left out.`);
      }
      state.entrySites.set(child.attributes, keySegments);
      const declared = state.componentGraph?.get(body.name)?.contract.props ?? {};
      const props = Object.entries(declared).map(([name, contract]) => {
        const attribute = body.attributes.find((candidate) => (candidate.kind === "literal" || candidate.kind === "attribute" && candidate.target === undefined && candidate.twoWay !== true) &&
          (candidate.name === asciiLowerCase(name) || candidate.name === kebabCase(name)));
        const absent = "default" in contract ? JSON.stringify(contract.default) : "null";
        if (attribute?.kind === "literal") {
          const parsed = parseTypedValue(attribute.value, contract.type, "$", "html");
          return `${propKey(name)}: ${parsed.ok ? JSON.stringify(parsed.value) : quote(attribute.value)}`;
        }
        if (attribute?.kind === "attribute" && attribute.expressionPlan !== undefined) return `${propKey(name)}: (${lowering.value(attribute.expressionPlan.ast, bodyScope)}) ?? ${absent}`;
        return `${propKey(name)}: ${absent}`;
      });
      const groups = slotGroups(body.children).slots;
      return `[{ key: ${entryKeySource(keySegments, keys)}, tag: ${quote(body.name)}, props: { ${props.join(", ")} }${groups.size === 0 ? "" : `, slots: ${slotsSource(body.name, groups, bodyScope, true)}`} }]`;
    };
    if (flow === undefined) return [entry(itemScope, segments, rowKeys)];
    if (flow.kind === "if" && flow.testPlan !== undefined) return [`(${lowering.condition(flow.testPlan.ast, itemScope)} ? ${entry(itemScope, segments, rowKeys)} : [])`];
    if (flow.kind === "with" && flow.expressionPlan !== undefined) {
      const alias = localIdentifier(flow.alias, itemScope, state);
      const aliasScope = localScope(itemScope, [[flow.alias, flow.aliasType === undefined ? typeOf(flow.expressionPlan.ast, itemScope) : present(flow.aliasType), alias, flow.aliasType ?? referenceType(flow.expressionPlan.ast, itemScope)]]);
      return [`(() => { const ${alias} = ${lowering.value(flow.expressionPlan.ast, itemScope)}; return ${entry(aliasScope, segments, rowKeys)}; })()`];
    }
    if (flow.kind === "each" && flow.listPlan !== undefined) {
      const item = localIdentifier(flow.item, itemScope, state);
      const index = localIdentifier(flow.index ?? "index", itemScope, state);
      const itemType = typeOf(flow.listPlan.ast, itemScope).type;
      const itemContract = referenceType(flow.listPlan.ast, itemScope);
      const filterScope = localScope(itemScope, [
        [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN, item, itemContract?.kind === "list" ? itemContract.item : undefined],
      ]);
      const rowScope = localScope(filterScope, [
        [flow.index ?? ITERATION_INDEX, { type: { kind: "terminal", name: "number" }, nullable: false }, index],
        [ITERATION_INDEX, { type: { kind: "terminal", name: "number" }, nullable: false }, index],
      ]);
      const list = lowering.list(flow.listPlan.ast, itemScope, item, {
        ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }), itemScope: filterScope,
        sort: (flow.sortKeys ?? []).map(({ path, descending }) => `${descending ? "-" : ""}${path.join(".")}`),
        ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
      });
      const keys = new Map(rowKeys).set(child.attributes, flow.keyPlan === undefined ? index : lowering.value(flow.keyPlan.ast, rowScope));
      return [`${lowering.eachRows(list)}.flatMap(({ item: ${item}, index: ${index} }) => ${entry(rowScope, [...segments, child.attributes], keys)})`];
    }
    if (flow.kind === "match" && body.name === "template") {
      const alias = flow.alias === undefined ? undefined : localIdentifier(flow.alias, itemScope, state);
      const armScope = flow.alias === undefined ? itemScope : localScope(itemScope, [[flow.alias,
        flow.expressionPlan === undefined ? UNKNOWN : typeOf(flow.expressionPlan.ast, itemScope), alias, flow.expressionPlan === undefined ? undefined : referenceType(flow.expressionPlan.ast, itemScope)]]);
      const arms = body.children.filter((arm): arm is ElementNode => arm.kind === "element");
      let chosen = "[]";
      for (const [index, arm] of [...arms.entries()].toReversed()) {
        const { flow: choice, ...armBody } = arm;
        const content = spread(one(armBody, armScope, [...segments, `|${index}`], rowKeys));
        if (choice?.kind === "else") chosen = content;
        else if (choice?.kind === "when" && choice.testPlan !== undefined) chosen = `(${lowering.condition(choice.testPlan.ast, armScope)} ? ${content} : ${chosen})`;
      }
      if (alias === undefined || flow.expressionPlan === undefined) return [chosen];
      return [`(() => { const ${alias} = ${lowering.value(flow.expressionPlan.ast, itemScope)}; return ${chosen}; })()`];
    }
    fail("HT030", `React conversion of $${flow.kind} among a slot's accepted children is not implemented.`);
  };
  return items(children, scope, [`${as}:`], new Map(), true).map((item) => `...${item}`).join(", ");
}

/** React component source and its feature-specific companion artifacts. */
export function generateReactOutput(definition: ComponentDefinition, version: string, options: ReactConversionOptions = {}): ReactConversionOutput {
  definition = condenseWhitespace(definition);
  const target = targetComponent(definition);
  const usesController = (definition.module ?? definition.controller) !== undefined;
  const headed = declaresHead(definition);
  // The head helper connects through the host's lifecycle.
  const usesHost = usesController || definition.lifecycle !== undefined || headed;
  /** Handlers whose steps read `$event`, filled as their functions are written below. */
  const handlerTakesEvent = new Set<HandlerDeclaration>();
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const initializedStates = states.filter(state => state.initializer !== undefined);
  const initializedNames = new Set(initializedStates.map(state => state.name));
  const data = declarations.filter((declaration): declaration is DataDeclaration => declaration.kind === "data");
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const usesTargetDispatch = handlers.some((handler) => handler.steps.some((step) => step.kind === "dispatch" && step.target !== undefined));
  const contexts = declarations.filter((declaration): declaration is ContextDeclaration => declaration.kind === "context");
  const providedContexts = new Set(states.map((state) => state.name).filter((name) => options.publishedStates?.has(name) ?? true));
  const usesContext = providedContexts.size > 0 || contexts.length > 0;
  const nestedDepthLimit = options.guardNestedDepth ? definitionMayInvokeComponents(definition) ? 32 : 33 : undefined;
  const name = definition.contract.name;
  const occupiedNames = new Set([...REACT_RESERVED, name, `${name}Inner`, `${name}Props`, ...[...componentTagsIn(definition.template)].map(componentName)]);
  /** An authored name where it is free, and otherwise the name with a suffix. */
  const allocate = (base: string, suffix = ""): string => {
    let name = GENERATED_NAME.test(base) ? `${base}${suffix || "_"}` : base;
    if (occupiedNames.has(name) && suffix !== "") name = `${base}${suffix}`;
    while (occupiedNames.has(name)) name += "_";
    occupiedNames.add(name);
    return name;
  };
  const handlerNames = new Map(handlers.map((handler) => [handler.name, allocate(identifierFor(handler.name), "Handler")] as const));
  const valueNames = new Map([...states, ...data, ...contexts, ...computed].map((declaration) => {
    const name = declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name;
    return [name, allocate(identifierFor(name), declaration.kind === "state" ? "State" : declaration.kind === "computed" ? "Computed" : declaration.kind === "data" ? "Data" : "Context")] as const;
  }));
  // A named declared script's status is the component's own state, read as a <data> read's is.
  const scriptNames = new Map((definition.scripts ?? []).flatMap((script) => script.name === undefined ? []
    : [[script.name, allocate(identifierFor(script.name), "Script")] as const]));
  const scriptSetters = new Map([...scriptNames].map(([name, variable]) => [name, allocate(`set${pascal(variable)}`)] as const));
  const stateSetters = new Map(states.map((state) => [state.name, allocate(`set${pascal(valueNames.get(state.name)!)}`)] as const));
  const stateGetters = new Map(states.map((state) => [state.name, allocate(`get${pascal(valueNames.get(state.name)!)}`)] as const));
  const stateSubscriptions = new Map(states.filter(state => (providedContexts.has(state.name) || usesController) && state.initializer === undefined).map(state => [state.name, allocate(`subscribe${pascal(valueNames.get(state.name)!)}`)] as const));
  const stateTouches = new Map(states.filter(state => usesController && state.initializer === undefined).map(state => [state.name, allocate(`notify${pascal(valueNames.get(state.name)!)}`)] as const));
  const stateOwners = new Map(initializedStates.map(state => [state.name, allocate(`${valueNames.get(state.name)!}Seed`)] as const));
  const contextEntries = new Map(contexts.map((context, index) => [context.as ?? context.name, `__context${index}!`] as const));
  // Columns as markup (components#columns-as-markup): each slot's `as` list, and whether a slot in the graph accepts this component.
  const lists = Object.entries(definition.contract.slots ?? {}).flatMap(([slot, declared]) => declared.as === undefined ? [] : [{ slot, as: declared.as, accepts: declared.accepts ?? [] }]);
  const listNames = new Map(lists.map((list) => [list.as, allocate(identifierFor(list.as), "List")] as const));
  const acceptedTags = new Set([...options.componentGraph?.values() ?? []].flatMap((other) => Object.values(other.contract.slots ?? {}).flatMap((declared) => declared.accepts ?? [])));
  const acceptedBy = [...options.componentGraph?.values() ?? []].some(other =>
    Object.values(other.contract.slots ?? {}).some(slot => slot.as !== undefined && slot.accepts?.includes(definition.contract.tag)));
  // A hand-written consumer's accepting parent finds this component among its children by its tag, and a preset by its root's.
  const childTags = [definition.contract.tag];
  for (let root = definition.root; root?.kind === "component" && !childTags.includes(root.tag); root = options.componentGraph?.get(root.tag)?.root) childTags.push(root.tag);
  const retainedPlain = new Set(retainedSlotNames(definition));
  for (const name of retainedPlain) if (Object.keys(definition.contract.slots?.[name]?.props ?? {}).length > 0 ||
    definition.slots?.some(slot => (slot.name ?? "") === name && (slot.props?.length ?? 0) > 0)) retainedPlain.delete(name);
  const sharedPlain = acceptedBy || retainedPlain.size > 0;
  const invalidateStateName = usesController && states.length > 0 ? allocate("rerender") : "";
  const invalidateSetterName = invalidateStateName !== "" && options.target === "preact" ? allocate("rerenderTick") : "";
  // The paths handler and bound-control writes changed, which the controller host reads after each commit.
  const stateWritesName = invalidateStateName === "" ? "" : allocate("stateWrites");
  const reflectPropName = target.props.length === 0 ? "" : allocate("reflectProp");
  const handlerComputedNames = new Map(computed.map((value, index) => [value.name, allocate(`__htmlNextHandlerComputed${index}`)] as const));
  const controllerComputedNames = new Map(computed.map((value, index) => [value.name, allocate(`__htmlNextControllerComputed${index}`)] as const));
  const computedPreviousNames = new Map(computed.map((value, index) => [value.name, allocate(`__htmlNextComputedPrevious${index}`)] as const));
  const computedAcceptedNames = new Map(computed.map((value, index) => [value.name, allocate(`__htmlNextComputedAccepted${index}`)] as const));
  const computedByName = new Map(computed.map((value) => [value.name, value] as const));
  const controllerStateTypes = Object.fromEntries(states.map((state) => [state.name, declarationTypeNode(state.type, state.shape)]));
  const checksControllerWrites = usesController && Object.values(controllerStateTypes).some((type) => type !== undefined);
  const eventSchemas = new Map(target.events.map((event, index) =>
    [event.name, allocate(`__htmlNextEventSchema${index}`)] as const));
  if (declarations.some((declaration) => !["state", "computed", "handler", "event", "context", "data"].includes(declaration.kind))) {
    fail("HT030", "React conversion of this declaration is not implemented.");
  }
  const template = definition.template;
  if (template.name === "template" && template.flow?.kind !== "match") fail("HT030", "React conversion requires one element root.");
  const lowering = new TypeScriptLowering("warnUnless");
  const code = new Map<string, string>();
  const types = new Map<string, Static>();
  for (const prop of target.props) {
    code.set(prop.name, `checkedProps[${quote(prop.name)}]`);
    const normalized = present(normalizeType(prop.contract.type));
    // Invalid incoming values remain at the source while validity reports the error. Even a
    // required numeric prop can therefore be null or raw text at runtime; arithmetic must guard it.
    types.set(prop.name, { ...normalized, nullable: true });
  }
  const stateTypes = new Map<string, string>();
  for (const state of states) {
    const inferred = state.expression === undefined ? UNKNOWN : typeOf(state.expression.ast, { code, types });
    const declaredType = declarationTypeNode(state.type, state.shape);
    const declared = declaredType === undefined ? inferred : present(declaredType);
    code.set(state.name, state.initializer === undefined ? valueNames.get(state.name)! : `${stateOwners.get(state.name)!}.get()`);
    types.set(state.name, { ...declared, nullable: declared.nullable || state.expression === undefined });
    stateTypes.set(state.name, state.expression === undefined && declaredType !== undefined
      ? `${typeScript(present(declaredType))} | null${state.initializer === undefined ? "" : " | undefined"}`
      : typeScript(types.get(state.name)!));
  }
  const stateType = (state: ReactiveDeclaration): string => stateTypes.get(state.name)!;
  const dataTypes = new Map<DataDeclaration, string>();
  for (const declaration of data) {
    const payload = declaration.type === undefined ? UNKNOWN.type
      : declaration.type === "text" ? { kind: "terminal", name: "string" } as const
      : parseTypeExpression(declaration.type);
    dataTypes.set(declaration, typeScript({ type: payload, nullable: false }));
    code.set(declaration.name, valueNames.get(declaration.name)!);
    types.set(declaration.name, { type: { kind: "object", open: false, fields: [
      { name: "pending", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "value", type: { kind: "union", members: [payload, { kind: "terminal", name: "null" }] }, optional: false },
      { name: "error", type: UNKNOWN.type, optional: false },
      { name: "ok", type: { kind: "terminal", name: "boolean" }, optional: false },
    ] }, nullable: false });
  }
  for (const [name, variable] of scriptNames) {
    code.set(name, variable);
    types.set(name, { type: { kind: "object", open: false, fields: [
      { name: "pending", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "ok", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "error", type: UNKNOWN.type, optional: false },
    ] }, nullable: false });
  }
  for (const context of contexts) {
    const alias = context.as ?? context.name;
    code.set(alias, valueNames.get(alias)!);
    const provider = options.componentGraph?.get(context.from)?.declarations?.find(value => value.kind === "state" && value.name === context.name);
    const declared = provider?.kind === "state" ? declarationTypeNode(provider.type, provider.shape) : undefined;
    types.set(alias, declared === undefined ? UNKNOWN : { ...present(declared), nullable: true });
  }
  for (const list of lists) {
    const entries = list.accepts.map((tag): TypeNode => {
      const props = options.componentGraph?.get(tag)?.contract.props;
      return props === undefined ? UNKNOWN.type : { kind: "object", open: false, fields: Object.entries(props).map(([name, prop]) =>
        ({ name, type: { kind: "union", members: [normalizeType(prop.type), { kind: "terminal", name: "null" }] }, optional: false })) };
    });
    code.set(list.as, listNames.get(list.as)!);
    types.set(list.as, { type: { kind: "list", item: entries.length === 1 ? entries[0]! : { kind: "union", members: entries } }, nullable: false });
  }
  // A fresh render recreates these lazy cells. Forward references stay valid, and a cyclic read
  // reaches the diagnostic guard instead of failing while the generated declarations initialize.
  for (const value of computed) {
    code.set(value.name, `${valueNames.get(value.name)!}.get()`);
    const inferred = value.expression === undefined ? UNKNOWN : typeOf(value.expression.ast, { code, types });
    // Even a non-null expression reads null while its inputComputed cell is unavailable.
    types.set(value.name, { ...inferred, nullable: true });
  }
  const imports = new Set<string>();
  const attachments: EventAttachment[] = [];
  const root: ElementNode = template;
  const scope = { code, types, ...referenceContext(definition) };
  const declarationStatus = (name: string, read: string, canonical = false): string | undefined => {
    if (initializedNames.has(name)) return `${stateOwners.get(name)!}.${canonical ? "readStatus" : "status"}()`;
    const entry = contextEntries.get(name);
    if (entry !== undefined) return canonical ? `(${entry}.readStatus?.() ?? ${entry}.status ?? READY_INPUT)` : `(${entry}.status ?? ((${read}) === undefined ? UNRESOLVED_INPUT : READY_INPUT))`;
    return undefined;
  };
  const observedScope = (source: Scope, inputs = "propInputs") => inputScope(source, (name, read) => {
    const status = declarationStatus(name, read, inputs.endsWith(".committed"));
    if (status !== undefined) return status;
    if (Object.hasOwn(definition.contract.props, name)) return `${inputs}.status(${quote(name)})`;
    if (computedByName.has(name)) return read.replace(/\.get\(\)$/, ".status()");
    return states.some(state => state.name === name) || contexts.some(context => (context.as ?? context.name) === name)
      ? `((${read}) === undefined ? UNRESOLVED_INPUT : READY_INPUT)` : undefined;
  });
  const reflections = [`data-html-next-renderer=${quote(options.target === "preact" ? "preact" : "react")}`,
    ...(target.props.length === 0 ? [] : ["{...reflectedAttrs}"])];
  const styles = compileComponentStylesForConversion(definition.css, definition, options.componentGraph, { nativeValueMetadata: options.target !== "preact" });
  const hostStateNames = componentStateNames(definition, options.componentGraph);
  const renderState: RenderState = { preact: options.target === "preact", definition, status: declarationStatus, observe: source => inputScope(source, (name, read) => read !== scope.code.get(name) ? undefined
    : Object.hasOwn(definition.contract.props, name) ? `propInputs.status(${quote(name)})`
      : computedByName.has(name) ? read.replace(/\.get\(\)$/, ".status()") : declarationStatus(name, read)), slotsByTag: options.slotsByTag, propsByTag: options.propsByTag, propContractsByTag: options.propContractsByTag,
    componentGraph: options.componentGraph, lists: lists.length > 0, sharedPlain, entrySites: new Map(), rowKeys: new Map(), outletProps: [],
    classOwners: [], nextSlotAlias: 0, nextRetainedAlias: 0, preformatted: false, usesHtml: false, usesPlainSlots: false, usesScopedSlots: false, usesKeyedLists: false,
    usesRetainedText: false, usesRetainedValue: false, usesOutputValue: false, allocate };
  const markup = renderNode(root, scope, lowering, imports, new Set(handlers.map((handler) => handler.name)), attachments, renderState,
    { tag: definition.contract.tag, reflections, captureRoot: true, hostState: hostStateNames.length > 0 });
  const usesEvents = attachments.some((attachment) => attachment.bindings.length > 0) || target.events.length > 0;
  const hasNativeBindings = attachments.some((attachment) => attachment.bindings.length > 0 && !attachment.listensOnly);
  const usesEventHooks = attachments.some((attachment) => attachment.listensOnly);
  const usesControls = attachments.some((attachment) => attachment.control !== undefined || attachment.genericWrites.length > 0);
  const usesNativeControls = attachments.some((attachment) => attachment.control !== undefined);
  const usesScopedAttachments = attachments.some((attachment) => attachment.scoped);
  const usesScopedPaths = attachments.some(attachment => attachment.scoped && (attachment.control?.write?.dynamic === true || attachment.genericWrites.some(write => write.dynamic)));
  const usesScopedControls = attachments.some(attachment => attachment.scoped && attachment.control !== undefined);
  const usesGenericBindings = attachments.some((attachment) => attachment.genericWrites.length > 0);
  const usesNestedControlWrites = attachments.some((attachment) =>
    attachment.control?.write?.path !== undefined && attachment.control.write.path !== "[]" ||
    attachment.genericWrites.some((write) => write.path !== "[]"));
  const usesHtml = renderState.usesHtml;
  const capturesRoot = attachments.some((attachment) => attachment.forward);
  const usesRefActions = handlers.some((handler) => handler.steps.some((step) => step.kind === "focus" || step.kind === "validate"));
  const usesRefs = usesTargetDispatch || usesRefActions || attachments.some((attachment) => attachment.ref !== undefined);
  const references = [...new Set(attachments.flatMap(attachment => attachment.ref === undefined ? [] : [attachment.ref]))];
  const iteratedRefs = [...iteratedRefNames(definition)];
  const rootType = rootArms(template) === undefined ? getDomInterface(template.name) ?? "HTMLElement"
    : [...new Set(rootArms(template)!.map((arm) => getDomInterface(arm.name) ?? "HTMLElement"))].join(" | ");
  const preservesRootFocus = rootArms(template) !== undefined;
  const publicRootType = rootType;
  const rootTags = [...new Set((rootArms(template) ?? [template]).map(root => root.name))];
  const nativeProps = rootTags.length === 1 && getDomInterface(rootTags[0]!) !== undefined
    ? `React.ComponentPropsWithoutRef<${quote(rootTags[0]!)}>` : `React.HTMLAttributes<${rootType}>`;
  const generics = selectorGenerics(definition.contract.props);
  const genericDeclaration = generics.length === 0 ? "" : `<${generics.map((generic) => generic.declaration).join(", ")}>`;
  const genericArguments = generics.length === 0 ? "" : `<${generics.map((generic) => generic.parameter).join(", ")}>`;
  const selectorParameters = new Map(generics.map((generic) => [generic.from, generic.parameter]));
  const props = target.props.map((prop) => `  ${propKey(prop.name)}${prop.contract.required ? "" : "?"}: ${selectorParameters.get(prop.name) ?? dependentPropTypeSource(prop.contract, selectorParameters)};`);
  const stateSelectedProps = target.props.filter((prop) => prop.contract.select !== undefined &&
    definition.contract.props[prop.contract.select.from] === undefined);
  const propSelectors = [...new Set(target.props.flatMap((prop) => prop.contract.select !== undefined &&
    definition.contract.props[prop.contract.select.from] !== undefined ? [prop.contract.select.from] : []))];
  const stateSelectors = [...new Set(stateSelectedProps.map((prop) => prop.contract.select!.from))];
  const validityType = (prop: PropContract) => prop.select === undefined ? normalizeType(prop.type)
    : { kind: "union" as const, members: prop.select.options.map((option) => option.type) };
  const namedSlots: SlotContract[] = [...(definition.slots ?? []).filter((slot) => slot.name !== undefined),
    ...Object.entries(definition.contract.slots ?? {}).flatMap(([name, declared]) => name === "" || (definition.slots ?? []).some((slot) => slot.name === name) ? []
      : [{ name, required: false, props: Object.keys(declared.props), declared: declared.props }])];
  const slotValueType = (slot: SlotContract): string => (slot.props?.length ?? 0) === 0
    ? "ReactNode | (() => ReactNode)"
    : `(props: ${slot.declared === undefined ? `Readonly<{ ${slot.props!.map((prop) => `${propKey(prop)}: any;`).join(" ")} }>` : slotPropsType(slot.declared)}) => ReactNode`;
  const slotsType = namedSlots.length === 0
    ? "Readonly<Record<string, ReactNode | ((props: Record<string, any>) => ReactNode)>>"
    : `Readonly<{ ${namedSlots.map((slot) => `${propKey(slot.name!)}?: ${slotValueType(slot)};`).join(" ")} }>`;
  const rootMarkup = markup.startsWith("{") ? `<>${markup}</>` : markup;
  const provide = (inner: string): string => states.filter((state) => providedContexts.has(state.name)).reduceRight((content, state) =>
    `<${contextExportName(definition.contract.tag, state.name)} value={{ value: ${code.get(state.name)!}, ${state.initializer === undefined ? `subscribe: ${stateSubscriptions.get(state.name)!}, ` : `status: ${stateOwners.get(state.name)!}.status(), readStatus: ${stateOwners.get(state.name)!}.readStatus, subscribe: ${stateOwners.get(state.name)!}.subscribe, `}read: ${stateGetters.get(state.name)!} }}>${content}</${contextExportName(definition.contract.tag, state.name)}>`, inner);
  const projectedMarkup = retainedPlain.size > 0 ? `<>${rootMarkup}<PlainSlots frames={htmlNextPlain.own} /></>` : rootMarkup;
  const contextMarkup = provide(lists.length === 0 ? projectedMarkup : `<ChildEntries value={htmlNextLists.entries}>${projectedMarkup}<PlainChildren entries={htmlNextLists.plainEntries} /></ChildEntries>`);
  const componentMarkup = nestedDepthLimit === undefined ? contextMarkup : `<NestedDepthContext value={nestedDepth + 1}>${contextMarkup}</NestedDepthContext>`;
  const HEAD_IMPORTS = "/* html-next head imports */";
  const written = [
    `// Generated by HTML Next ${version} for React 19. Do not edit.`,
    'import React from "react";',
    'import type { ReactNode } from "react";',
    ...(target.props.length === 0 && !checksControllerWrites && !renderState.usesInputStatus && computed.length === 0 && initializedStates.length === 0 && contexts.length === 0 ? [] : [`import { ${[
      ...(target.props.length === 0 ? [] : ["checkedProp", "checkPropInput", "usePropInputs", "BINDING_INPUTS_PROP", "mountPropValidity", "updatePropValidity", "PropBoundary", ...(usesController ? ["propValidityState"] : []), ...(target.props.some((prop) => prop.contract.select !== undefined) ? ["selectedPropNode"] : [])]),
      ...(!renderState.usesInputStatus && computed.length === 0 && initializedStates.length === 0 && contexts.length === 0 ? [] : ["requireInputStatus", "READY_INPUT", "UNRESOLVED_INPUT"]),
      ...(initializedStates.length === 0 ? [] : ["useInitializedState"]),
      ...(computed.length === 0 ? [] : ["inputComputed"]),
      ...(computed.length === 0 && initializedStates.length === 0 && !renderState.usesInputExpressions ? [] : ["inputRead", "inputDefault"]),
      ...(!renderState.usesInputExpressions && initializedStates.length === 0 ? [] : ["evaluateInput"]),
      ...((computed.length > 0 || renderState.usesInputExpressions) && target.props.length === 0 ? ["BINDING_INPUTS_PROP"] : []),
      ...(checksControllerWrites || initializedStates.length > 0 ? ["acceptsControllerWrite"] : []),
    ].join(", ")} } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(!renderState.usesSlotPropChecks ? [] : [`import { ${SLOT_PROP_IMPORT} } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(!renderState.usesStyle ? [] : [STYLE_IMPORT]),
    ...(!renderState.usesHtmlInputs ? [] : [`import { htmlAttributeInputs, invocationProps } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(templateForwardsAttributes(definition.template) ? [`import { forwardedAttributes } from ${quote(options.attributesSpecifier ?? "./attributes")};`] : []),
    ...(!attachments.some(attachment => attachment.properties.some(property => property.namespace !== undefined)) ? [] : [`import { applyNamespacedAttributes, namespacedAttributeProps } from ${quote(options.attributesSpecifier ?? "./attributes")};`]),
    ...(renderState.classOwners.length === 0 && !attachments.some(attachment => attachment.orderedClasses) ? [] : [`import { applyClassBindingRef } from ${quote(options.attributesSpecifier ?? "./attributes")};`]),
    ...(usesEvents ? [`import { ${[...(hasNativeBindings ? ["attachNativeEvents"] : []), ...(usesEventHooks ? ["useNativeEvents"] : []), ...(target.events.length > 0 ? ["dispatchDeclared", ...(usesTargetDispatch ? ["dispatchDeclaredTargets"] : [])] : [])].join(", ")} } from ${quote(options.eventsSpecifier ?? "./events")};`] : []),
    ...(usesControls ? [`import { ${[
      ...(usesNativeControls ? ["attachBoundControl", "syncBoundControl"] : []),
      ...(usesGenericBindings ? ["attachGenericBinding"] : []),
      ...(usesNestedControlWrites ? ["writeBoundPath"] : []),
    ].join(", ")} } from ${quote(options.controlSpecifier ?? "./control")};`] : []),
    ...(data.length === 0 ? [] : [`import { useDataRead } from ${quote(options.dataSpecifier ?? "./data")};`]),
    ...(usesHtml ? [`import { SanitizedHtml } from ${quote(options.htmlSpecifier ?? "./html")};`] : []),
    ...(usesController || definition.lifecycle !== undefined ? [`import { ${[...usesController ? ["useComponentHost"] : [], ...definition.lifecycle === undefined ? [] : ["useLifecycle"]].join(", ")} } from ${quote(options.hostSpecifier ?? "./host")};`] : []),
    ...(!headed ? [] : [HEAD_IMPORTS]),
    ...(usesContext ? [`import { componentContext } from ${quote(options.contextSpecifier ?? "./context")};`] : []),
    ...(target.requests.length === 0 ? [] : [
      ...(usesController ? [
        `import { ${REQUEST_CHECK} } from ${quote(options.propsSpecifier ?? "./props")};`,
        `import { ${REQUEST_HELPERS.join(", ")} } from ${quote(options.requestsSpecifier ?? "./requests")};`,
      ] : []),
      `import type { ${REQUEST_TYPES.join(", ")} } from ${quote(options.requestsSpecifier ?? "./requests")};`,
    ]),
    ...(nestedDepthLimit === undefined ? [] : [`import { NestedDepthContext } from ${quote(options.depthSpecifier ?? "./depth")};`]),
    RENDER_IMPORT,
    ...(options.modulePreparation === undefined ? [] : [`import { usePreparedModule } from ${quote(options.bindingsSpecifier ?? "./bindings")};`]),
    ...(styles.css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${name}.css`)};`]),
    ...[...imports].filter(tag => tag !== definition.contract.tag).sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.tsx`)};`),
    ...[...new Map(contexts.filter((context) => context.from !== definition.contract.tag || !providedContexts.has(context.name))
      .map((context) => [`${context.from}:${context.name}`, context] as const)).values()]
      .map((context) => `const ${contextExportName(context.from, context.name)} = componentContext<${types.get(context.as ?? context.name) === UNKNOWN ? "unknown" : `${typeScript(types.get(context.as ?? context.name)!)} | undefined`}>(${quote(context.from)}, ${quote(context.name)});`),
    ...(!renderState.usesChildSlots ? [] : [`const htmlNextChildSlots = ${JSON.stringify(Object.fromEntries(lists.flatMap((list) => list.accepts).flatMap((tag) => {
      const accepted = options.componentGraph?.get(tag);
      if (accepted === undefined) return [];
      const own = (accepted.slots ?? []).map((slot) => slot.name ?? "");
      const declared = Object.entries(accepted.contract.slots ?? {});
      const known = [...new Set([...declared.map(([name]) => name), ...own])];
      return [[tag, [own, declared.flatMap(([name, slot]) => Object.keys(slot.props).length > 0 ? [name] : []), known, listed(known.filter((name) => name !== ""))]]];
    })))} as const;`]),
    ...renderState.outletProps.map((shapes, index) => `const htmlNextOutletProps${index} = ${shapes};`),
    ...(checksControllerWrites ? [`const controllerStateTypes = ${JSON.stringify(controllerStateTypes)} as const;`] : []),
    ...(usesController && target.requests.length > 0 ? [`const requestAsk = ${frameworkRequestSource(target.requests, definition.source.file)};`] : []),
    ...target.events.map((event) =>
      `const ${eventSchemas.get(event.name)!} = ${JSON.stringify({ type: declarationTypeNode(event.type, event.shape)!, init: { bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable } })} as const;`),
    ...(states.filter((state) => providedContexts.has(state.name)).map((state) =>
      `export const ${contextExportName(definition.contract.tag, state.name)} = componentContext<${stateType(state)}>(${quote(definition.contract.tag)}, ${quote(state.name)});`)),
    "",
    `export type ${name}Props${genericDeclaration} = Omit<${nativeProps}, ${["style", "children", ...target.props.map((prop) => prop.name)].map(quote).join(" | ")}> & {`,
    ...props,
    // Each request is a function prop that answers it, and an event form that hears it.
    ...target.requests.flatMap((request) => [
      `  ${propKey(request.propName)}?: ${responderType(request)} | null;`,
      `  ${propKey(request.callbackName)}?: (${requestListenerType(request)}) | null;`,
    ]),
    ...(target.props.some((prop) => prop.name === "style") ? [] : ["  style?: React.CSSProperties | (React.CSSProperties & { [name: `--${string}`]: string | number | undefined });"]),
    "  children?: ReactNode | (() => ReactNode);",
    `  slots?: ${slotsType};`,
    `  ref?: React.Ref<${publicRootType}>;`,
    "  [name: string]: unknown;",
    "};",
    "",
    ...(target.props.length === 0 ? [] : [
      `export default function ${name}${genericDeclaration}(props: ${name}Props${genericArguments}) {`,
      `  return <PropBoundary value={props} render={(value) => <${name}Inner {...value} />} />;`,
      "}",
      "",
    ]),
    `${target.props.length === 0 ? "export default function " + name : "function " + name + "Inner"}${genericDeclaration}(props: ${name}Props${genericArguments}) {`,
    ...(nestedDepthLimit === undefined ? [] : [
      "  const nestedDepth = React.useContext(NestedDepthContext);",
      `  if (nestedDepth >= ${nestedDepthLimit}) {`,
      "    const message = 'Component invocations nested deeper than the lowering limit.';",
      "    throw Object.assign(new Error(`HR008: ${message}`), { name: 'HtmlDiagnosticError', diagnostic: Object.freeze({ code: 'HR008', message }) });",
      "  }",
    ]),
    `  const { children: _children, slots: _slots, ${lists.length === 0 ? "" : "htmlNextAs: _htmlNextAs, "}${acceptedBy ? "htmlNextEntry: _htmlNextEntry, " : ""}${target.props.length === 0 ? "" : "[BINDING_INPUTS_PROP]: _inputBindings, "}${[...target.props.map((prop) => prop.name), ...target.requests.flatMap((request) => [request.propName, request.callbackName])]
      .map((prop) => `${propKey(prop)}: ${allocate(`_${prop.replace(/[^A-Za-z0-9_$]/g, "_")}`)}`).join(", ")}${target.props.length + target.requests.length === 0 ? "" : ", "}...nativeAttrs } = props;`,
    '  const renderedIdentity = nativeAttrs["component"] ?? nativeAttrs["data-component"];',
    '  delete nativeAttrs["component"];',
    '  delete nativeAttrs["data-component"];',
    ...(options.modulePreparation === undefined ? [] : [
      `  const htmlNextPrepared = usePreparedModule(() => import(${quote((definition.module ?? definition.controller)!)}), ${JSON.stringify({ tag: definition.contract.tag, source: options.modulePreparation.source })});`,
      "  Object.assign(nativeAttrs, htmlNextPrepared.attributes(nativeAttrs));",
    ]),
    ...(options.target === "preact" ? [
      "  const { constructor: _nativeConstructor, ...nativeAttributes } = nativeAttrs;",
      '  if (Object.hasOwn(nativeAttrs, "constructor")) Object.assign(nativeAttributes, { CONSTRUCTOR: _nativeConstructor });',
    ] : []),
    ...(target.props.length > 0 || usesNativeControls ? [
      "  const hasMounted = React.useRef(false);",
      "  React.useLayoutEffect(() => { hasMounted.current = true; }, []);",
    ] : []),
    ...(target.props.length === 0 ? [] : [
      `  const acceptedProps = React.useRef<Record<string, unknown>>({ ${target.props.map((prop) =>
        `${propKey(prop.name)}: ${"default" in prop.contract ? JSON.stringify(prop.contract.default) : "null"}`).join(", ")} });`,
      `  const propInputs = usePropInputs(acceptedProps.current, { ${target.props.filter(prop => "default" in prop.contract).map(prop => `${propKey(prop.name)}: ${JSON.stringify(prop.contract.default)}`).join(", ")} }, (name, value, source, values) => { switch (name) {`,
      ...target.props.map(prop => {
        const select = prop.contract.select;
        const type = select === undefined ? JSON.stringify(normalizeType(prop.contract.type))
          : Object.hasOwn(definition.contract.props, select.from)
            ? `selectedPropNode(values[${quote(select.from)}], ${JSON.stringify(select.options)})`
            : `selectedPropNode(source ? ${stateGetters.get(select.from)!}() : ${code.get(select.from)!}, ${JSON.stringify(select.options)})`;
        return `    case ${quote(prop.name)}: return checkPropInput(value, ${type}, false, ${!prop.contract.required});`;
      }),
      `    default: return { ok: false }; } }${options.modulePreparation === undefined ? "" : `, inputs => htmlNextPrepared.restore(inputs, { ${propInputOrder(target.props).map(prop => `${propKey(prop.name)}: props[${quote(prop.name)}]`).join(", ")} }, _inputBindings)`});`,
      "  const inputAccepted: Record<string, boolean> = {};",
      "  const checkedProps = {",
      ...propInputOrder(target.props).map((prop) => {
        const type = `${typeSource(prop.contract.type)}${prop.contract.required ? "" : " | null"}`;
        return `    ${propKey(prop.name)}: ${stateSelectedProps.includes(prop) ? `propInputs.read(${quote(prop.name)}) as ${type}` : `propInputs.value<${type}>(${quote(prop.name)}, props[${quote(prop.name)}], _inputBindings as any, inputAccepted)`},`;
      }),
      "  };",
    ]),
    ...(lists.length === 0 ? [] : [
      `  const htmlNextLists = useChildLists(_htmlNextAs, ${JSON.stringify(Object.fromEntries(lists.map((list) => [list.as, [list.slot, list.accepts]])))}, ${quote(definition.contract.tag)}, ${quote(definition.source.file)}, props);`,
      ...lists.map((list) => `  const ${listNames.get(list.as)!} = htmlNextLists.lists[${quote(list.as)}] as ${typeScript(types.get(list.as)!)};`),
    ]),
    ...contexts.flatMap((context, index) => {
      const variable = `__context${index}`;
      const alias = context.as ?? context.name;
      const message = `<${definition.contract.tag}> requires context \`${context.name}\` from <${context.from}>.`;
      return [
        `  const ${variable} = React.useContext(${contextExportName(context.from, context.name)});`,
        `  if (${variable} === undefined) throw Object.assign(new Error(${quote(`HR009: ${message}`)}), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR009", message: ${quote(message)} }) });`,
        `  const ${valueNames.get(alias)!} = ${variable}.value${types.get(alias) === UNKNOWN ? " as any" : ""};`,
      ];
    }),
    ...(stateWritesName === "" ? [] : [`  const ${stateWritesName} = React.useRef<unknown[][]>([]);`]),
    // Handlers read a state's latest write through its getter; rendering reads the value React has.
    ...states.map((state) => {
      // A state without value reads null until written, as in every target (types#null-and-missing-values).
      const initial = state.expression === undefined ? "null" : lowering.value(state.expression.ast, uncheckedReferences(scope));
      if (state.initializer !== undefined) {
        const canonicalCode = new Map(scope.code);
        for (const prop of target.props) canonicalCode.set(prop.name, `propInputs.committed.read<${typeScript(types.get(prop.name)!)}>(${quote(prop.name)})`);
        for (const item of states) canonicalCode.set(item.name, `${stateGetters.get(item.name)!}()`);
        for (const item of computed) canonicalCode.set(item.name, `${controllerComputedNames.get(item.name)!}.get()`);
        for (const [alias, entry] of contextEntries) canonicalCode.set(alias, `((${entry}.read === undefined ? ${entry}.value : ${entry}.read())${types.get(alias) === UNKNOWN ? " as any" : ""})`);
        const expression = lowering.value(state.initializer.ast, observedScope(scope));
        const canonical = lowering.value(state.initializer.ast, observedScope({ ...scope, code: canonicalCode }, "propInputs.committed"));
        const declared = declarationTypeNode(state.type, state.shape);
        return `  const ${stateOwners.get(state.name)!}: ReturnType<typeof useInitializedState<${stateType(state)}>> = useInitializedState<${stateType(state)}>(() => evaluateInput(() => ${expression}), () => evaluateInput(() => ${canonical}), value => ${declared === undefined ? "true" : `acceptsControllerWrite(value, ${JSON.stringify(declared)}, []) || ${lowering.use("warnUnless")}(false, ${quote(`initializer:${state.name}`)}, ${quote(`State \`${state.name}\` does not satisfy its declared type.`)})`}, cycleCheckedComputed${stateWritesName === "" ? contexts.length === 0 ? "" : ", undefined, undefined" : `, ${stateWritesName}.current, ${quote(state.name)}`}${contexts.length === 0 ? "" : `, [${[...contextEntries.values()].join(", ")}]`});\n  const ${stateSetters.get(state.name)!} = ${stateOwners.get(state.name)!}.set, ${stateGetters.get(state.name)!} = ${stateOwners.get(state.name)!}.read;`;
      }
      return `  const [${valueNames.get(state.name)!}, ${stateSetters.get(state.name)!}, ${stateGetters.get(state.name)!}${stateSubscriptions.has(state.name) ? `, ${stateSubscriptions.get(state.name)!}` : ""}${stateTouches.has(state.name) ? `, ${stateTouches.get(state.name)!}` : ""}] = useLiveState<${stateType(state)}>(${initial}${stateWritesName === "" ? "" : `, ${stateWritesName}.current, ${quote(state.name)}`});`;
    }),
    ...(invalidateStateName === "" ? [] : invalidateSetterName === "" ? [`  const [, ${invalidateStateName}] = React.useReducer((revision: number) => revision + 1, 0);`] : [
      `  const [, ${invalidateSetterName}] = React.useState(0);`,
      `  const ${invalidateStateName} = React.useCallback(() => ${invalidateSetterName}(revision => revision + 1), []);`,
    ]),
    ...data.map((declaration) => {
      const parameters = declaration.parameters.map((parameter) =>
        `${propKey(parameter.name)}: ${lowering.value(parameter.expression.ast, scope)}`).join(", ");
      const sources = declaration.parameters.filter((parameter) => parameter.mode === "from")
        .map((parameter) => lowering.value(parameter.expression.ast, scope)).join(", ");
      return `  const ${valueNames.get(declaration.name)!} = useDataRead<${dataTypes.get(declaration)!}>({ ${declaration.source === undefined ? "" : `source: ${quote(declaration.source)}, `}definition: ${quote(definition.source.file)}, ${declaration.type === undefined ? "" : `type: ${quote(declaration.type)}, `}${declaration.debounce === undefined ? "" : `debounce: ${parseDuration(declaration.debounce)}, `}${declaration.poll === undefined ? "" : `poll: ${parseDuration(declaration.poll)}, `}sources: () => [${sources}], parameters: () => ({ ${parameters} }) });`;
    }),
    ...computed.map((value) => {
      const type = typeScript(types.get(value.name)!);
      const expression = value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, observedScope(scope));
      if (value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, scope)) {
        const previous = computedPreviousNames.get(value.name)!;
        const accepted = computedAcceptedNames.get(value.name)!;
        return [
          `  const ${previous} = React.useRef<{ value: ${type} } | undefined>(undefined);`,
          `  let ${accepted}: { value: ${type} } | undefined;`,
          `  const ${valueNames.get(value.name)!}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => ${expression} as any, cycleCheckedComputed, (next) => { if ((next as unknown) === Symbol.for("html-next.invalid-result")) return ${previous}.current?.value ?? null as ${type}; ${accepted} = { value: next }; return next; }, ${previous}.current === undefined ? undefined : READY_INPUT);`,
          `  React.useLayoutEffect(() => { if (${accepted} !== undefined) ${previous}.current = ${accepted}; });`,
        ].join("\n");
      }
      return `  const ${valueNames.get(value.name)!}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => (${expression}) as any, cycleCheckedComputed);`;
    }),
    ...(usesController || initializedStates.length > 0 ? computed.map((value) => {
      const controllerCode = new Map(scope.code);
      for (const prop of target.props) controllerCode.set(prop.name, `propInputs.committed.read<${typeScript(types.get(prop.name)!)}>(${quote(prop.name)})`);
      for (const state of states) controllerCode.set(state.name, `${stateGetters.get(state.name)!}()`);
      for (const [alias, entry] of contextEntries) controllerCode.set(alias, `((${entry}.read === undefined ? ${entry}.value : ${entry}.read())${types.get(alias) === UNKNOWN ? " as any" : ""})`);
      for (const declaration of computed) controllerCode.set(declaration.name, `${controllerComputedNames.get(declaration.name)!}.get()`);
      const controllerScope: Scope = { code: controllerCode, types: scope.types };
      const expression = value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, observedScope(controllerScope, "propInputs.committed"));
      const type = typeScript(types.get(value.name)!);
      if (value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, controllerScope)) {
        const previous = computedPreviousNames.get(value.name)!;
        return `  const ${controllerComputedNames.get(value.name)!}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => ${expression} as any, (compute) => cycleCheckedComputed(compute, false), next => (next as unknown) === Symbol.for("html-next.invalid-result") ? ${previous}.current?.value ?? null as ${type} : (${previous}.current = { value: next }).value, ${previous}.current === undefined ? undefined : READY_INPUT);`;
      }
      return `  const ${controllerComputedNames.get(value.name)!}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => (${expression}) as any, (compute) => cycleCheckedComputed(compute, false));`;
    }) : []),
    ...stateSelectedProps.map((prop) =>
      `  checkedProps[${quote(prop.name)}] = propInputs.value<${typeSource(prop.contract.type)}${prop.contract.required ? "" : " | null"}>(${quote(prop.name)}, props[${quote(prop.name)}], _inputBindings as any, inputAccepted);`),
    ...(target.props.length === 0 ? [] : [
      "  const propInputValues = { ...checkedProps,",
      ...target.props.map((prop) => `    ...(props[${quote(prop.name)}] == null ? {} : { ${propKey(prop.name)}: props[${quote(prop.name)}] }),`),
      "  };",
      `  const ${reflectPropName} = useReflectedProp();`,
      "  const reflectedAttrs = {",
      ...target.props.map((prop) => {
        const value = `(hasMounted.current && !inputAccepted[${quote(prop.name)}] ? props[${quote(prop.name)}] : checkedProps[${quote(prop.name)}])`;
        return `    ...(Object.hasOwn(props, ${quote(prop.name)}) ? { ${quote(propAttribute(definition.contract.tag, prop.name))}: ${reflectPropName}(${quote(prop.name)}, ${value}) } : {}),`;
      }),
      "  };",
    ]),
    ...initializedStates.map(state => `  const ${valueNames.get(state.name)!} = ${stateOwners.get(state.name)!}.get();`),
    ...(hostStateNames.length === 0 ? [] : [
      `  const hostState = [${hostStateNames.map((state) => `...hostStateTokens(${quote(state)}, ${code.get(state) ?? state})`).join(", ")}].join(" ");`,
    ]),
    ...(capturesRoot ? [
      `  const rootRef = React.useRef<${publicRootType} | null>(null);`,
      ...(preservesRootFocus ? ["  const rootFocusPending = React.useRef(false);"] : []),
      "  useRootHandle(rootRef, props.ref);",
      ...(attachments.some(attachment => attachment.forwardsOnly) ? ["  const ownedRootRef = useOwnedRootRef(rootRef);"] : []),
    ] : []),
    ...(target.props.length === 0 ? [] : [
      `  const propValidityContract = ${literalValueSource({ props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) => [name, { ...prop, type: validityType(prop) }])) })} as const;`,
      "  const propValidityElement = React.useRef<Element | null>(null);",
      "  const propValidityCleanup = React.useRef<(() => void) | null>(null);",
      "  React.useLayoutEffect(() => {",
      "    const element = rootRef.current;",
      "    if (element === null) return;",
      `    const binding = { contract: propValidityContract, values: { ...propInputValues${propSelectors.map((selector) => `, ${propKey(selector)}: checkedProps[${quote(selector)}]`).join("")}${stateSelectors.map((selector) => `, ${propKey(selector)}: ${valueNames.get(selector)!}`).join("")} } };`,
      "    if (propValidityElement.current !== element) {",
      "      propValidityCleanup.current?.();",
      "      propValidityCleanup.current = mountPropValidity(element, binding);",
      "      propValidityElement.current = element;",
      "    } else updatePropValidity(element, binding);",
      "  });",
      "  React.useLayoutEffect(() => () => { propValidityCleanup.current?.(); propValidityCleanup.current = null; propValidityElement.current = null; }, []);",
    ]),
    ...(usesRefs ? [
      `  const refElements = React.useRef(new Map<string, Set<Element>>([${references.map(name => `[${quote(name)}, new Set<Element>()]`).join(", ")}]));`,
    ] : []),
    ...(usesRefActions ? [
      "  function refTarget(name: string): Element | undefined {",
      "    let first: Element | undefined;",
      "    for (const element of refElements.current.get(name) ?? []) {",
      "      if (!element.isConnected) continue;",
      "      if (first === undefined || first.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) first = element;",
      "    }",
      "    return first;",
      "  }",
    ] : []),
    ...handlers.map((handler) => {
      const handlerCode = new Map(scope.code);
      for (const prop of target.props) handlerCode.set(prop.name, `propInputs.committed.read<${typeScript(types.get(prop.name)!)}>(${quote(prop.name)})`);
      for (const state of states) handlerCode.set(state.name, `${stateGetters.get(state.name)!}()`);
      for (const value of computed) handlerCode.set(value.name, `${handlerComputedNames.get(value.name)!}.get()`);
      handlerCode.set("$$event", "event");
      const handlerScope: Scope = { code: handlerCode, types: new Map([...scope.types, ["$$event", { type: { kind: "terminal", name: "event" }, nullable: false }]]) };
      const referencedComputed = new Set<string>();
      const includeDependencies = (dependencies: readonly string[]): void => {
        for (const dependency of dependencies) {
          const name = dependency.split(".", 1)[0]!;
          const declaration = computedByName.get(name);
          if (declaration === undefined || referencedComputed.has(name)) continue;
          referencedComputed.add(name);
          includeDependencies(declaration.expression?.dependencies ?? []);
        }
      };
      for (const step of handler.steps) {
        includeDependencies(step.guard?.dependencies ?? []);
        if (step.kind === "set") {
          includeDependencies(step.value.dependencies);
          includeDependencies(compilePath(step.path).dependencies);
        } else if (step.kind === "dispatch") includeDependencies(step.value?.dependencies ?? []);
      }
      const handlerComputed = computed.filter((value) => referencedComputed.has(value.name)).map((value) => {
        const type = typeScript(types.get(value.name)!);
        const expression = value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, observedScope(handlerScope, "propInputs.committed"));
        if (value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, handlerScope)) {
          const previous = computedPreviousNames.get(value.name)!;
          return `    const ${handlerComputedNames.get(value.name)!}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => ${expression} as any, (compute) => cycleCheckedComputed(compute, false), next => (next as unknown) === Symbol.for("html-next.invalid-result") ? ${previous}.current?.value ?? null as ${type} : (${previous}.current = { value: next }).value, ${previous}.current === undefined ? undefined : READY_INPUT);`;
        }
        return `    const ${handlerComputedNames.get(value.name)!}: ReturnType<typeof inputComputed<${type}>> = inputComputed<${type}>(() => (${expression}) as any, (compute) => cycleCheckedComputed(compute, false));`;
      });
      const steps = handler.steps.map((step) => {
        const guard = step.guard === undefined ? "" : `if (${lowering.condition(step.guard.ast, handlerScope)}) `;
        if (step.kind === "dispatch") {
          const declaration = target.events.find((event) => event.name === step.event);
          if (declaration === undefined) fail("HT034", `Handler \`${handler.name}\` dispatches undeclared event \`${step.event}\`.`);
          const detail = step.value === undefined ? "undefined" : lowering.value(step.value.ast, handlerScope);
          const schema = eventSchemas.get(declaration.name)!;
          if (step.target !== undefined) return `    ${guard}dispatchDeclaredTargets(refElements.current.get(${quote(step.target)}), ${quote(step.event)}, ${detail}, ${schema}.type, ${schema}.init);`;
          return `    ${guard}dispatchDeclared(rootRef.current, ${quote(step.event)}, ${detail}, ${schema}.type, ${schema}.init);`;
        }
        if (step.kind === "focus") return `    ${guard}(refTarget(${quote(step.target)}) as HTMLElement | undefined)?.focus();`;
        if (step.kind === "validate") return `    ${guard}(refTarget(${quote(step.target)}) as HTMLInputElement | undefined)?.reportValidity?.();`;
        if (step.kind !== "set" || typeof step.writablePath[0] !== "string") {
          fail("HT030", `React conversion of handler step in \`${handler.name}\` is not implemented.`);
        }
        const state = states.find((candidate) => candidate.name === step.writablePath[0]);
        if (state === undefined) fail("HT031", `\`${step.path}\` is not a writable state path.`);
        const setter = stateSetters.get(state.name)!;
        const assignment = state.initializer === undefined ? setter : `${stateOwners.get(state.name)!}.assign`;
        const value = lowering.value(step.value.ast, handlerScope);
        const mayBeInvalid = mayProduceInvalidResult(step.value.ast, handlerScope);
        const proven = !mayBeInvalid && provenWrite(step, definition);
        // A proven write is never null; any other null or undefined reverts to the declared value.
        const reverted = proven ? value : withRevert(value, step.value.ast,
          revertSource(definition, step.writablePath, (segment) => lowering.value(segment.expression, handlerScope)));
        // An untyped state accepts any value, as in the live runtime, whatever its initial value's type.
        const declared = declarationTypeNode(state.type, state.shape);
        const destinationCheck = proven ? undefined : refusing(handlerDestinationCheck(declared, step.writablePath, 1, "value", handlerScope, lowering));
        const destination = handlerScope.types.get(state.name)?.type;
        const current = valueNames.get(state.name)!;
        const path = `[${step.writablePath.slice(1).map((segment) => typeof segment === "object"
          ? lowering.value(segment.expression, handlerScope) : JSON.stringify(segment)).join(", ")}]`;
        // A controller host learns the path a nested write changed, so it notifies only that path. A
        // function-valued state writes through an updater, which the setter would otherwise call.
        const setPath = (written: string): string => stateWritesName === "" ? `${setter}((previous) => writeStatePath(previous, ${path}, ${written}))`
          : `{ const path = ${path}; ${setter}((previous) => writeStatePath(previous, path, ${written}), path); }`;
        const unknown = destination === undefined || category(destination) === "unknown";
        if (destinationCheck === undefined && !mayBeInvalid) {
          // A value of the state's own kind writes as it is; another kind is cast. React types an untyped
          // state by its initial value, which any other kind would contradict.
          const self = proven ? selfStep(step, definition) : undefined;
          const write = step.writablePath.length > 1 ? setPath(reverted)
            : self !== undefined ? `${setter}((${current}) => ${self.decimal
              ? `${lowering.use(self.op === "+" ? "decimalAdd" : "decimalSubtract")}(${current}, ${self.amount})` : `${current} ${self.op} ${self.amount}`})`
            : (unknown ? state.initializer === undefined ? `${setter}(() => ${reverted} as typeof ${current})` : `${assignment}(${reverted} as typeof ${current})`
              : category(destination) === category(typeOf(step.value.ast, handlerScope).type) ? `${assignment}(${reverted})`
              : `${assignment}(${reverted} as ${declared === undefined ? "never" : `typeof ${current}`})`);
          return `    ${guard}${write}${write.endsWith("}") ? "" : ";"}`;
        }
        const to = step.writablePath.length > 1 ? `(next) => ${setPath("next")}` : unknown ? state.initializer === undefined ? `(next) => ${setter}(() => next)` : `(next) => ${assignment}(next)` : assignment;
        return `    ${guard}${lowering.use("write")}(${to}, ${reverted}${writeCheck(destinationCheck, definition, handler, step)});`;
      });
      const takesEvent = [...handlerComputed, ...steps].some((line) => /\bevent\b/.test(line));
      if (takesEvent) handlerTakesEvent.add(handler);
      return [
        `  function ${handlerNames.get(handler.name)!}(${takesEvent ? "event: Event" : ""}): void {`,
        ...handlerComputed,
        ...steps,
        "  }",
      ].join("\n");
    }),
    ...renderState.classOwners.map(owner => `  const ${owner} = React.useRef<object>({}).current;`),
    ...attachments.flatMap((attachment) => attachment.control === undefined || attachment.scoped ? [] : [
      `  const controlRef${attachment.name} = React.useRef<Element | null>(null);`,
      `  const controlValue${attachment.name} = React.useRef(${attachment.control.value});`,
      `  controlValue${attachment.name}.current = ${attachment.control.value};`,
      `  React.useLayoutEffect(() => { syncBoundControl(controlRef${attachment.name}.current, ${quote(attachment.control.name)}, ${attachment.control.value}, ${attachment.control.defaults}, ${attachment.control.nativeProperty}, ${attachment.control.accepts ?? "true"}); });`,
    ]),
    ...attachments.flatMap((attachment) => attachment.properties.length === 0 || attachment.scoped ? [] : [
      `  const propertyRef${attachment.name} = React.useRef<Element | null>(null);`,
      `  const previousPropertyElement${attachment.name} = React.useRef<Element | null>(null);`,
      `  const previousPropertyValues${attachment.name} = React.useRef<unknown[] | undefined>(undefined);`,
      `  React.useLayoutEffect(() => {`,
      `    const element = propertyRef${attachment.name}.current;`,
      `    const values: unknown[] = [${attachment.properties.map((property) => property.value).join(", ")}];`,
      `    const previous = previousPropertyValues${attachment.name}.current ?? [];`,
      `    if (element !== null) {`,
      ...(attachment.orderedClasses ? [`      applyClassBindingRef(element, previousPropertyElement${attachment.name}, { ordered: true, bindings: [${attachment.properties.flatMap((property, index) => property.target === undefined ? [] : [`[${property.target === "class" ? quote(property.name) : "null"}, ${property.accepts === undefined ? `values[${index}]` : `(${property.accepts}) ? values[${index}] : Symbol.for("html-next.invalid-result")`}]`]).join(", ")}] });`] : []),
      ...attachment.properties.flatMap((property, index) => attachment.orderedClasses && property.target !== undefined ? [] : [
        `      if ((${property.accepts ?? "true"}) && ${property.target === undefined ? "" : `values[${index}] !== Symbol.for("html-next.invalid-result") && `}${["scrollTop", "scrollLeft"].includes(property.name) ? `previousPropertyValues${attachment.name}.current !== undefined && ` : ""}(element !== previousPropertyElement${attachment.name}.current || !Object.is(values[${index}], previous[${index}]))) ${property.target === "class" ? `element.classList.toggle(${quote(property.name)}, Boolean(values[${index}]));` : property.target === "attribute" ? `values[${index}] == null ? element.removeAttribute("class") : element.setAttribute("class", String(values[${index}]));` : property.namespace === undefined ? `(element as unknown as Record<string, unknown>)[${quote(property.name)}] = values[${index}];` : `applyNamespacedAttributes(element, [${namespacedAttributeSource(property.name, `values[${index}]`)}]);`}`]),
      ...attachment.properties.map((property, index) => `      if ((${property.accepts ?? "true"})${property.target === undefined ? "" : ` && values[${index}] !== Symbol.for("html-next.invalid-result")`}) previous[${index}] = values[${index}];`),
      `    }`,
      `    previousPropertyElement${attachment.name}.current = element;`,
      `    previousPropertyValues${attachment.name}.current = previous;`,
      `  });`,
    ]),
    ...(attachments.length > 0 ? [
      ...(hasNativeBindings ? [
        `  const latestHandlers = React.useRef<Record<string, (event: Event) => void>>({ ${handlers.map((handler) => `${quote(handler.name)}: ${handlerNames.get(handler.name)!}`).join(", ")} });`,
        `  React.useLayoutEffect(() => { latestHandlers.current = { ${handlers.map((handler) => `${quote(handler.name)}: ${handlerNames.get(handler.name)!}`).join(", ")} }; });`,
      ] : []),
      ...attachments.filter((attachment) => !attachment.forwardsOnly).map((attachment) => {
        // An element that only listens takes its ref from the hook, which keeps the latest handlers.
        if (attachment.listensOnly) return `  const ${attachment.name} = useNativeEvents([${attachment.bindings.map((event) =>
          `{ type: ${quote(event.name)}, modifiers: ${JSON.stringify(event.modifiers)}, handler: ${handlerNames.get(event.handler)!} }`).join(", ")}]);`;
        const bindings = attachment.bindings.map((event) =>
          `{ type: ${quote(event.name)}, modifiers: ${JSON.stringify(event.modifiers)}, handler: (event: Event) => latestHandlers.current[${quote(event.handler)}](event) }`);
        const attach = bindings.length === 0 ? "undefined" : `attachNativeEvents(element, [${bindings.join(", ")}])`;
        const control = attachment.control;
        const write = control?.write;
        const setter = write === undefined ? "" : stateSetters.get(write.state)!;
        const assignment = write === undefined || !initializedNames.has(write.state) ? undefined : `${stateOwners.get(write.state)!}.assign`;
        // An emptied control's null reverts the state to its declared value; the update returns what the
        // state took, so the control is not echoed that value.
        const revert = write === undefined ? undefined : bindingRevertSource(definition, write.state, write.path === "[]" ? undefined : "path");
        const written = revert === undefined ? "value" : `(value ?? ${revert})`;
        const update = write === undefined ? "undefined" : write.path === "[]"
          ? `(value) => { const written = ${written}; ${assignment === undefined ? `${setter}(() => written as typeof ${valueNames.get(write.state)!})` : `${assignment}(written as typeof ${valueNames.get(write.state)!})`}; return written; }`
          : stateWritesName === "" ? `(value) => { const path = ${write.dynamic ? "paths?.[0]?.() ?? []" : write.path}; const written = ${written}; ${setter}((previous) => writeBoundPath(previous, path, written)); return written; }`
          : `(value) => { const path = ${write.dynamic ? "paths?.[0]?.() ?? []" : write.path}; const written = ${written}; ${setter}((previous) => writeBoundPath(previous, path, written), path); return written; }`;
        const genericUpdates = attachment.genericWrites.map((generic, index) => {
          const writeSetter = stateSetters.get(generic.state)!;
          const valueName = valueNames.get(generic.state)!;
          const revert = bindingRevertSource(definition, generic.state, generic.path === "[]" ? undefined : "path");
          const written = revert === undefined ? "value" : `(value ?? ${revert})`;
          const source = generic.path === "[]" ? initializedNames.has(generic.state) ? `(value) => ${stateOwners.get(generic.state)!}.assign(${written} as typeof ${valueName})` : `(value) => ${writeSetter}(() => ${written} as typeof ${valueName})`
            : stateWritesName === "" ? `(value) => { const path = ${generic.dynamic ? `paths?.[${index + 1}]?.() ?? []` : generic.path}; ${writeSetter}((previous) => writeBoundPath(previous, path, ${written})); }`
            : `(value) => { const path = ${generic.dynamic ? `paths?.[${index + 1}]?.() ?? []` : generic.path}; ${writeSetter}((previous) => writeBoundPath(previous, path, ${written}), path); }`;
          return `const genericCleanup${index} = attachGenericBinding(element, ${source});`;
        });
        const callback = control === undefined && attachment.genericWrites.length === 0 && !attachment.forward && attachment.properties.length === 0 && attachment.importantStyles.length === 0 && attachment.ref === undefined ? attach : [
          "{",
          ...(attachment.remembersParent ? ["const restoreParent = rememberParent(element);"] : []),
          ...(attachment.forward ? [`rootRef.current = element as ${publicRootType} | null;`] : []),
          ...(attachment.forward && preservesRootFocus ? [
            "if (element !== null && rootFocusPending.current) { (element as HTMLElement).focus({ preventScroll: true }); rootFocusPending.current = false; }",
          ] : []),
          ...(attachment.ref === undefined ? [] : [
            `if (element !== null) { const members = refElements.current.get(${quote(attachment.ref)}) ?? new Set<Element>(); members.add(element); refElements.current.set(${quote(attachment.ref)}, members); }`,
          ]),
          ...(control === undefined || attachment.scoped ? [] : [`controlRef${attachment.name}.current = element;`]),
          ...(attachment.properties.length === 0 || attachment.scoped ? [] : [`propertyRef${attachment.name}.current = element;`]),
          ...attachment.importantStyles.map((style) =>
            `if (element !== null && ((element as HTMLElement).style.getPropertyValue(${quote(style.name)}) !== ${quote(style.value)} || (element as HTMLElement).style.getPropertyPriority(${quote(style.name)}) !== "important")) (element as HTMLElement).style.setProperty(${quote(style.name)}, ${quote(style.value)}, "important");`),
          ...(bindings.length === 0 ? [] : [`const nativeCleanup = ${attach};`]),
          ...(control === undefined ? [] : [`const controlCleanup = attachBoundControl(element, ${quote(control.name)}, ${attachment.scoped ? "scoped?.control" : `controlValue${attachment.name}.current`}, ${control.defaults}, ${update}, ${control.nativeProperty}, ${attachment.scoped ? "scoped?.controlAccepted ?? true" : control.accepts ?? "true"});`]),
          ...genericUpdates,
          `return () => { ${attachment.remembersParent ? "restoreParent(); " : ""}${attachment.forward && preservesRootFocus ? "rootFocusPending.current = element?.ownerDocument.activeElement === element; " : ""}${attachment.forward ? "rootRef.current = null; " : ""}${attachment.ref === undefined ? "" : `refElements.current.get(${quote(attachment.ref)})?.delete(element!); `}${control === undefined ? "" : `${attachment.scoped ? "" : `controlRef${attachment.name}.current = null; `}controlCleanup?.(); `}${attachment.genericWrites.map((_write, index) => `genericCleanup${index}?.();`).join(" ")} ${attachment.properties.length === 0 || attachment.scoped ? "" : `propertyRef${attachment.name}.current = null; `}${bindings.length === 0 ? "" : "nativeCleanup?.();"} };`,
          "}",
        ].join(" ");
        return `  const ${attachment.name} = React.useCallback((element: Element | null, paths?: readonly (((() => readonly (string | number)[]) | undefined))[]${attachment.scoped ? ", scoped?: { readonly control?: unknown; readonly controlAccepted?: boolean }" : ""}) => ${callback}, []);`;
      }),
    ] : []),
    ...(!headed ? [] : [
      ...[...scriptNames].map(([name, variable]) => `  const [${variable}, ${scriptSetters.get(name)!}] = React.useState<ScriptStatus>({ pending: false, ok: false, error: null });`),
      ...(definition.head === undefined ? [] : ["  const headKept = React.useRef<unknown[]>([]).current;", `  const headDepth = useHead(rootRef, ${headEntriesSource(definition, (expression) => {
        const guard = declaredReferenceGuard(expression, scope, definition, undefined, lowering);
        const value = lowering.value(expression.ast, scope);
        return guard === undefined ? value : `((${guard}) ? ${value} : Symbol.for("html-next.invalid-result"))`;
      })});`]),
      ...(definition.scripts === undefined ? [] : [`  const headScripts = useScripts(rootRef, ${headScriptsSource(definition, (name, event) => {
        const handler = handlers.find((candidate) => candidate.name === name)!;
        return `${handlerNames.get(name)!}(${handlerTakesEvent.has(handler) ? event : ""})`;
      }, (name) => ({ read: scriptNames.get(name)!, write: (value) => `${scriptSetters.get(name)!}(${value})` }))});`]),
    ]),
    ...(usesController ? [
      `  useComponentHost(${options.modulePreparation === undefined ? `() => import(${quote((definition.module ?? definition.controller)!)})` : "htmlNextPrepared.load"}, {`,
      ...(options.modulePreparation === undefined ? [] : ["    attach: htmlNextPrepared.attach,"]),
      ...(definition.module === undefined ? [] : ["    module: true,"]),
      `    root: rootRef, definition: ${quote(definition.source.file)}, controller: ${quote(options.controllerSpecifier ?? (definition.module ?? definition.controller)!)},`,
      `    props: () => ${target.props.length === 0 ? "({})" : "acceptedProps.current"},`,
      ...(target.props.length === 0 ? [] : [
        `    propNames: ${JSON.stringify(target.props.map((prop) => prop.name))},`,
        `    inputs: propInputs.committed,`,
        `    propInputs: (name: string) => propInputs.committed.inputValue(name),`,
        `    propValidity: (name: string) => propValidityState({ contract: propValidityContract, values: { ${target.props.map(prop => `${propKey(prop.name)}: propInputs.committed.${propSelectors.includes(prop.name) ? "read" : "inputValue"}(${quote(prop.name)})`).join(", ")}${stateSelectors.map((selector) => `, ${propKey(selector)}: ${stateGetters.get(selector)!}()`).join("")} } }, name),`,
      ]),
      ...(contexts.length === 0 ? [] : [`    contexts: [${[...contextEntries].map(([alias, entry]) => `{ name: ${quote(alias)}, subscribe: ${entry}.subscribe }`).join(", ")}],`]),
      `    state: { ${states.map((state) => `${propKey(state.name)}: { get: ${stateGetters.get(state.name)!}, set: (value: unknown) => { ${state.initializer === undefined ? `${stateSetters.get(state.name)!}(() => value as typeof ${valueNames.get(state.name)!})` : `${stateOwners.get(state.name)!}.assign(value as typeof ${valueNames.get(state.name)!})`}; }, touch: ${state.initializer !== undefined ? `${stateOwners.get(state.name)!}.touch` : stateTouches.has(state.name) ? `() => { ${stateTouches.get(state.name)!}(); ${invalidateStateName}(); }` : invalidateStateName}${state.initializer !== undefined ? `, subscribe: ${stateOwners.get(state.name)!}.subscribe` : stateSubscriptions.has(state.name) ? `, subscribe: ${stateSubscriptions.get(state.name)!}` : ""} }`).join(", ")} },`,
      ...(stateWritesName === "" ? [] : [`    written: () => ${stateWritesName}.current.splice(0),`]),
      `    computed: { ${[
        ...computed.map((value) => `${propKey(value.name)}: () => ${controllerComputedNames.get(value.name)!}.get()`),
        ...lists.map((list) => `${propKey(list.as)}: () => ${listNames.get(list.as)!}`),
        ...contexts.map((value) => `${propKey(value.as ?? value.name)}: () => (${contextEntries.get(value.as ?? value.name)!}.read === undefined ? ${valueNames.get(value.as ?? value.name)!} : ${contextEntries.get(value.as ?? value.name)!}.read!())`),
      ].join(", ")} },`,
      ...(computed.length + initializedStates.length + contexts.length === 0 ? [] : [`    availability: { ${[
        ...computed.map(value => `${propKey(value.name)}: () => ${controllerComputedNames.get(value.name)!}.status()`),
        ...initializedStates.map(value => `${propKey(value.name)}: ${stateOwners.get(value.name)!}.readStatus`),
        ...contexts.map(value => `${propKey(value.as ?? value.name)}: () => ${declarationStatus(value.as ?? value.name, valueNames.get(value.as ?? value.name)!, true)}`),
      ].join(", ")} },`]),
      `    data: { ${data.map((value) => `${propKey(value.name)}: () => ${valueNames.get(value.name)!}`).join(", ")} },`,
      ...(scriptNames.size === 0 ? [] : ["    scripts: headScripts,"]),
      ...(checksControllerWrites ? [`    acceptsState: (name, keys, value) => acceptsControllerWrite(value, controllerStateTypes[name as keyof typeof controllerStateTypes], keys),`] : []),
      ...controllerInitials(definition, "    "),
      `    refs: ${usesRefs ? "refElements.current" : "new Map<string, ReadonlySet<Element>>()"},`,
      ...(iteratedRefs.length === 0 ? [] : [`    iteratedRefs: ${JSON.stringify(iteratedRefs)},`]),
      ...(target.requests.length === 0 ? [] : [
        "    request: requestAsk,",
        `    responders: ${respondersSource(target.requests, (prop) => `props[${quote(prop)}]`, (request) => `props[${quote(request.callbackName)}]`)},`,
      ]),
      `    dispatch: (root: Element, name: string, detail?: unknown) => { switch (name) { ${target.events.map((event) => `case ${quote(event.name)}: return dispatchDeclared(root, name, detail, ${eventSchemas.get(event.name)!}.type, ${eventSchemas.get(event.name)!}.init);`).join(" ")} default: return root.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false })); } },`,
      `  });`,
    ] : []),
    ...(definition.lifecycle === undefined ? [] : [`  useLifecycle(rootRef, ${(["connect", "disconnect"] as const).map((type) => {
      const name = definition.lifecycle![type];
      const handler = handlers.find((candidate) => candidate.name === name);
      // A handler that reads $event gets a connection event, as a controller's host.on callback does.
      return handler === undefined ? "undefined" : `() => ${handlerNames.get(name!)!}(${handlerTakesEvent.has(handler) ? `new Event(${quote(type)})` : ""})`;
    }).join(", ")});`]),
    ...(!sharedPlain ? [] : [`  const htmlNextPlain = usePlainSlots(${!acceptedBy ? "undefined" : `useChildEntry(_htmlNextEntry, ${name}.htmlNextChild, props${providedContexts.size === 0 ? "" : `, (htmlNextContent: ReactNode) => ${provide("<>{htmlNextContent}</>")}`})`}, props, ${JSON.stringify([...retainedPlain])}${lists.length === 0 ? "" : ", htmlNextLists"});`]),
    // Server rendering reads how many head-declaring components enclose each one from this context.
    `  return (${definition.head !== undefined ? `<HeadDepth value={headDepth}>${componentMarkup}</HeadDepth>` : componentMarkup});`,
    "}",
    ...(!childTags.some((tag) => acceptedTags.has(tag)) ? [] : [`${name}.htmlNextChild = { tags: ${JSON.stringify(childTags)}, props: { ${Object.entries(definition.contract.props ?? {})
      .map(([prop, contract]) => `${propKey(prop)}: ${"default" in contract ? JSON.stringify(contract.default) : "null"}`).join(", ")} } };`]),
    ...(usesScopedAttachments ? [
      "",
      "type ScopedPath = (() => readonly (string | number)[]) | undefined;",
      "type ScopedProperty = { readonly name: string; readonly value: unknown; readonly accepted: boolean; readonly namespace?: string; readonly localName?: string; readonly url?: boolean; readonly target?: 'class' | 'attribute' };",
      "type ScopedControl = { readonly name: 'value' | 'checked'; readonly value: unknown; readonly defaults: { readonly value?: string; readonly checked?: boolean; readonly options?: readonly boolean[] }; readonly nativeProperty: boolean; readonly accepted: boolean };",
      "function ScopedAttachment({ attach, paths, properties, control, render }: {",
      "  readonly attach: (element: Element | null, paths?: readonly ScopedPath[], scoped?: { readonly control?: unknown; readonly controlAccepted?: boolean }) => void | (() => void);",
      "  readonly paths?: readonly ScopedPath[]; readonly properties: readonly ScopedProperty[]; readonly control?: ScopedControl;",
      "  readonly render: (ref: (element: Element | null) => void) => ReactNode;",
      "}): ReactNode {",
      "  const element = React.useRef<Element | null>(null);",
      ...(usesScopedPaths ? ["  const currentPaths = React.useRef(paths);"] : []),
      ...(usesScopedControls ? ["  const currentControl = React.useRef(control);"] : []),
      "  const previousValues = React.useRef<unknown[] | undefined>(undefined);",
      "  const previousElement = React.useRef<Element | null>(null);",
      "  const ref = React.useCallback((node: Element | null) => {",
      "    element.current = node;",
      ...(usesScopedPaths ? ["    const stablePaths = currentPaths.current?.map((_, index) => () => currentPaths.current?.[index]?.() ?? []);"] : []),
      ...(usesScopedControls ? ["    const selected = currentControl.current;"] : []),
      `    const cleanup = attach(node${usesScopedPaths ? ", stablePaths" : usesScopedControls ? ", undefined" : ""}${usesScopedControls ? ", { control: selected?.value, controlAccepted: selected?.accepted }" : ""});`,
      "    return () => { element.current = null; cleanup?.(); };",
      "  }, [attach]);",
      "  React.useLayoutEffect(() => {",
      ...(usesScopedPaths ? ["    currentPaths.current = paths;"] : []),
      ...(usesScopedControls ? ["    currentControl.current = control;"] : []),
      "    const node = element.current;",
      "    if (node === null) return;",
      ...(usesScopedControls ? [
        "    if (control !== undefined) syncBoundControl(node, control.name, control.value, control.defaults, control.nativeProperty, control.accepted);",
      ] : []),
      "    const previous = previousValues.current ?? [];",
      "    for (const [index, property] of properties.entries()) {",
      "      if (property.accepted && (property.target === undefined || property.value !== Symbol.for('html-next.invalid-result')) && (!['scrollTop', 'scrollLeft'].includes(property.name) || previousValues.current !== undefined) &&",
      "        (node !== previousElement.current || !Object.is(property.value, previous[index])))",
      "        {",
      "          if (property.target === 'class') node.classList.toggle(property.name, Boolean(property.value));",
      "          else if (property.target === 'attribute') { if (property.value == null) node.removeAttribute('class'); else node.setAttribute('class', String(property.value)); }",
      ...(!attachments.some(attachment => attachment.properties.some(property => property.namespace !== undefined)) ? ["          else"] : [
        "          else if (property.namespace !== undefined) applyNamespacedAttributes(node, [[property.namespace, property.name, property.localName!, property.value, property.url === true]]);",
        "          else",
      ]),
      "          (node as unknown as Record<string, unknown>)[property.name] = property.value;",
      "        }",
      "      if (property.accepted && (property.target === undefined || property.value !== Symbol.for('html-next.invalid-result'))) previous[index] = property.value;",
      "    }",
      "    previousElement.current = node; previousValues.current = previous;",
      "  });",
      "  return render(ref);",
      "}",
    ] : []),
    "",
  ].join("\n");
  // The head helper's exports this component names.
  const headSpecifier = quote(options.headSpecifier ?? "./head");
  const body = !headed ? written : written.replace(HEAD_IMPORTS, [
    `import { ${["HeadDepth", "headAttribute", "headAttributes", "headJson", "headText", "useHead", "useScripts"].filter((name) => new RegExp(`\\b${name}\\b`).test(written)).join(", ")} } from ${headSpecifier};`,
    `import type { ${["DeclaredScript", "HeadEntry", "HeadScript", "ScriptStatus"].filter((name) => new RegExp(`\\b${name}\\b`).test(written)).join(", ")} } from ${headSpecifier};`,
  ].join("\n"));
  // The shared module's helpers this component calls: the expression helpers its lowering used,
  // and the rendering components and functions its markup and handlers name.
  const rendered = [...new Set([...lowering.helpers(), ...REACT_RENDER_COMPONENTS.filter((name) => new RegExp(`\\b${name}\\b`).test(body))])].sort();
  const styledBody = !renderState.usesStyle ? body : body.replace(STYLE_IMPORT,
    `import { ${["styleObject", "styleBinding", "styleText"].filter(helper => new RegExp(`\\b${helper}\\b`).test(body)).join(", ")} } from ${quote(options.styleSpecifier ?? "./style/style.js")};`);
  const component = formatReact(styledBody.replace(`${RENDER_IMPORT}\n`, rendered.length === 0 ? ""
    : `import { ${rendered.join(", ")} } from ${quote(options.renderSpecifier ?? REACT_RENDER_SPECIFIER)};\n`) + "\n" + lowering.referenceDeclarations().join("\n"), `${name}.tsx`);
  return {
    component,
    css: styles.css,
    helpers: [
      ...(renderState.usesStyle ? ["style" as const] : []),
      ...(templateForwardsAttributes(definition.template) || renderState.classOwners.length > 0 || attachments.some(attachment => attachment.properties.some(property => property.namespace !== undefined)) ? ["attributes" as const] : []),
      ...(options.modulePreparation === undefined ? [] : ["bindings" as const]),
      ...(target.props.length === 0 && target.events.length === 0 && !checksControllerWrites && !renderState.usesSlotPropChecks && !renderState.usesHtmlInputs && !renderState.usesInputStatus && computed.length === 0 && initializedStates.length === 0 && contexts.length === 0 && !(usesController && target.requests.length > 0) ? [] : ["props" as const]),
      ...(usesEvents ? ["events" as const] : []),
      ...(usesControls ? ["control" as const] : []),
      ...(data.length === 0 ? [] : ["data" as const]),
      ...(usesHtml ? ["html" as const] : []),
      ...(usesHost ? ["host" as const] : []),
      ...(usesContext ? ["context" as const] : []),
      ...(nestedDepthLimit === undefined ? [] : ["depth" as const]),
      ...(rendered.length === 0 ? [] : ["render" as const]),
      ...(target.requests.length === 0 ? [] : ["requests" as const]),
      ...(headed ? ["head" as const] : []),
    ],
  };
}

export function generateReact(definition: ComponentDefinition, version: string, options: ReactConversionOptions = {}): string {
  return generateReactOutput(definition, version, options).component;
}

/** The tag the writing component stamped on a projected element (`stampProjected`), or none for a page's content. */
function projectedOwner(node: TemplateNode): string {
  const stamp = node.kind === "element" ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "data-slotted") : undefined;
  return stamp?.kind === "literal" ? stamp.value : "";
}
