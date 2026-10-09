/** React output is compiled from the same checked component definition as the browser runtime. */
import { isScriptIdentifier } from "./shared.js";
import { fail } from "../diagnostics.js";
import { compilePath, type ExpressionNode } from "../expression.js";
import { parseDuration } from "../duration.js";
import { componentName, kebabCase } from "../names.js";
import { getDomInterface } from "../platform.js";
import { definitionMayInvokeComponents, elementMatchRoot, rootArms, type ComponentDefinition, type ContextDeclaration, type DataDeclaration, type ElementNode, type EventBinding, type HandlerDeclaration, type ReactiveDeclaration, type SlotContract, type TemplateNode } from "../template.js";
import { REACT_EVENTS_EXPORTS } from "./react-events.js";
import { REACT_RENDER_EXPORTS, REACT_RENDER_SPECIFIER } from "./react-render.js";
import { formatReact } from "./vue-format.js";
import { compileComponentStylesForBuild } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import { targetComponent } from "./backend.js";
import { dependentPropTypeSource, isNativeBooleanAttribute, isVoidElement, propKey, quote, selectorGenerics, typeSource, SSR_BOOLEAN_PROPERTIES, SSR_STRING_PROPERTIES } from "./shared.js";
import { category, Lowering, mayProduceInvalidResult, present, type Scope, type Static, typeOf, typeScript, UNKNOWN } from "./vue-lowering.js";
import { conformingLiteralWrite, declaredReferenceGuard, destinationTypeCheck, handlerDestinationCheck, setSteps, writePredicate } from "./type-guards.js";
import { declarationTypeNode, normalizeType, parseTypeExpression, parseTypedValue } from "../type-system.js";
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
  "props", "nativeAttrs", "children", "slots", "hasMounted", "acceptedProps", "inputAccepted", "checkedProps",
  "propInputValues", "reflectedAttrs", "hostState", "rootRef", "propValidityContract", "propValidityElement",
  "propValidityCleanup", "refElements", "refTarget", "latestHandlers", "nestedDepth", "rootFocusPending",
  "controllerStateTypes", "rerender", "element", "paths", "event", "value", "next", "previous", "update", "scoped", "node",
  "ref", "cleanup", "binding", "attrs", "detail", "name", "keys",
  "checkedProp", "mountPropValidity", "updatePropValidity", "PropBoundary", "propValidityState",
  "selectedPropNode", "acceptsControllerWrite",
  "attachBoundControl", "syncBoundControl", "attachGenericBinding", "writeBoundPath", "useDataRead", "SanitizedHtml",
  "useComponentHost", "componentContext", "NestedDepthContext", "ScopedAttachment",
  ...REACT_RENDER_EXPORTS, ...REACT_EVENTS_EXPORTS,
]);

/** Names a template local (a loop item or `$with` alias) must not shadow inside the markup it scopes. */
const REACT_LOCAL_RESERVED = new Set([...REACT_RENDER_EXPORTS, "dispatchDeclaredTargets", "htmlNextAuthoredCheck",
  "htmlNextAuthoredCheckReported", "Symbol", "Object", "String", "Number", "Array", "Math"]);

/** A generated name the component builds from an index, such as `attachEvents2`, or a private `__` name. */
const GENERATED_NAME = /^(?:__|_|attachEvents\d|controlRef|controlValue|previousProperty|propertyRef|genericCleanup|HtmlNextContext_)/;

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
/** Rendering helpers a component names directly, as opposed to the expression helpers its lowering records. */
const REACT_RENDER_COMPONENTS = ["useLiveState", "acceptsWrite", "isString", "isNumber", "isInteger", "isBoolean", "warnUnless", "RetainedText", "RetainedValue", "OutputValue", "cycleCheckedComputed", "KeyedBoundary",
  "hostStateTokens", "renderPlainSlot", "renderScopedSlot", "markProjected", "writeStatePath"] as const;

export interface ReactConversionOptions {
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  readonly propsByTag?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly propContractsByTag?: ReadonlyMap<string, Readonly<Record<string, PropContract>>>;
  readonly importSpecifier?: (tag: string) => string;
  readonly stylesheetSpecifier?: string;
  readonly propsSpecifier?: string;
  readonly eventsSpecifier?: string;
  readonly controlSpecifier?: string;
  readonly dataSpecifier?: string;
  readonly htmlSpecifier?: string;
  readonly hostSpecifier?: string;
  readonly contextSpecifier?: string;
  readonly depthSpecifier?: string;
  readonly renderSpecifier?: string;
  readonly guardNestedDepth?: boolean;
  readonly controllerSpecifier?: string;
}

export interface ReactConversionOutput {
  readonly component: string;
  readonly css: string;
  readonly helpers: readonly ("props" | "events" | "control" | "data" | "html" | "host" | "context" | "depth" | "render")[];
}

interface RootAttributes {
  readonly tag: string;
  readonly reflections: readonly string[];
  readonly captureRoot: boolean;
  readonly hostState: boolean;
}

interface EventAttachment {
  readonly name: string;
  /** Only native listeners: the element's ref is \`useNativeEvents\`'s callback. */
  readonly listensOnly: boolean;
  /** The root's ref alone: it is \`rootRef\` itself. */
  readonly forwardsOnly: boolean;
  readonly scoped: boolean;
  readonly bindings: readonly EventBinding[];
  readonly forward: boolean;
  readonly ref?: string;
  readonly properties: readonly { readonly name: string; readonly value: string; readonly accepts?: string }[];
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
  readonly definition: ComponentDefinition;
  readonly slotsByTag: ReadonlyMap<string, readonly SlotContract[]> | undefined;
  readonly propsByTag: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  readonly propContractsByTag: ReadonlyMap<string, Readonly<Record<string, PropContract>>> | undefined;
  nextSlotAlias: number;
  nextRetainedAlias: number;
  usesHtml: boolean;
  usesPlainSlots: boolean;
  usesScopedSlots: boolean;
  usesKeyedLists: boolean;
  usesRetainedText: boolean;
  usesRetainedValue: boolean;
  usesOutputValue: boolean;
  /** A free name in the component's scope, for an element's event hook. */
  readonly allocate: (base: string) => string;
  /** Inside <pre> or <textarea>, whose text is kept exactly, as Vue keeps it. */
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
  contenteditable: "contentEditable", colspan: "colSpan", rowspan: "rowSpan",
};

const REACT_NUMERIC_ATTRIBUTES = new Set(["tabindex", "colspan", "rowspan", "maxlength", "minlength", "size", "rows", "cols", "span", "start",
  "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-level", "aria-posinset", "aria-setsize"]);

/** Keep JavaScript lookup semantics while allowing HTML Next's absent keys in strict TSX. */
class ReactLowering extends Lowering {
  override value(node: ExpressionNode, scope: Scope): string {
    if (node.kind !== "index") return super.value(node, scope);
    const object = this.value(node.object, scope);
    const typed = typeOf(node.object, scope);
    const target = typed.type.kind === "object" ? `(${object} as Record<string, any>)` : `(${object})`;
    const index = this.value(node.index, scope);
    if (mayProduceInvalidResult(node.object, scope) || mayProduceInvalidResult(node.index, scope)) {
      return `((objectValue: any, indexValue: any) => objectValue === Symbol.for("html-next.invalid-result") || indexValue === Symbol.for("html-next.invalid-result") ? Symbol.for("html-next.invalid-result") : objectValue${typed.nullable ? "?." : ""}[indexValue])(${object}, ${index})`;
    }
    return `${target}${typed.nullable ? "?." : ""}[${index} as any]`;
  }
}

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
  return Object.hasOwn(REACT_ATTRIBUTES, name) ? REACT_ATTRIBUTES[name]! : name;
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

function localScope(scope: RenderScope, names: readonly (readonly [string, Static, (string | undefined)?])[]): RenderScope {
  const code = new Map(scope.code);
  const types = new Map(scope.types);
  for (const [name, type, alias] of names) {
    code.set(name, alias ?? name);
    types.set(name, type);
  }
  return { code, types, local: true };
}

function localIdentifier(name: string, scope: RenderScope, state: RenderState): string {
  if (isScriptIdentifier(name) && !REACT_LOCAL_RESERVED.has(name)) return name;
  let alias: string;
  do alias = `__htmlNextLocal${state.nextRetainedAlias++}`;
  while ([...scope.code.values()].includes(alias) || scope.code.has(alias));
  return alias;
}

function renderNode(node: TemplateNode, scope: RenderScope, lowering: Lowering, imports: Set<string>, handlers: ReadonlySet<string>, attachments: EventAttachment[], state: RenderState, rootTag?: RootAttributes, projected = false, inSvg = false): string {
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
      return `<RetainedText value={${lowering.value(plan.ast, scope)}} text={${text}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} />`;
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
      const value = lowering.value(flow.expressionPlan.ast, scope);
      const alias = localIdentifier(flow.alias, scope, state);
      const scoped = localScope(scope, [[flow.alias, typeOf(flow.expressionPlan.ast, scope), alias]]);
      const content = renderNode(body, scoped, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg);
      if (!mayProduceInvalidResult(flow.expressionPlan.ast, scope)) return `{(() => { const ${alias} = ${value}; return (${content}); })()}`;
      state.usesRetainedValue = true;
      return `<RetainedValue value={${value}} accepts={() => true} render={(${alias}, hasValue) => hasValue ? (${content}) : null} />`;
    }
    if (flow.kind === "each") {
      if (flow.listPlan === undefined) fail("HT030", `Uncompiled list ${flow.list}.`);
      const item = localIdentifier(flow.item, scope, state);
      const index = localIdentifier(flow.index ?? "index", scope, state);
      const itemType = typeOf(flow.listPlan.ast, scope).type;
      const scoped = localScope(scope, [
        [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN, item],
        [flow.index ?? "index", { type: { kind: "terminal", name: "number" }, nullable: false }, index],
        ["loop", { type: { kind: "object", open: false, fields: [
          { name: "index", type: { kind: "terminal", name: "number" }, optional: false },
          { name: "first", type: { kind: "terminal", name: "boolean" }, optional: false },
          { name: "last", type: { kind: "terminal", name: "boolean" }, optional: false },
          { name: "count", type: { kind: "terminal", name: "number" }, optional: false },
        ] }, nullable: false }],
      ]);
      const retainedList = mayProduceInvalidResult(flow.listPlan.ast, scope);
      const listAlias = retainedList ? `__retained${state.nextRetainedAlias++}` : undefined;
      const listScope = listAlias === undefined ? scope : localScope(scope, [[listAlias, typeOf(flow.listPlan.ast, scope)]]);
      const list = lowering.list(listAlias === undefined ? flow.listPlan.ast : { kind: "id", name: listAlias }, listScope, item, {
        ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
        itemScope: scoped,
        sort: (flow.sortKeys ?? []).map(({ path, descending }) => `${descending ? "-" : ""}${path.join(".")}`),
        ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
      });
      const key = flow.keyPlan === undefined ? index : lowering.value(flow.keyPlan.ast, scoped);
      const child = renderNode(body, scoped, lowering, imports, handlers, attachments, state, undefined, projected, inSvg);
      const checked = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list, `(${item}, ${index}, loop) => ${key}`);
      const rows = lowering.eachRows(checked);
      const renderRows = `${rows}.map(({ item: ${item}, index: ${index}, loop }) => <React.Fragment key={${key}}>${child}</React.Fragment>)`;
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
        flow.expressionPlan === undefined ? UNKNOWN : typeOf(flow.expressionPlan.ast, scope), alias]]);
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
          selected = `selected === ${index} ? (${renderNode(body, scoped, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg)}) : (${selected})`;
        }
        const markup = `<RetainedValue value={${choice}} render={(selected) => ${selected}} />`;
        return withAlias(markup);
      }
      let expression = "null";
      for (const arm of arms.toReversed()) {
        const { flow: choice, ...choiceBody } = arm;
        if (choice?.kind === "else") expression = `(${renderNode(choiceBody, scoped, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg)})`;
        else if (choice?.kind === "when" && choice.testPlan !== undefined) {
          expression = `${lowering.condition(choice.testPlan.ast, scoped)} ? (${renderNode(choiceBody, scoped, lowering, imports, handlers, attachments, state, rootTag, projected, inSvg)}) : (${expression})`;
        } else fail("HT030", "React conversion of an invalid $match arm is not implemented.");
      }
      if (flow.alias === undefined) return `{${expression}}`;
      return withAlias(`<>{${expression}}</>`);
    }
    fail("HT030", `React conversion of $${flow.kind} is not implemented.`);
  }
  if (node.kind === "slot") {
    const name = node.nameExpression === undefined ? quote(node.name ?? "")
      : `String(${lowering.value(node.nameExpression.ast, scope)})`;
    const supplied = node.name === undefined && node.nameExpression === undefined ? "props.children" : `props.slots?.[${name}]`;
    const fallback = (node.fallback ?? []).map((child) => renderNode(child, scope, lowering, imports, handlers, attachments, state, undefined, false, inSvg)).join("");
    if ((node.props?.length ?? 0) > 0) {
      state.usesScopedSlots = true;
      const values = node.props!.map((prop) => `${quote(prop.name)}: ${lowering.value(prop.expressionPlan.ast, scope)}`).join(", ");
      return `{renderScopedSlot(${supplied}, { ${values} }, ${name}, <>${fallback}</>)}`;
    }
    state.usesPlainSlots = true;
    return `{renderPlainSlot(${supplied}, <>${fallback}</>)}`;
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
        return `<><RetainedText value={${lowering.value(value.expressionPlan.ast, scope)}} text={${nullableText(lowering.text(value.expressionPlan.ast, scope), lowering)}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} /></>`;
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
  const tag = outputValue ? "OutputValue" : component ? componentName(node.name) : node.name;
  const svg = !component && (inSvg || node.name === "svg");
  if (component) imports.add(node.name);
  const componentContracts = component ? state.propContractsByTag?.get(node.name) : undefined;
  const findComponentPropName = (attributeName: string): string | undefined => componentContracts === undefined ? undefined
    : Object.keys(componentContracts).find((name) => name.toLowerCase() === attributeName || kebabCase(name) === attributeName);
  const boundPropAliases = new Map<string, string>();
  if (componentContracts !== undefined) for (const attribute of node.attributes) {
    if (attribute.kind !== "attribute" || attribute.target !== undefined || attribute.twoWay) continue;
    const name = findComponentPropName(attribute.name);
    if (name !== undefined) boundPropAliases.set(name, `__retained${state.nextRetainedAlias++}`);
  }
  const literals: string[] = [];
  const bindings: string[] = [];
  const retainedBindings: Array<{ readonly alias: string; readonly value: string; readonly accepts?: string; readonly propName?: string }> = [];
  const classes: string[] = [];
  const literalStyles: string[] = [];
  const reactiveStyles: string[] = [];
  const importantStyles: Array<{ readonly name: string; readonly value: string }> = [];
  const properties: Array<{ readonly name: string; readonly value: string; readonly accepts?: string }> = [];
  const genericWrites: Array<{ readonly state: string; readonly path: string; readonly dynamic: boolean }> = [];
  let scopedAttachment: { readonly attachment: EventAttachment; readonly ref: string; readonly paths: readonly string[] } | undefined;
  const controlledNames = new Set(node.attributes.filter((attribute) =>
    attribute.kind === "attribute" && attribute.twoWay === true ||
    attribute.kind === "property" && ["input", "textarea", "select"].includes(node.name) && ["value", "checked"].includes(attribute.name)
  ).map((attribute) => attribute.name));
  let control: EventAttachment["control"];
  let content: string | undefined;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      const componentProp = component ? Object.entries(componentContracts ?? {})
        .find(([name]) => name.toLowerCase() === attribute.name || kebabCase(name) === attribute.name) : undefined;
      if (projected && attribute.name === "data-slotted") continue;
      if (attribute.name === "class") classes.push(quote(attribute.value));
      else if (attribute.name === "style") literalStyles.push(...literalStyle(attribute.value, importantStyles));
      else if (controlledNames.has(attribute.name)) continue;
      else if (componentProp !== undefined) {
        const [name, contract] = componentProp;
        const parsed = parseTypedValue(attribute.value, contract.type, "$", "html");
        const accepted = parsed.ok && (contract.values === undefined || contract.values.includes(parsed.value as string | number | boolean));
        literals.push(`${propKey(name)}={${accepted ? JSON.stringify(parsed.value) : `${quote(attribute.value)} as any`}}`);
      }
      else if (!component && isNativeBooleanAttribute(attribute.name)) literals.push(`${node.name === "input" && attribute.name === "checked" ? "defaultChecked" : reactAttribute(attribute.name, svg)}={true}`);
      else if (!component && ["input", "textarea", "select"].includes(node.name) && attribute.name === "value") literals.push(`defaultValue=${quote(attribute.value)}`);
      else literals.push(REACT_NUMERIC_ATTRIBUTES.has(attribute.name) && !component
        ? `${reactAttribute(attribute.name, svg)}={${quote(attribute.value)} as any}`
        : `${reactAttribute(attribute.name, svg)}=${quote(attribute.value)}`);
    } else if (attribute.kind === "attribute" && attribute.target === "class") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled binding ${attribute.expression}.`);
      const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (guard === undefined && !mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) classes.push(`${lowering.condition(attribute.expressionPlan.ast, scope)} ? ${quote(attribute.name)} : ""`);
      else {
        const alias = `__retained${state.nextRetainedAlias++}`;
        state.usesRetainedValue = true;
        retainedBindings.push({ alias, value: lowering.condition(attribute.expressionPlan.ast, scope), ...(guard === undefined ? {} : { accepts: `() => ${guard}` }) });
        classes.push(`${alias} ? ${quote(attribute.name)} : ""`);
      }
    } else if (attribute.kind === "attribute" && attribute.target === "style") {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled binding ${attribute.expression}.`);
      const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (guard === undefined && !mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) reactiveStyles.push(`${quote(reactStyleProperty(attribute.name))}: String(${lowering.text(attribute.expressionPlan.ast, scope)})`);
      else {
        const alias = `__retained${state.nextRetainedAlias++}`;
        state.usesRetainedValue = true;
        retainedBindings.push({ alias, value: lowering.value(attribute.expressionPlan.ast, scope), ...(guard === undefined ? {} : { accepts: `() => ${guard}` }) });
        const aliasScope = localScope(scope, [[alias, typeOf(attribute.expressionPlan.ast, scope)]]);
        reactiveStyles.push(`${quote(reactStyleProperty(attribute.name))}: ${alias} == null ? undefined : String(${lowering.text({ kind: "id", name: alias }, aliasScope)})`);
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
        bindings.push(`${name === "checked" ? "defaultChecked" : "defaultValue"}={hasMounted.current ? ${authored} : ${initial}}`);
      } else {
        genericWrites.push({ state: attribute.writablePath[0], path: pathSource, dynamic });
        bindings.push(`{...{ ${quote(attribute.name)}: ${lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name)} }}`);
      }
    } else if (attribute.kind === "attribute" && attribute.twoWay !== true && attribute.target === undefined) {
      if (attribute.expressionPlan === undefined) fail("HT030", `Uncompiled binding ${attribute.expression}.`);
      const componentPropName = component ? [...state.propsByTag?.get(node.name) ?? []]
        .find((name) => name.toLowerCase() === attribute.name || kebabCase(name) === attribute.name) : undefined;
      const componentPropContract = componentPropName === undefined ? undefined : componentContracts?.[componentPropName];
      const value = component && (componentPropName !== undefined || state.propsByTag?.get(node.name) === undefined)
        ? lowering.value(attribute.expressionPlan.ast, scope)
        : lowering.attribute(attribute.expressionPlan.ast, scope, attribute.name);
      const nativeValue = !component && typeOf(attribute.expressionPlan.ast, scope).nullable ? `(${value}) ?? undefined` : value;
      const sourceGuard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
      if (node.name === "input" && attribute.name === "value") bindings.push(`defaultValue={${nativeValue}}`);
      else if (node.name === "input" && attribute.name === "checked") bindings.push(`defaultChecked={Boolean(${lowering.value(attribute.expressionPlan.ast, scope)})}`);
      else if (componentPropContract !== undefined) {
        const alias = boundPropAliases.get(componentPropName!)!;
        state.usesRetainedValue = true;
        const select = componentPropContract.select;
        const selectorContract = select === undefined ? undefined : componentContracts?.[select.from];
        const selectorLiteral = select === undefined ? undefined : node.attributes.find((entry) =>
          entry.kind === "literal" && findComponentPropName(entry.name) === select.from);
        const selectorValue = select === undefined ? undefined : boundPropAliases.get(select.from)
          ?? (selectorLiteral?.kind === "literal" ? (() => {
            const parsed = selectorContract === undefined ? undefined
              : parseTypedValue(selectorLiteral.value, selectorContract.type, "$", "html");
            return JSON.stringify(parsed?.ok ? parsed.value : selectorLiteral.value);
          })() : selectorContract !== undefined && "default" in selectorContract ? JSON.stringify(selectorContract.default) : "undefined");
        const typeCheck = select === undefined || selectorContract === undefined
          ? destinationTypeCheck(normalizeType(componentPropContract.type), "candidate")
          : `(${select.options.map((option) => `(${selectorValue} === ${JSON.stringify(option.value)} && ${destinationTypeCheck(option.type, "candidate")})`).join(" || ")})`;
        retainedBindings.push({ alias, value,
          accepts: `(candidate) => ${sourceGuard === undefined ? "" : `(${sourceGuard}) && `}(candidate === undefined || ${typeCheck})`,
          propName: componentPropName! });
        bindings.push(`${componentPropName}={${alias}}`);
      }
      else if (!component && (sourceGuard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope))) {
        const alias = `__retained${state.nextRetainedAlias++}`;
        state.usesRetainedValue = true;
        retainedBindings.push({ alias, value: lowering.value(attribute.expressionPlan.ast, scope),
          ...(sourceGuard === undefined ? {} : { accepts: `() => ${sourceGuard}` }) });
        const aliasScope = localScope(scope, [[alias, typeOf(attribute.expressionPlan.ast, scope)]]);
        const rendered = lowering.attribute({ kind: "id", name: alias }, aliasScope, attribute.name);
        bindings.push(`${reactAttribute(attribute.name, svg)}={${typeOf(attribute.expressionPlan.ast, scope).nullable ? `(${rendered}) ?? undefined` : rendered}}`);
      } else bindings.push(`${componentPropName ?? reactAttribute(attribute.name, svg)}={${REACT_NUMERIC_ATTRIBUTES.has(attribute.name) && !component ? `(${value}) as any` : nativeValue}}`);
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
        bindings.push(`${name === "checked" ? "defaultChecked" : "defaultValue"}={hasMounted.current ? ${authored} : ${initial}}`);
      } else if (attribute.name === "textContent") {
        const guard = declaredReferenceGuard(attribute.expressionPlan, scope, state.definition, undefined, lowering);
        if (guard !== undefined || mayProduceInvalidResult(attribute.expressionPlan.ast, scope)) {
          state.usesRetainedText = true;
          content = `<RetainedText value={${value}} text={${nullableText(lowering.text(attribute.expressionPlan.ast, scope), lowering)}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} />`;
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
      const defined = attribute.expressionPlan.ast.kind === "array" || attribute.expressionPlan.ast.kind === "object"
        ? undefined : `(${raw}) !== undefined`;
      const accepts = [defined, guard === undefined ? undefined : `(${guard})`].filter(Boolean).join(" && ");
      if (outputValue) {
        // Each output owns its synchronization, including outputs rendered inside $each.
        state.usesOutputValue = true;
        bindings.push(`htmlNextValue={${raw}}`, `htmlNextText={${text}}`, `htmlNextRetain={${retained}}`);
        if (accepts !== "") bindings.push(`htmlNextAccepts={${accepts}}`);
      } else if (retained) {
        state.usesRetainedText = true;
        content = `<RetainedText value={${raw}} text={${text}}${guard === undefined ? "" : ` accepts={() => ${guard}}`} />`;
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
  }
  let componentChildren = node.children;
  if (component) {
    const slots = new Map<string, TemplateNode[]>();
    const defaults: TemplateNode[] = [];
    for (const child of node.children) {
      if (child.kind !== "element") { defaults.push(child); continue; }
      const assigned = child.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "slot");
      if (assigned?.kind !== "literal") { defaults.push(child); continue; }
      const group = slots.get(assigned.value) ?? [];
      group.push(child);
      slots.set(assigned.value, group);
    }
    componentChildren = defaults;
    if (slots.size > 0) bindings.push(`slots={{ ${[...slots].map(([name, children]) => {
      const contracts = state.slotsByTag?.get(node.name);
      const contract = contracts?.find((slot) => !slot.dynamic && slot.name === name)
        ?? contracts?.find((slot) => slot.dynamic && (slot.props?.length ?? 0) > 0);
      if ((contract?.props?.length ?? 0) > 0) {
        const alias = `__slotProps${state.nextSlotAlias++}`;
        const projectedScope: RenderScope = {
          code: new Map([...scope.code, ...contract!.props!.map((prop) => [prop, `${alias}[${quote(prop)}]`] as const)]),
          types: new Map([...scope.types, ...contract!.props!.map((prop) => [prop, UNKNOWN] as const)]),
          local: true,
        };
        const carrier = children.find((child): child is ElementNode => child.kind === "element" && child.name === "template");
        if (carrier !== undefined) return `${quote(name)}: (${alias}: Record<string, any>) => <>${carrier.children.map((child) => renderNode(child, projectedScope, lowering, imports, handlers, attachments, state, undefined, true, inSvg)).join("")}</>`;
      }
      return `${quote(name)}: ${children.length === 0 ? "undefined" : `<>${children.map((child) => renderNode(child, scope, lowering, imports, handlers, attachments, state, undefined, true, inSvg)).join("")}</>`}`;
    }).join(", ")} }}`);
  }
  if (classes.length > 0) bindings.push(`className={[${classes.join(", ")}${rootTag === undefined ? "" : ", nativeAttrs.className"}].filter(Boolean).join(" ")}`);
  if (literalStyles.length > 0 || reactiveStyles.length > 0) bindings.push(`style={{ ${[
    ...literalStyles,
    ...(rootTag === undefined ? [] : ["...nativeAttrs.style"]),
    ...reactiveStyles,
  ].join(", ")} } as unknown as React.CSSProperties}`);
  if ((node.events?.length ?? 0) > 0 || rootTag?.captureRoot === true || control !== undefined || genericWrites.length > 0 || properties.length > 0 || importantStyles.length > 0 || node.ref !== undefined) {
    for (const event of node.events ?? []) if (!handlers.has(event.handler)) fail("HT033", `Handler \`${event.handler}\` is not declared.`);
    const scoped = scope.local === true && (control !== undefined || properties.length > 0);
    const listensOnly = (node.events?.length ?? 0) > 0 && rootTag === undefined && control === undefined && genericWrites.length === 0
      && properties.length === 0 && importantStyles.length === 0 && node.ref === undefined;
    const forwardsOnly = rootTag !== undefined && !component && (node.events?.length ?? 0) === 0 && control === undefined && genericWrites.length === 0
      && properties.length === 0 && importantStyles.length === 0 && node.ref === undefined && rootArms(state.definition.template) === undefined;
    const name = forwardsOnly ? "rootRef" : listensOnly ? state.allocate(`${identifierFor(node.events![0]!.handler)}Events`) : `attachEvents${attachments.length}`;
    const attachment: EventAttachment = { name, listensOnly, forwardsOnly, scoped, bindings: node.events ?? [], forward: rootTag !== undefined, properties, genericWrites, importantStyles,
      ...(node.ref === undefined ? {} : { ref: node.ref }), ...(control === undefined ? {} : { control }) };
    attachments.push(attachment);
    const dynamicPaths = [control?.write, ...genericWrites].map((write) => write?.dynamic === true
      ? `() => ${write.path} as unknown as readonly (string | number)[]` : "undefined");
    if (scoped) {
      const ref = `__htmlNextScopedRef${attachments.length - 1}`;
      scopedAttachment = { attachment, ref, paths: dynamicPaths };
      bindings.push(`ref={${ref}}`);
    } else bindings.push(dynamicPaths.some((path) => path !== "undefined")
      ? `ref={(element) => ${name}(element, [${dynamicPaths.join(", ")}])}`
      : `ref={${name}}`);
  }
  const preformatted = state.preformatted;
  if (node.name === "pre" || node.name === "textarea") state.preformatted = true;
  const children = outputValue || node.name === "textarea" && control?.name === "value" ? ""
    : content ?? componentChildren.map((child) => renderNode(node.name === "select" && control?.name === "value" ? withoutAuthoredSelection(child) : child,
      scope, lowering, imports, handlers, attachments, state, undefined, component, svg && node.name !== "foreignObject")).join("");
  state.preformatted = preformatted;
  const boundReflections = rootTag === undefined ? [] : Object.keys(state.definition.contract.props).flatMap((name) => {
    const attributeName = `data-${kebabCase(name)}`;
    if (!node.attributes.some((attribute) => attribute.kind === "attribute" && attribute.name === attributeName)) return [];
    const value = `checkedProps[${quote(name)}]`;
    const serialized = `typeof ${value} === "object" ? JSON.stringify(${value}) : String(${value})`;
    return [`${quote(attributeName)}: ${value} == null ? undefined : (${serialized})`];
  });
  const reflections = boundReflections.length === 0 ? rootTag?.reflections ?? []
    : [`{...(Object.assign({}, reflectedAttrs, { ${boundReflections.join(", ")} }) as Record<string, unknown>)}`];
  const attributes = [...literals, ...(rootTag === undefined ? [] : ["{...nativeAttrs}"]), ...bindings, ...(projected ? ['data-slotted=""'] : []),
    ...reflections, ...(rootTag === undefined ? [] : [
      ...(rootTag.hostState ? [`${stateAttribute(rootTag.tag)}={hostState}`] : []),
      `data-component={[nativeAttrs["data-component"], ${quote(rootTag.tag)}].filter(Boolean).join(" ")}`,
    ])];
  const opening = `<${tag}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}`;
  const markup = component && children === "" || !component && isVoidElement(node.name)
    ? `${opening} />` : `${opening}>${children}</${tag}>`;
  const selectorNames = new Set(Object.values(componentContracts ?? {}).flatMap((contract) => contract.select === undefined ? [] : [contract.select.from]));
  const scopedMarkup = scopedAttachment === undefined ? markup : `<ScopedAttachment attach={${scopedAttachment.attachment.name}} paths={[${scopedAttachment.paths.join(", ")}]} properties={[${scopedAttachment.attachment.properties.map((property) =>
    `{ name: ${quote(property.name)}, value: ${property.value}, accepted: ${property.accepts ?? "true"} }`).join(", ")}]}${scopedAttachment.attachment.control === undefined ? "" :
    ` control={{ name: ${quote(scopedAttachment.attachment.control.name)}, value: ${scopedAttachment.attachment.control.value}, defaults: ${scopedAttachment.attachment.control.defaults}, nativeProperty: ${scopedAttachment.attachment.control.nativeProperty}, accepted: ${scopedAttachment.attachment.control.accepts ?? "true"} }}`} render={(${scopedAttachment.ref}) => ${markup}} />`;
  return retainedBindings.toSorted((a, b) => Number(selectorNames.has(b.propName ?? "")) - Number(selectorNames.has(a.propName ?? ""))).reduceRight((result, retained) =>
    `<RetainedValue value={${retained.value}}${retained.accepts === undefined ? "" : ` accepts={${retained.accepts}}`} render={(${retained.alias}) => ${result}} />`, scopedMarkup);
}

/** React component source and its feature-specific companion artifacts. */
export function generateReactOutput(definition: ComponentDefinition, version: string, options: ReactConversionOptions = {}): ReactConversionOutput {
  const target = targetComponent(definition);
  const usesController = definition.controller !== undefined;
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const data = declarations.filter((declaration): declaration is DataDeclaration => declaration.kind === "data");
  const computed = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const usesTargetDispatch = handlers.some((handler) => handler.steps.some((step) => step.kind === "dispatch" && step.target !== undefined));
  const contexts = declarations.filter((declaration): declaration is ContextDeclaration => declaration.kind === "context");
  const providedContexts = new Set(states.map((state) => state.name));
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
  const stateSetters = new Map(states.map((state) => [state.name, allocate(`set${pascal(valueNames.get(state.name)!)}`)] as const));
  const stateGetters = new Map(states.map((state) => [state.name, allocate(`get${pascal(valueNames.get(state.name)!)}`)] as const));
  const invalidateStateName = usesController && states.length > 0 ? allocate("rerender") : "";
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
  const lowering = new ReactLowering("warnUnless");
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
    code.set(state.name, valueNames.get(state.name)!);
    types.set(state.name, { ...declared, nullable: declared.nullable || state.expression === undefined });
    stateTypes.set(state.name, state.expression === undefined && declaredType !== undefined
      ? `${typeScript(present(declaredType))} | undefined`
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
  for (const context of contexts) {
    const alias = context.as ?? context.name;
    code.set(alias, valueNames.get(alias)!);
    types.set(alias, UNKNOWN);
  }
  // A fresh render recreates these lazy cells. Forward references stay valid, and a cyclic read
  // reaches the diagnostic guard instead of failing while the generated declarations initialize.
  for (const value of computed) {
    code.set(value.name, `${valueNames.get(value.name)!}.get()`);
    const inferred = value.expression === undefined ? UNKNOWN : typeOf(value.expression.ast, { code, types });
    types.set(value.name, value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, { code, types })
      ? { ...inferred, nullable: true } : inferred);
  }
  const imports = new Set<string>();
  const attachments: EventAttachment[] = [];
  const root: ElementNode = template;
  const scope = { code, types };
  const reflections = target.props.length === 0 ? [] : ["{...reflectedAttrs}"];
  const styles = compileComponentStylesForBuild(definition.css, definition);
  const renderState: RenderState = { definition, slotsByTag: options.slotsByTag, propsByTag: options.propsByTag, propContractsByTag: options.propContractsByTag,
    nextSlotAlias: 0, nextRetainedAlias: 0, preformatted: false, usesHtml: false, usesPlainSlots: false, usesScopedSlots: false, usesKeyedLists: false,
    usesRetainedText: false, usesRetainedValue: false, usesOutputValue: false, allocate };
  const markup = renderNode(root, scope, lowering, imports, new Set(handlers.map((handler) => handler.name)), attachments, renderState,
    { tag: definition.contract.tag, reflections, captureRoot: true, hostState: styles.stateNames.length > 0 });
  const usesEvents = attachments.some((attachment) => attachment.bindings.length > 0) || target.events.length > 0;
  const hasNativeBindings = attachments.some((attachment) => attachment.bindings.length > 0 && !attachment.listensOnly);
  const usesEventHooks = attachments.some((attachment) => attachment.listensOnly);
  const usesControls = attachments.some((attachment) => attachment.control !== undefined || attachment.genericWrites.length > 0);
  const usesNativeControls = attachments.some((attachment) => attachment.control !== undefined);
  const usesScopedAttachments = attachments.some((attachment) => attachment.scoped);
  const usesGenericBindings = attachments.some((attachment) => attachment.genericWrites.length > 0);
  const usesNestedControlWrites = attachments.some((attachment) =>
    attachment.control?.write?.path !== undefined && attachment.control.write.path !== "[]" ||
    attachment.genericWrites.some((write) => write.path !== "[]"));
  const usesHtml = renderState.usesHtml;
  const capturesRoot = attachments.some((attachment) => attachment.forward);
  const usesRefActions = handlers.some((handler) => handler.steps.some((step) => step.kind === "focus" || step.kind === "validate"));
  const usesRefs = usesTargetDispatch || usesRefActions || attachments.some((attachment) => attachment.ref !== undefined);
  const rootType = rootArms(template) === undefined ? getDomInterface(template.name) ?? "HTMLElement"
    : [...new Set(rootArms(template)!.map((arm) => getDomInterface(arm.name) ?? "HTMLElement"))].join(" | ");
  const preservesRootFocus = rootArms(template) !== undefined;
  const publicRootType = rootType;
  const generics = selectorGenerics(definition.contract.props);
  const genericDeclaration = generics.length === 0 ? "" : `<${generics.map((generic) => generic.declaration).join(", ")}>`;
  const genericArguments = generics.length === 0 ? "" : `<${generics.map((generic) => generic.parameter).join(", ")}>`;
  const selectorParameters = new Map(generics.map((generic) => [generic.from, generic.parameter]));
  const props = target.props.map((prop) => `  ${propKey(prop.name)}${prop.contract.required ? "" : "?"}: ${selectorParameters.get(prop.name) ?? dependentPropTypeSource(prop.contract, selectorParameters)};`);
  const selectedType = (prop: (typeof target.props)[number]): string => {
    const select = prop.contract.select;
    if (select === undefined) return JSON.stringify(normalizeType(prop.contract.type));
    const selector = definition.contract.props[select.from];
    const value = selector === undefined ? "undefined"
      : `props[${quote(select.from)}]${"default" in selector ? ` ?? ${JSON.stringify(selector.default)}` : ""}`;
    return `selectedPropNode(${value}, ${JSON.stringify(select.options)})`;
  };
  const stateSelectedProps = target.props.filter((prop) => prop.contract.select !== undefined &&
    definition.contract.props[prop.contract.select.from] === undefined);
  const propSelectors = [...new Set(target.props.flatMap((prop) => prop.contract.select !== undefined &&
    definition.contract.props[prop.contract.select.from] !== undefined ? [prop.contract.select.from] : []))];
  const stateSelectors = [...new Set(stateSelectedProps.map((prop) => prop.contract.select!.from))];
  const validityType = (prop: PropContract) => prop.select === undefined ? normalizeType(prop.type)
    : { kind: "union" as const, members: prop.select.options.map((option) => option.type) };
  const namedSlots = (definition.slots ?? []).filter((slot) => !slot.dynamic && slot.name !== undefined);
  const dynamicSlots = (definition.slots ?? []).some((slot) => slot.dynamic);
  const slotValueType = (slot: SlotContract): string => (slot.props?.length ?? 0) === 0
    ? "ReactNode"
    : `(props: Readonly<{ ${slot.props!.map((prop) => `${propKey(prop)}: any;`).join(" ")} }>) => ReactNode`;
  const slotsType = namedSlots.length === 0 && !dynamicSlots
    ? "Readonly<Record<string, ReactNode | ((props: Record<string, any>) => ReactNode)>>"
    : `Readonly<{ ${namedSlots.map((slot) => `${propKey(slot.name!)}?: ${slotValueType(slot)};`).join(" ")}${dynamicSlots ? " [name: string]: ReactNode | ((props: Record<string, any>) => ReactNode);" : ""} }>`;
  const rootMarkup = markup.startsWith("{") ? `<>${markup}</>` : markup;
  const contextMarkup = states.reduceRight((content, state) =>
    `<${contextExportName(definition.contract.tag, state.name)} value={{ value: ${valueNames.get(state.name)!} }}>${content}</${contextExportName(definition.contract.tag, state.name)}>`, rootMarkup);
  const componentMarkup = nestedDepthLimit === undefined ? contextMarkup : `<NestedDepthContext value={nestedDepth + 1}>${contextMarkup}</NestedDepthContext>`;
  const body = [
    `// Generated by HTML Next ${version} for React 19. Do not edit.`,
    'import React from "react";',
    'import type { ReactNode } from "react";',
    ...(target.props.length === 0 && !checksControllerWrites ? [] : [`import { ${[
      ...(target.props.length === 0 ? [] : ["checkedProp", "mountPropValidity", "updatePropValidity", "PropBoundary", ...(usesController ? ["propValidityState"] : []), ...(target.props.some((prop) => prop.contract.select !== undefined) ? ["selectedPropNode"] : [])]),
      ...(checksControllerWrites ? ["acceptsControllerWrite"] : []),
    ].join(", ")} } from ${quote(options.propsSpecifier ?? "./props")};`]),
    ...(usesEvents ? [`import { ${[...(hasNativeBindings ? ["attachNativeEvents"] : []), ...(usesEventHooks ? ["useNativeEvents"] : []), ...(target.events.length > 0 ? ["dispatchDeclared", ...(usesTargetDispatch ? ["dispatchDeclaredTargets"] : [])] : [])].join(", ")} } from ${quote(options.eventsSpecifier ?? "./events")};`] : []),
    ...(usesControls ? [`import { ${[
      ...(usesNativeControls ? ["attachBoundControl", "syncBoundControl"] : []),
      ...(usesGenericBindings ? ["attachGenericBinding"] : []),
      ...(usesNestedControlWrites ? ["writeBoundPath"] : []),
    ].join(", ")} } from ${quote(options.controlSpecifier ?? "./control")};`] : []),
    ...(data.length === 0 ? [] : [`import { useDataRead } from ${quote(options.dataSpecifier ?? "./data")};`]),
    ...(usesHtml ? [`import { SanitizedHtml } from ${quote(options.htmlSpecifier ?? "./html")};`] : []),
    ...(usesController ? [`import { useComponentHost } from ${quote(options.hostSpecifier ?? "./host")};`] : []),
    ...(usesContext ? [`import { componentContext } from ${quote(options.contextSpecifier ?? "./context")};`] : []),
    ...(nestedDepthLimit === undefined ? [] : [`import { NestedDepthContext } from ${quote(options.depthSpecifier ?? "./depth")};`]),
    RENDER_IMPORT,
    ...(styles.css === "" ? [] : [`import ${quote(options.stylesheetSpecifier ?? `./${name}.css`)};`]),
    ...[...imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(options.importSpecifier?.(tag) ?? `./${componentName(tag)}.tsx`)};`),
    ...[...new Map(contexts.filter((context) => context.from !== definition.contract.tag || !providedContexts.has(context.name))
      .map((context) => [`${context.from}:${context.name}`, context] as const)).values()]
      .map((context) => `const ${contextExportName(context.from, context.name)} = componentContext<unknown>(${quote(context.from)}, ${quote(context.name)});`),
    ...(checksControllerWrites ? [`const controllerStateTypes = ${JSON.stringify(controllerStateTypes)} as const;`] : []),
    ...target.events.map((event) =>
      `const ${eventSchemas.get(event.name)!} = ${JSON.stringify({ type: declarationTypeNode(event.type, event.shape)!, init: { bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable } })} as const;`),
    ...(states.map((state) =>
      `export const ${contextExportName(definition.contract.tag, state.name)} = componentContext<${stateType(state)}>(${quote(definition.contract.tag)}, ${quote(state.name)});`)),
    "",
    `export type ${name}Props${genericDeclaration} = Omit<React.HTMLAttributes<${rootType}>, ${["style", ...target.props.map((prop) => prop.name)].map(quote).join(" | ")}> & {`,
    ...props,
    ...(target.props.some((prop) => prop.name === "style") ? [] : ["  style?: React.CSSProperties | (React.CSSProperties & { [name: `--${string}`]: string | number | undefined });"]),
    "  children?: ReactNode;",
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
    `  const { children: _children, slots: _slots, ${target.props.map((prop) => `${propKey(prop.name)}: _${prop.name.replace(/[^A-Za-z0-9_$]/g, "_")}`).join(", ")}${target.props.length === 0 ? "" : ", "}...nativeAttrs } = props;`,
    ...(target.props.length > 0 || usesNativeControls ? [
      "  const hasMounted = React.useRef(false);",
      "  React.useLayoutEffect(() => { hasMounted.current = true; }, []);",
    ] : []),
    ...(target.props.length === 0 ? [] : [
      `  const acceptedProps = React.useRef<Record<string, unknown>>({ ${target.props.map((prop) =>
        `${propKey(prop.name)}: ${"default" in prop.contract ? JSON.stringify(prop.contract.default) : "null"}`).join(", ")} });`,
      "  const inputAccepted: Record<string, boolean> = {};",
      "  const checkedProps = {",
      ...target.props.map((prop) => {
        const value = `props[${quote(prop.name)}]`;
        const supplied = "default" in prop.contract ? `${value} === undefined ? ${JSON.stringify(prop.contract.default)} : ${value}` : value;
        return `    ${propKey(prop.name)}: checkedProp<${typeSource(prop.contract.type)}>(${supplied}, ${selectedType(prop)}, ${prop.contract.required}, ${quote(prop.name)}, acceptedProps.current, inputAccepted, false)${"default" in prop.contract ? "!" : ""},`;
      }),
      "  };",
    ]),
    // Handlers read a state's latest write through its getter; rendering reads the value React has.
    ...states.map((state) => {
      const initial = state.expression === undefined ? "undefined" : lowering.value(state.expression.ast, scope);
      return `  const [${valueNames.get(state.name)!}, ${stateSetters.get(state.name)!}, ${stateGetters.get(state.name)!}] = useLiveState<${stateType(state)}>(${initial});`;
    }),
    ...(invalidateStateName === "" ? [] : [`  const [, ${invalidateStateName}] = React.useReducer((revision: number) => revision + 1, 0);`]),
    ...stateSelectedProps.map((prop) => {
      const select = prop.contract.select!;
      return `  checkedProps[${quote(prop.name)}] = checkedProp<${typeSource(prop.contract.type)}>(props[${quote(prop.name)}], selectedPropNode(${valueNames.get(select.from)!}, ${JSON.stringify(select.options)}), ${prop.contract.required}, ${quote(prop.name)}, acceptedProps.current, inputAccepted, false);`;
    }),
    ...(target.props.length === 0 ? [] : [
      "  const propInputValues = { ...checkedProps,",
      ...target.props.map((prop) => `    ...(props[${quote(prop.name)}] === undefined ? {} : { ${propKey(prop.name)}: props[${quote(prop.name)}] }),`),
      "  };",
      "  const reflectedAttrs = {",
      ...target.props.map((prop) => {
        const value = `(hasMounted.current && !inputAccepted[${quote(prop.name)}] ? props[${quote(prop.name)}] : checkedProps[${quote(prop.name)}])`;
        const serialized = `typeof ${value} === "object" ? JSON.stringify(${value}) : String(${value})`;
        return `    ...(Object.hasOwn(props, ${quote(prop.name)}) ? { ${quote(`data-${kebabCase(prop.name)}`)}: ${value} == null ? undefined : (${serialized}) } : {}),`;
      }),
      "  };",
    ]),
    ...data.map((declaration) => {
      const parameters = declaration.parameters.map((parameter) =>
        `${propKey(parameter.name)}: ${lowering.value(parameter.expression.ast, scope)}`).join(", ");
      return `  const ${valueNames.get(declaration.name)!} = useDataRead<${dataTypes.get(declaration)!}>({ ${declaration.source === undefined ? "" : `source: ${quote(declaration.source)}, `}definition: ${quote(definition.source.file)}, ${declaration.type === undefined ? "" : `type: ${quote(declaration.type)}, `}${declaration.debounce === undefined ? "" : `debounce: ${parseDuration(declaration.debounce)}, `}${declaration.poll === undefined ? "" : `poll: ${parseDuration(declaration.poll)}, `}parameters: () => ({ ${parameters} }) });`;
    }),
    ...contexts.flatMap((context, index) => {
      const variable = `__context${index}`;
      const alias = context.as ?? context.name;
      const message = `<${definition.contract.tag}> requires context \`${context.name}\` from <${context.from}>.`;
      return [
        `  const ${variable} = React.useContext(${contextExportName(context.from, context.name)});`,
        `  if (${variable} === undefined) throw Object.assign(new Error(${quote(`HR009: ${message}`)}), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR009", message: ${quote(message)} }) });`,
        `  const ${valueNames.get(alias)!} = ${variable}.value;`,
      ];
    }),
    ...computed.map((value) => {
      const type = typeScript(types.get(value.name)!);
      const expression = value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, scope);
      if (value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, scope)) {
        const previous = computedPreviousNames.get(value.name)!;
        const accepted = computedAcceptedNames.get(value.name)!;
        return [
          `  const ${previous} = React.useRef<${type}>(null as ${type});`,
          `  let ${accepted}: { value: ${type} } | undefined;`,
          `  const ${valueNames.get(value.name)!}: { get(): ${type} } = cycleCheckedComputed<${type}>(() => { const next: any = ${expression}; if (next === Symbol.for("html-next.invalid-result")) return ${previous}.current; ${accepted} = { value: next }; return next; });`,
          `  React.useLayoutEffect(() => { if (${accepted} !== undefined) ${previous}.current = ${accepted}.value; });`,
        ].join("\n");
      }
      return `  const ${valueNames.get(value.name)!}: { get(): ${type} } = cycleCheckedComputed<${type}>((): ${type} => (${expression}) as any);`;
    }),
    ...(styles.stateNames.length === 0 ? [] : [
      `  const hostState = [${styles.stateNames.map((state) => `...hostStateTokens(${quote(state)}, ${code.get(state) ?? state})`).join(", ")}].join(" ");`,
    ]),
    ...(capturesRoot ? [
      `  const rootRef = React.useRef<${publicRootType} | null>(null);`,
      ...(preservesRootFocus ? ["  const rootFocusPending = React.useRef(false);"] : []),
      "  React.useImperativeHandle(props.ref, () => rootRef.current!, undefined);",
    ] : []),
    ...(target.props.length === 0 ? [] : [
      `  const propValidityContract = ${JSON.stringify({ props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) => [name, { ...prop, type: validityType(prop) }])) })} as const;`,
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
      "  const refElements = React.useRef(new Map<string, Set<Element>>());",
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
        const expression = value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, handlerScope);
        if (value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, handlerScope)) {
          const previous = computedPreviousNames.get(value.name)!;
          return `    const ${handlerComputedNames.get(value.name)!}: { get(): ${type} } = cycleCheckedComputed<${type}>(() => { const next: any = ${expression}; return next === Symbol.for("html-next.invalid-result") ? ${previous}.current : (${previous}.current = next); }, false);`;
        }
        return `    const ${handlerComputedNames.get(value.name)!}: { get(): ${type} } = cycleCheckedComputed<${type}>((): ${type} => (${expression}) as any, false);`;
      });
      const steps = handler.steps.map((step, index) => {
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
        const value = lowering.value(step.value.ast, handlerScope);
        const mayBeInvalid = mayProduceInvalidResult(step.value.ast, handlerScope);
        const destinationCheck = conformingLiteralWrite(step, definition) ? undefined
          : handlerDestinationCheck(handlerScope.types.get(state.name)?.type, step.writablePath, 1, "value", handlerScope, lowering);
        const destination = handlerScope.types.get(state.name)?.type;
        // A value of the state's own kind writes as it is; another kind is cast after its check. A
        // function-valued state writes through an updater, which the setter would otherwise call.
        const write = (written: string): string => step.writablePath.length > 1
          ? `${setter}((previous) => writeStatePath(previous, [${step.writablePath.slice(1).map((segment) => typeof segment === "object"
            ? lowering.value(segment.expression, handlerScope) : JSON.stringify(segment)).join(", ")}], ${written}));`
          : destination === undefined || category(destination) === "unknown" ? `${setter}(() => ${written} as typeof ${valueNames.get(state.name)!});`
          : category(destination) === category(typeOf(step.value.ast, handlerScope).type) && !mayBeInvalid ? `${setter}(${written});`
          : `${setter}(${written} as typeof ${valueNames.get(state.name)!});`;
        if (destinationCheck === undefined && !mayBeInvalid) return `    ${guard}${write(value)}`;
        // One checked write per handler reads as `next`; later ones number theirs.
        const next = setSteps(handler) > 1 ? `next${index}` : "next";
        const check = destinationCheck === undefined ? "" : `, ${writePredicate(destinationCheck)}, ${quote(definition.source.file)}, ${quote(handler.name)}, ${quote(step.path)}`;
        const lines = [`const ${next}${mayBeInvalid ? ": any" : ""} = ${value};`, `if (acceptsWrite(${next}${check})) ${write(next)}`];
        return guard === "" ? lines.map((line) => `    ${line}`).join("\n") : `    ${guard}{ ${lines.join(" ")} }`;
      });
      return [
        `  function ${handlerNames.get(handler.name)!}(${[...handlerComputed, ...steps].some((line) => /\bevent\b/.test(line)) ? "event: Event" : ""}): void {`,
        ...handlerComputed,
        ...steps,
        "  }",
      ].join("\n");
    }),
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
      `    const values = [${attachment.properties.map((property) => property.value).join(", ")}];`,
      `    const previous = previousPropertyValues${attachment.name}.current ?? [];`,
      `    if (element !== null) {`,
      ...attachment.properties.map((property, index) =>
        `      if ((${property.accepts ?? "true"}) && ${["scrollTop", "scrollLeft"].includes(property.name) ? `previousPropertyValues${attachment.name}.current !== undefined && ` : ""}(element !== previousPropertyElement${attachment.name}.current || !Object.is(values[${index}], previous[${index}]))) (element as unknown as Record<string, unknown>)[${quote(property.name)}] = values[${index}];`),
      ...attachment.properties.map((property, index) => `      if (${property.accepts ?? "true"}) previous[${index}] = values[${index}];`),
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
        const update = write === undefined ? "undefined" : write.path === "[]"
          ? `(value) => ${setter}(() => value as typeof ${valueNames.get(write.state)!})`
          : `(value) => ${setter}((previous) => writeBoundPath(previous, ${write.dynamic ? "paths?.[0]?.() ?? []" : write.path}, value))`;
        const genericUpdates = attachment.genericWrites.map((generic, index) => {
          const writeSetter = stateSetters.get(generic.state)!;
          const valueName = valueNames.get(generic.state)!;
          const source = generic.path === "[]" ? `(value) => ${writeSetter}(() => value as typeof ${valueName})`
            : `(value) => ${writeSetter}((previous) => writeBoundPath(previous, ${generic.dynamic ? `paths?.[${index + 1}]?.() ?? []` : generic.path}, value))`;
          return `const genericCleanup${index} = attachGenericBinding(element, ${source});`;
        });
        const callback = control === undefined && attachment.genericWrites.length === 0 && !attachment.forward && attachment.properties.length === 0 && attachment.importantStyles.length === 0 && attachment.ref === undefined ? attach : [
          "{",
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
            `if (element !== null) (element as HTMLElement).style.setProperty(${quote(style.name)}, ${quote(style.value)}, "important");`),
          ...(bindings.length === 0 ? [] : [`const nativeCleanup = ${attach};`]),
          ...(control === undefined ? [] : [`const controlCleanup = attachBoundControl(element, ${quote(control.name)}, ${attachment.scoped ? "scoped?.control" : `controlValue${attachment.name}.current`}, ${control.defaults}, ${update}, ${control.nativeProperty}, ${attachment.scoped ? "scoped?.controlAccepted ?? true" : control.accepts ?? "true"});`]),
          ...genericUpdates,
          `return () => { ${attachment.forward && preservesRootFocus ? "rootFocusPending.current = element?.ownerDocument.activeElement === element; " : ""}${attachment.forward ? "rootRef.current = null; " : ""}${attachment.ref === undefined ? "" : `refElements.current.get(${quote(attachment.ref)})?.delete(element!); `}${control === undefined ? "" : `${attachment.scoped ? "" : `controlRef${attachment.name}.current = null; `}controlCleanup?.(); `}${attachment.genericWrites.map((_write, index) => `genericCleanup${index}?.();`).join(" ")} ${attachment.properties.length === 0 || attachment.scoped ? "" : `propertyRef${attachment.name}.current = null; `}${bindings.length === 0 ? "" : "nativeCleanup?.();"} };`,
          "}",
        ].join(" ");
        return `  const ${attachment.name} = React.useCallback((element: Element | null, paths?: readonly (((() => readonly (string | number)[]) | undefined))[]${attachment.scoped ? ", scoped?: { readonly control?: unknown; readonly controlAccepted?: boolean }" : ""}) => ${callback}, []);`;
      }),
    ] : []),
    ...(usesController ? computed.map((value) => {
      const controllerCode = new Map(scope.code);
      for (const state of states) controllerCode.set(state.name, `${stateGetters.get(state.name)!}()`);
      for (const declaration of computed) controllerCode.set(declaration.name, `${controllerComputedNames.get(declaration.name)!}.get()`);
      const controllerScope: Scope = { code: controllerCode, types: scope.types };
      const expression = value.expression === undefined ? "undefined" : lowering.value(value.expression.ast, controllerScope);
      const type = typeScript(types.get(value.name)!);
      if (value.expression !== undefined && mayProduceInvalidResult(value.expression.ast, controllerScope)) {
        const previous = computedPreviousNames.get(value.name)!;
        return `  const ${controllerComputedNames.get(value.name)!}: { get(): ${type} } = cycleCheckedComputed<${type}>(() => { const next: any = ${expression}; return next === Symbol.for("html-next.invalid-result") ? ${previous}.current : (${previous}.current = next); }, false);`;
      }
      return `  const ${controllerComputedNames.get(value.name)!}: { get(): ${type} } = cycleCheckedComputed<${type}>((): ${type} => (${expression}) as any, false);`;
    }) : []),
    ...(usesController ? [
      `  useComponentHost(() => import(${quote(definition.controller!)}), {`,
      `    root: rootRef, definition: ${quote(definition.source.file)}, controller: ${quote(options.controllerSpecifier ?? definition.controller!)},`,
      `    props: () => ${target.props.length === 0 ? "({})" : "checkedProps"},`,
      ...(target.props.length === 0 ? [] : [
        `    propNames: ${JSON.stringify(target.props.map((prop) => prop.name))},`,
        `    propInputs: (name: string) => props[name] ?? null,`,
        `    propValidity: (name: string) => propValidityState({ contract: propValidityContract, values: { ...propInputValues${propSelectors.map((selector) => `, ${propKey(selector)}: checkedProps[${quote(selector)}]`).join("")}${stateSelectors.map((selector) => `, ${propKey(selector)}: ${valueNames.get(selector)!}`).join("")} } }, name),`,
      ]),
      `    state: { ${states.map((state) => `${propKey(state.name)}: { get: ${stateGetters.get(state.name)!}, set: (value: unknown) => { ${stateSetters.get(state.name)!}(() => value as typeof ${valueNames.get(state.name)!}); }, touch: ${invalidateStateName} }`).join(", ")} },`,
      `    computed: { ${[
        ...computed.map((value) => `${propKey(value.name)}: () => ${controllerComputedNames.get(value.name)!}.get()`),
        ...contexts.map((value) => `${propKey(value.as ?? value.name)}: () => ${valueNames.get(value.as ?? value.name)!}`),
      ].join(", ")} },`,
      `    data: { ${data.map((value) => `${propKey(value.name)}: () => ${valueNames.get(value.name)!}`).join(", ")} },`,
      ...(checksControllerWrites ? [`    acceptsState: (name, keys, value) => acceptsControllerWrite(value, controllerStateTypes[name as keyof typeof controllerStateTypes], keys),`] : []),
      `    refs: ${usesRefs ? "refElements.current" : "new Map<string, ReadonlySet<Element>>()"},`,
      `    dispatch: (root: Element, name: string, detail?: unknown) => { switch (name) { ${target.events.map((event) => `case ${quote(event.name)}: return dispatchDeclared(root, name, detail, ${eventSchemas.get(event.name)!}.type, ${eventSchemas.get(event.name)!}.init);`).join(" ")} default: return root.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: false })); } },`,
      `  });`,
    ] : []),
    `  return (${componentMarkup});`,
    "}",
    ...(usesScopedAttachments ? [
      "",
      "type ScopedPath = (() => readonly (string | number)[]) | undefined;",
      "type ScopedProperty = { readonly name: string; readonly value: unknown; readonly accepted: boolean };",
      "type ScopedControl = { readonly name: 'value' | 'checked'; readonly value: unknown; readonly defaults: { readonly value?: string; readonly checked?: boolean; readonly options?: readonly boolean[] }; readonly nativeProperty: boolean; readonly accepted: boolean };",
      "function ScopedAttachment({ attach, paths, properties, control, render }: {",
      "  readonly attach: (element: Element | null, paths?: readonly ScopedPath[], scoped?: { readonly control?: unknown; readonly controlAccepted?: boolean }) => void | (() => void);",
      "  readonly paths: readonly ScopedPath[]; readonly properties: readonly ScopedProperty[]; readonly control?: ScopedControl;",
      "  readonly render: (ref: React.RefCallback<Element>) => ReactNode;",
      "}): ReactNode {",
      "  const element = React.useRef<Element | null>(null);",
      "  const currentPaths = React.useRef(paths);",
      "  const currentControl = React.useRef(control);",
      "  const previousValues = React.useRef<unknown[] | undefined>(undefined);",
      "  const previousElement = React.useRef<Element | null>(null);",
      "  const ref = React.useCallback((node: Element | null) => {",
      "    element.current = node;",
      "    const stablePaths = currentPaths.current.map((_, index) => () => currentPaths.current[index]?.() ?? []);",
      "    const selected = currentControl.current;",
      "    const cleanup = attach(node, stablePaths, { control: selected?.value, controlAccepted: selected?.accepted });",
      "    return () => { element.current = null; cleanup?.(); };",
      "  }, [attach]);",
      "  React.useLayoutEffect(() => {",
      "    currentPaths.current = paths; currentControl.current = control;",
      "    const node = element.current;",
      "    if (node === null) return;",
      ...(usesNativeControls ? [
        "    if (control !== undefined) syncBoundControl(node, control.name, control.value, control.defaults, control.nativeProperty, control.accepted);",
      ] : []),
      "    const previous = previousValues.current ?? [];",
      "    for (const [index, property] of properties.entries()) {",
      "      if (property.accepted && (!['scrollTop', 'scrollLeft'].includes(property.name) || previousValues.current !== undefined) &&",
      "        (node !== previousElement.current || !Object.is(property.value, previous[index])))",
      "        (node as unknown as Record<string, unknown>)[property.name] = property.value;",
      "      if (property.accepted) previous[index] = property.value;",
      "    }",
      "    previousElement.current = node; previousValues.current = previous;",
      "  });",
      "  return render(ref);",
      "}",
    ] : []),
    "",
  ].join("\n");
  // The shared module's helpers this component calls: the expression helpers its lowering used,
  // and the rendering components and functions its markup and handlers name.
  const rendered = [...new Set([...lowering.helpers(), ...REACT_RENDER_COMPONENTS.filter((name) => new RegExp(`\\b${name}\\b`).test(body))])].sort();
  const component = formatReact(body.replace(`${RENDER_IMPORT}\n`, rendered.length === 0 ? ""
    : `import { ${rendered.join(", ")} } from ${quote(options.renderSpecifier ?? REACT_RENDER_SPECIFIER)};\n`), `${name}.tsx`);
  return {
    component,
    css: styles.css,
    helpers: [
      ...(target.props.length === 0 && target.events.length === 0 && !checksControllerWrites ? [] : ["props" as const]),
      ...(usesEvents ? ["events" as const] : []),
      ...(usesControls ? ["control" as const] : []),
      ...(data.length === 0 ? [] : ["data" as const]),
      ...(usesHtml ? ["html" as const] : []),
      ...(usesController ? ["host" as const] : []),
      ...(usesContext ? ["context" as const] : []),
      ...(nestedDepthLimit === undefined ? [] : ["depth" as const]),
      ...(rendered.length === 0 ? [] : ["render" as const]),
    ],
  };
}

export function generateReact(definition: ComponentDefinition, version: string, options: ReactConversionOptions = {}): string {
  return generateReactOutput(definition, version, options).component;
}
