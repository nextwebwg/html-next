/**
 * Converts a definition to a Vue 3.5 single-file component that depends only on Vue and the
 * component's own modules. Props, state, computed values, bindings, structural directives, slots,
 * events, and methods map to Vue's own facilities; the controller receives a host generated here from
 * Vue refs, effects, and lifecycle; styles become `<style scoped>`.
 */
import { parseFragment } from "parse5";

import { fail } from "../diagnostics.js";
import { parseDuration } from "../duration.js";
import { typeCheckedDependencies, type CompiledExpression, type ExpressionNode } from "../expression.js";
import { componentName, kebabCase } from "../names.js";
import { getDomInterface } from "../platform.js";
import type {
  ComponentDefinition,
  DataDeclaration,
  ElementNode,
  EventDeclaration,
  HandlerDeclaration,
  ReactiveDeclaration,
  SlotContract,
  SlotNode,
  TemplateNode,
} from "../template.js";
import { definitionMayInvokeComponents, elementMatchRoot, rootArms } from "../template.js";
import type { WritablePathSegment } from "../expression.js";
import { compileComponentStylesForVue } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import { declarationTypeNode, normalizeType, parseTypeExpression, typeAtKey, typeScriptType, type TypeNode } from "../type-system.js";
import { targetComponent } from "./backend.js";
import { dependentPropTypeSource, escapeHtml, isVoidElement, propKey, quote, selectorGenerics, typeSource } from "./shared.js";
import { formatVue } from "./vue-format.js";
import { VUE_HOST_SPECIFIER } from "./vue-host.js";
import { VUE_HTML_SPECIFIER } from "./vue-html.js";
import { VUE_CONTROL_SPECIFIER } from "./vue-control.js";
import { VUE_PROPS_SPECIFIER } from "./vue-props.js";
import { category, Lowering, present, typeOf, typeScript, UNKNOWN, type Scope, type Static } from "./vue-lowering.js";

/** The Vue APIs a converted component uses itself; the shared module imports lifecycle and effects. */
const VUE_APIS = ["computed", "defineComponent", "getCurrentInstance", "h", "inject", "provide", "ref", "useSlots", "useTemplateRef", "watchSyncEffect"] as const;

// HTML parsing lowercases directive names even inside SVG. Ask the HTML parser for the same
// SVG adjustment it applies to literal attributes, then force Vue to write that exact attribute.
const adjustedSvgAttributes = new Map<string, string>();
function svgAttributeName(name: string): string {
  let adjusted = adjustedSvgAttributes.get(name);
  if (adjusted === undefined) {
    const fragment = parseFragment(`<svg ${name}></svg>`);
    const svg = fragment.childNodes[0] as { attrs?: readonly { name: string }[] } | undefined;
    adjusted = svg?.attrs?.[0]?.name ?? name;
    adjustedSvgAttributes.set(name, adjusted);
  }
  return adjusted;
}

/** Names the generated script defines itself, which declared names must not take. */
const RESERVED = new Set([
  "props", "emit", "root", "refs", "dispatch", "host", "hostState", "read", "write", "stops", "cleanup", "ready",
  "model", "controllerModule", "event", "element", "truthy", "text", "attribute", "list", "number", "sortBy", "eachRows", "uniqueKeys", "KeyedBoundary", "KeyedFailure",
  "useComponentHost", "createDispatch", "useDataRead", "runFilteredEvent", "componentInstance", "reflectedProp", "nativeAttrs",
  "checkedProps", "checkedProp", "propValidityContract", "vPropValidity", "PropType", "vBindControl", "readBoundControl",
  "SelectedOptions", "scopedSlotName", "projectedSlots", "cycleCheckedComputed",
  "SanitizedHtml",
  "String", "Boolean", "Number", "Math", "Object", "Array", "CustomEvent", "Promise", "Proxy", "Reflect", "TypeError",
  "encodeURIComponent", "undefined", "NaN", "Infinity", ...VUE_APIS,
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "arguments", "eval",
]);

/** Allocates readable script identifiers: the declared name when it is free. */
class Identifiers {
  readonly #taken = new Set(RESERVED);

  constructor(taken: Iterable<string>) {
    for (const name of taken) this.#taken.add(name);
  }

  take(name: string, suffix: string): string {
    const base = name.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^(?=\d)/, "_");
    let candidate = this.#taken.has(base) ? `${base}${suffix}` : base;
    for (let index = 2; this.#taken.has(candidate); index++) candidate = `${base}${suffix}${index}`;
    this.#taken.add(candidate);
    return candidate;
  }
}

interface Names {
  readonly template: Scope;
  readonly script: Scope;
  readonly locals?: ReadonlySet<string>;
}

function ast(plan: { ast: ExpressionNode } | undefined, source: string): ExpressionNode {
  if (plan === undefined) fail("HT030", `Expression \`${source}\` could not be converted.`);
  return plan.ast;
}

/**
 * A double-quoted HTML attribute value. Only `"` and an `&` that could begin a character reference
 * are escaped, so expressions such as `a && b` stay readable to Vue's type checker, which does not
 * decode references.
 */
function attributeValue(value: string): string {
  return `"${value.replace(/&(?=[#A-Za-z])/g, "&amp;").replace(/"/g, "&quot;")}"`;
}

/**
 * A template binding: the JavaScript expression as an attribute value. String literals use single
 * quotes so the attribute needs no `&quot;`, which Vue's type checker does not decode.
 */
function bound(code: string): string {
  return attributeValue(code.replace(/"(?:\\.|[^"\\])*"/g, (literal) =>
    `'${literal.slice(1, -1).replace(/\\"/g, "\"").replace(/'/g, "\\'")}'`));
}

function writableTarget(path: readonly WritablePathSegment[], scope: Scope, lowering: Lowering): string {
  const [root, ...rest] = path;
  const base = scope.code.get(String(root));
  if (base === undefined) fail("HT031", `\`${String(root)}\` is not a writable state path.`);
  return base + rest.map((segment) =>
    typeof segment === "object" ? `[${lowering.value(segment.expression, scope)}]`
    : typeof segment === "string" && /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}`
    : `[${JSON.stringify(segment)}]`).join("");
}

interface Context {
  readonly definition: ComponentDefinition;
  /** Slot declarations in the linked component graph, keyed by receiving tag. */
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  readonly lowering: Lowering;
  readonly imports: Set<string>;
  /** Template refs, by ref name, and the script variable holding each. */
  readonly refs: Map<string, string>;
  readonly identifiers: Identifiers;
  /** Handler script names, by declared name. */
  readonly handlers: ReadonlyMap<string, string>;
  /** Whether the root needs a Vue ref (for dispatch and the controller host). */
  readonly root: boolean;
  /** A template-ref name authors cannot write as $ref, for unmarked root $match arms. */
  readonly rootArmRef?: string;
  /** Whether the root is a native form control bound to the component's `v-model`. */
  readonly model: boolean;
  readonly validityValues?: string;
  readonly hostState: boolean;
  readonly guarded: string[];
  readonly globals: ReadonlySet<string>;
  usesHtml: boolean;
  usesHydrationControl: boolean;
  usesKeyedBoundary: boolean;
}

function referenceCheck(type: TypeNode, value: string): string {
  switch (type.kind) {
    case "list": return `Array.isArray(${value})`;
    case "record":
    case "object": return `(typeof ${value} === "object" && ${value} !== null && !Array.isArray(${value}))`;
    case "union": return `(${type.members.map((member) => referenceCheck(member, value)).join(" || ")})`;
    case "selected": return `(${type.options.map((option) => referenceCheck(option.type, value)).join(" || ")})`;
    case "constrained": return type.values === undefined ? referenceCheck(type.base, value)
      : `(${type.values.map((choice) => `${value} === ${JSON.stringify(choice)}`).join(" || ")})`;
    case "keyword": return `${value} === ${quote(type.value)}`;
    case "separated-list": return `Array.isArray(${value})`;
    case "terminal":
      if (type.name === "string") return `typeof ${value} === "string"`;
      if (type.name === "boolean") return `typeof ${value} === "boolean"`;
      if (type.name === "number") return `(typeof ${value} === "number" && Number.isFinite(${value}))`;
      if (type.name === "integer") return `Number.isInteger(${value})`;
      if (type.name === "null") return `${value} === null`;
      if (type.name === "absent") return `${value} === undefined`;
      if (type.name === "function") return `typeof ${value} === "function"`;
      return "true";
  }
}

/** The same declared path checks as the live evaluator, before a generated expression can update. */
function expressionGuard(plan: CompiledExpression, scope: Scope, definition: ComponentDefinition): string | undefined {
  const checks: string[] = [];
  for (const dependency of typeCheckedDependencies(plan)) {
    const [root, ...steps] = dependency.split(".");
    const declaration = definition.declarations?.find((entry) => entry.name === root);
    let type: TypeNode | undefined;
    // Prop boundary handling is separate from these mutable declaration guards.
    if (definition.contract.props[root!] !== undefined) continue;
    if (declaration?.kind === "state" || declaration?.kind === "computed") {
      type = declarationTypeNode(declaration.type, declaration.shape);
    } else if (declaration?.kind === "data") {
      const first = steps.shift();
      if (first === "value") type = declaration.type === undefined ? undefined : parseTypeExpression(declaration.type);
      else if (first === "pending" || first === "ok") type = { kind: "terminal", name: "boolean" };
      else if (first === "error") type = UNKNOWN.type;
      if (first !== undefined) steps.unshift(first);
    }
    if (type === undefined) continue;
    for (const step of declaration?.kind === "data" ? steps.slice(1) : steps) {
      type = typeAtKey(type, step);
      if (type === undefined) break;
    }
    if (type === undefined) continue;
    const base = scope.code.get(root!);
    if (base === undefined) continue;
    const read = `${base}${steps.map((step) => `?.[${quote(step)}]`).join("")}`;
    checks.push(`(${read} == null || ${referenceCheck(type, read)})`);
  }
  return checks.length === 0 ? undefined : checks.join(" && ");
}

function guardedBinding(plan: CompiledExpression, names: Names, context: Context, emit: (scope: Scope) => string): string | undefined {
  if (plan.dependencies.some((dependency) => {
    const root = dependency.split(".")[0]!;
    return !context.globals.has(root) || names.locals?.has(root);
  })) return undefined;
  const guard = expressionGuard(plan, names.script, context.definition);
  if (guard === undefined) return undefined;
  const name = context.identifiers.take("guarded", "Binding");
  context.guarded.push(`let ${name}Previous: any;`, `const ${name} = computed(() => { if (!(${guard})) return ${name}Previous; return ${name}Previous = ${emit(names.script)}; });`);
  return name;
}

function isComponentTag(name: string): boolean {
  return name.includes("-") && getDomInterface(name) === undefined;
}

/**
 * Adjacent elements go on separate lines, for the formatter to lay out; Vue drops whitespace that
 * holds a newline between elements, so the rendering is unchanged. Text keeps its own whitespace.
 */
function renderChildren(nodes: readonly TemplateNode[], names: Names, context: Context, receivingTag?: string): string {
  return nodes.map((child, index) => {
    const markup = renderNode(child, names, context, receivingTag);
    return index > 0 && child.kind !== "text" && nodes[index - 1]!.kind !== "text" ? `\n${markup}` : markup;
  }).join("");
}

/** Names bound by `$each`, `$with`, and `$match`, read the same way in template and script. */
function withLocal(names: Names, entries: readonly (readonly [string, Static])[]): Names {
  const scope = (base: Scope): Scope => {
    const code = new Map(base.code);
    const types = new Map(base.types);
    for (const [name, type] of entries) {
      code.set(name, name);
      types.set(name, type);
    }
    return { code, types };
  };
  return {
    template: scope(names.template),
    script: scope(names.script),
    locals: new Set([...(names.locals ?? []), ...entries.map(([name]) => name)]),
  };
}

/** Slot props shadow consumer names only when the receiving outlet actually supplies them. */
function withSlotProps(names: Names, props: readonly string[], alias: string): Names {
  const local = withLocal(names, props.map((name) => [name, UNKNOWN] as const));
  const remap = (scope: Scope, parent: Scope): Scope => {
    const code = new Map(scope.code);
    for (const name of props) {
      const fallback = parent.code.get(name) ?? "undefined";
      code.set(name, `(Object.hasOwn(${alias}, ${quote(name)}) ? ${alias}[${quote(name)}] : (${fallback}))`);
    }
    return { ...scope, code };
  };
  return { ...local, template: remap(local.template, names.template), script: remap(local.script, names.script) };
}

function readsLoop(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!Array.isArray(value) && "kind" in value && "name" in value && value.kind === "id" && value.name === "loop") return true;
  return Object.values(value).some(readsLoop);
}

/** A consumer template's free names are the receiving slot's props, not setup-scope globals. */
function projectedNames(children: readonly TemplateNode[], scope: Scope): readonly string[] {
  const exposed = new Set<string>();
  const dependencies = (plan: CompiledExpression | undefined, known: ReadonlySet<string>): void => {
    for (const dependency of plan?.dependencies ?? []) {
      const root = dependency.split(".", 1)[0]!;
      if (!known.has(root)) exposed.add(root);
    }
  };
  const visit = (node: TemplateNode, inherited: ReadonlySet<string>): void => {
    if (node.kind === "text") return;
    const known = new Set(inherited);
    const flow = node.flow;
    if (flow?.kind === "each") {
      dependencies(flow.listPlan, known);
      known.add(flow.item);
      if (flow.index !== undefined) known.add(flow.index);
      known.add("loop");
      dependencies(flow.wherePlan, known);
      dependencies(flow.limitPlan, known);
      dependencies(flow.keyPlan, known);
    } else if (flow?.kind === "if" || flow?.kind === "when") dependencies(flow.testPlan, known);
    else if (flow?.kind === "with" || flow?.kind === "match") {
      dependencies(flow.expressionPlan, known);
      if (flow.alias !== undefined) known.add(flow.alias);
    }
    if (node.kind === "slot") {
      dependencies(node.nameExpression, known);
      for (const prop of node.props ?? []) dependencies(prop.expressionPlan, known);
      for (const child of node.fallback ?? []) visit(child, known);
      return;
    }
    for (const attribute of node.attributes) if (attribute.kind !== "literal") dependencies(attribute.expressionPlan, known);
    for (const child of node.children) visit(child, known);
  };
  const known = new Set(scope.code.keys());
  for (const child of children) visit(child, known);
  return [...exposed];
}

function renderEachNode(node: ElementNode | SlotNode, flow: Extract<NonNullable<ElementNode["flow"]>, { kind: "each" }>, names: Names, context: Context): string {
  const { lowering } = context;
  const listNode = ast(flow.listPlan, flow.list);
  const listType = typeOf(listNode, names.template);
  const itemType: Static = listType.type.kind === "list" ? { type: present(listType.type.item).type, nullable: false } : { ...UNKNOWN, nullable: false };
  const item = flow.item;
  const index = flow.index ?? context.identifiers.take("index", "Loop");
  const local = withLocal(names, [
    [item, itemType],
    [index, { type: { kind: "terminal", name: "number" }, nullable: false }],
    ["loop", { type: { kind: "object", open: false, fields: [
      { name: "index", type: { kind: "terminal", name: "number" }, optional: false },
      { name: "first", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "last", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "count", type: { kind: "terminal", name: "number" }, optional: false },
    ] }, nullable: false }],
  ]);
  const list = lowering.list(listNode, names.template, item, {
    ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
    itemScope: local.template,
    sort: (flow.sort ?? "").split(",").map((key) => key.trim()).filter(Boolean),
    ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
  });
  const key = flow.keyPlan === undefined ? index : lowering.value(flow.keyPlan.ast, local.template);
  const { flow: _flow, ...body } = node;
  const needsLoop = readsLoop(body) || readsLoop(flow.keyPlan?.ast);
  const row = needsLoop ? `({ item: ${item}, index: ${index}, loop })` : flow.index === undefined && flow.keyPlan !== undefined ? item : `(${item}, ${index})`;
  const checkedList = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list, `(${item}, ${index}, loop) => ${key}`);
  const rows = needsLoop ? lowering.eachRows(checkedList) : checkedList;
  const directives = [`v-for=${bound(`${row} in ${rows}`)}`, `:key=${bound(key)}`];
  const markup = node.kind === "slot"
    ? `<template ${directives.join(" ")}>${renderNode(body as SlotNode, local, context)}</template>`
    : wrap(body as ElementNode, directives, local, context);
  if (flow.keyPlan === undefined) return markup;
  context.usesKeyedBoundary = true;
  return `<KeyedBoundary>${markup}</KeyedBoundary>`;
}

function renderNode(node: TemplateNode, names: Names, context: Context, receivingTag?: string): string {
  const { lowering } = context;
  if (node.kind === "text") return escapeHtml(node.value).replace(/\{\{/g, "{{ '{{' }}");
  if (node.kind === "slot") {
    if (node.flow !== undefined) return renderEachNode(node, node.flow, names, context);
    const scoped = (node.props?.length ?? 0) > 0;
    const slotName = node.nameExpression !== undefined
      ? lowering.value(ast(node.nameExpression, "slot name"), names.template)
      : quote(node.name ?? "");
    const name = node.nameExpression !== undefined
      ? ` :name=${bound(scoped ? `scopedSlotName(${slotName})` : slotName)}`
      : scoped ? ` :name=${bound(`scopedSlotName(${slotName})`)}`
        : node.name === undefined ? "" : ` name=${quote(node.name)}`;
    const props = (node.props ?? []).map((prop) => ` :${prop.name}=${bound(lowering.value(prop.expressionPlan.ast, names.template))}`).join("");
    const fallback = renderChildren(node.fallback ?? [], names, context);
    return fallback === "" ? `<slot${name}${props} />` : `<slot${name}${props}>${fallback}</slot>`;
  }
  const projected = node.name === "template"
    ? node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "slot")
    : undefined;
  if (projected?.kind === "literal") {
    const contract = receivingTag === undefined ? undefined : context.slotsByTag?.get(receivingTag)
      ?.find((slot) => !slot.dynamic && slot.name === projected.value);
    const props = contract?.props ?? projectedNames(node.children, names.template);
    const alias = contract !== undefined && props.length > 0 ? context.identifiers.take("slotProps", "") : undefined;
    const local = alias === undefined ? withLocal(names, props.map((name) => [name, UNKNOWN] as const))
      : withSlotProps(names, props, alias);
    const slotName = /^[A-Za-z_][\w-]*$/.test(projected.value)
      ? `#${projected.value}`
      : `v-slot:[${quote(projected.value)}]`;
    const scopeBinding = props.length === 0 ? "" : `=${bound(alias ?? `{ ${props.join(", ")} }`)}`;
    return `<template ${slotName}${scopeBinding}>${renderChildren(node.children, local, context)}</template>`;
  }
  const flow = node.flow;
  if (flow?.kind === "each") return renderEachNode(node, flow, names, context);
  if (flow?.kind === "with") {
    const value = ast(flow.expressionPlan, flow.expr);
    const { flow: _flow, ...body } = node;
    return `<template v-for=${bound(`${flow.alias} in [${lowering.value(value, names.template)}]`)}>${renderNode(body, withLocal(names, [[flow.alias, typeOf(value, names.template)]]), context)}</template>`;
  }
  if (flow?.kind === "match") {
    if (node.name !== "template") return renderElement(elementMatchRoot(node), names, context, false);
    const value = flow.expr === undefined ? undefined : ast(flow.expressionPlan, flow.expr);
    const local = flow.alias === undefined ? names : withLocal(names, [[flow.alias, value === undefined ? UNKNOWN : typeOf(value, names.template)]]);
    const arms = node.children
      .filter((child): child is ElementNode => child.kind === "element" && (child.flow?.kind === "when" || child.flow?.kind === "else"))
      .map((arm, index) => {
        const { flow: armFlow, ...armBody } = arm;
        const test = armFlow?.kind === "when" ? lowering.condition(ast(armFlow.testPlan, armFlow.test), local.template) : undefined;
        const directive = test === undefined ? "v-else" : `${index === 0 ? "v-if" : "v-else-if"}=${bound(test)}`;
        return wrap(armBody, [directive], local, context);
      }).join("\n");
    const inner = arms;
    if (value === undefined) return inner;
    return `<template v-for=${bound(`${flow.alias} in [${lowering.value(value, names.template)}]`)}>${inner}</template>`;
  }
  if (flow?.kind === "if") {
    const { flow: _flow, ...body } = node;
    return wrap(body, [`v-if=${bound(lowering.condition(ast(flow.testPlan, flow.test), names.template))}`], names, context);
  }
  return renderElement(node, names, context, false);
}

/** A structural directive on its element, or on a `<template>` when the element is one itself. */
function wrap(node: ElementNode, directives: readonly string[], names: Names, context: Context): string {
  if (node.name === "template" || node.flow !== undefined) {
    return `<template ${directives.join(" ")}>${renderNode(node, names, context)}</template>`;
  }
  return renderElement(node, names, context, false, directives);
}

function renderElement(node: ElementNode, names: Names, context: Context, isRoot: boolean, directives: readonly string[] = []): string {
  const { lowering } = context;
  const component = isComponentTag(node.name);
  const name = component ? componentName(node.name) : node.name;
  if (component) context.imports.add(node.name);
  const literals: string[] = [];
  const attributes: string[] = [];
  const nativeControl = !component && ["input", "textarea", "select"].includes(node.name);
  const authoredDefault = (bindingName: "value" | "checked"): string => {
    if (bindingName === "checked") {
      return `defaultChecked: ${node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "checked")}`;
    }
    const literal = node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "value");
    const initial = node.name === "textarea" && node.children.every((child) => child.kind === "text")
      ? node.children.map((child) => child.kind === "text" ? child.value : "").join("")
      : literal?.kind === "literal" ? literal.value : "";
    return `defaultValue: ${quote(initial)}`;
  };
  const twoWayControl = nativeControl && node.attributes.some((attribute) =>
    attribute.kind === "attribute" && attribute.twoWay === true && ["value", "checked"].includes(attribute.name));
  if (nativeControl) {
    if (twoWayControl || isRoot && context.model) context.usesHydrationControl = true;
    else {
      const controlling = node.attributes.find((attribute) =>
        attribute.kind === "property" &&
        (attribute.name === "value" || attribute.name === "checked"));
      if (controlling?.kind === "property") {
        context.usesHydrationControl = true;
        const value = lowering.value(ast(controlling.expressionPlan, controlling.expression), names.template);
        attributes.push(`v-bind-control=${bound(`{ tag: ${quote(node.name)}, name: ${quote(controlling.name)}, value: ${value}, nativeProperty: true, ${authoredDefault(controlling.name as "value" | "checked")} }`)}`);
      }
    }
  }
  const classes: string[] = [];
  const styles: string[] = [];
  const reflected = isRoot && !component
    ? Object.entries(context.definition.contract.props).map(([propName]) => {
      const attributeName = `data-${kebabCase(propName)}`;
      const existing = node.attributes.find((attribute) =>
        (attribute.kind === "attribute" || attribute.kind === "literal") && attribute.name === attributeName);
      return { propName, attributeName, existing };
    })
    : [];
  const reflectedNames = new Set(reflected.map(({ attributeName }) => attributeName));
  let content: string | undefined;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      const propertyOwnsControl = nativeControl && ["value", "checked"].includes(attribute.name) &&
        node.attributes.some((candidate) => candidate.kind === "property" && candidate.name === attribute.name);
      if (!reflectedNames.has(attribute.name) && !propertyOwnsControl) literals.push(`${attribute.name}=${attributeValue(attribute.value)}`);
    } else if (attribute.kind === "attribute" && reflectedNames.has(attribute.name) && attribute.twoWay !== true) {
      // The runtime's prop reflection is the final writer for this data-* attribute.
      continue;
    } else if (attribute.kind === "directive") {
      const plan = attribute.expressionPlan;
      const guarded = plan === undefined ? undefined : guardedBinding(plan, names, context, (scope) => lowering.text(plan.ast, scope));
      const value = guarded ?? lowering.text(ast(plan, attribute.expression), names.template);
      if (attribute.name === "html") {
        context.usesHtml = true;
        content = `<SanitizedHtml :value=${bound(value)} />`;
      } else content = `{{ ${value} }}`;
    } else if (attribute.kind === "property") {
      const value = ast(attribute.expressionPlan, attribute.expression);
      const type = typeOf(value, names.template);
      // DOM property types are narrower than an absent or untyped HTML Next value.
      const code = lowering.value(value, names.template);
      const nativeProperty = nativeControl && ["value", "checked"].includes(attribute.name);
      if (!nativeProperty) attributes.push(`:${attribute.name}.prop=${bound(type.nullable || category(type.type) === "unknown" ? `${code} as any` : code)}`);
    } else if (attribute.target === "class") {
      classes.push(`${quote(attribute.name)}: ${lowering.condition(ast(attribute.expressionPlan, attribute.expression), names.template)}`);
    } else if (attribute.target === "style") {
      const value = ast(attribute.expressionPlan, attribute.expression);
      const code = lowering.text(value, names.template);
      styles.push(`${quote(attribute.name)}: ${typeOf(value, names.template).nullable ? `(${code} ?? undefined)` : code}`);
    } else if (attribute.twoWay === true && attribute.writablePath !== undefined) {
      const writable = writableTarget(attribute.writablePath, names.template, lowering);
      if (nativeControl && ["value", "checked"].includes(attribute.name)) {
        const event = node.name === "select" || node.name === "input" && attribute.name === "checked" ||
          node.name === "input" && node.attributes.some((entry) => entry.kind === "literal" && entry.name === "type" && ["checkbox", "radio", "file"].includes(entry.value))
          ? "change" : "input";
        const control = "($event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)";
        const read = `readBoundControl(${control}) as any`;
        const update = node.name === "input" && attribute.name === "checked"
          ? `(${control}.type !== 'radio' || ${control}.checked) && (${writable} = ${read})`
          : `${writable} = ${read}`;
        attributes.push(`v-bind-control=${bound(`{ tag: ${quote(node.name)}, name: ${quote(attribute.name as "value" | "checked")}, value: ${writable}, ${authoredDefault(attribute.name as "value" | "checked")} }`)}`);
        attributes.push(`@${event}=${bound(update)}`);
      } else {
        const value = ast(attribute.expressionPlan, attribute.expression);
        attributes.push(`:${svgAttributeName(attribute.name)}.attr=${bound(lowering.attribute(value, names.template, attribute.name))}`);
        attributes.push(`@input=${bound(`${writable} = ((($event.currentTarget as Element & { value?: any }).value ?? ($event.currentTarget as Element).getAttribute('value')) as any)`)}`);
      }
    } else if (isRoot && context.model && attribute.name === "value") {
      // The model supplies the root's value (below).
    } else {
      const plan = attribute.expressionPlan;
      const value = ast(plan, attribute.expression);
      const nativeAttribute = nativeControl && ["value", "checked"].includes(attribute.name);
      const attributeValueFor = (scope: Scope): string =>
        nativeAttribute && attribute.name === "checked" && category(typeOf(value, scope).type) === "boolean"
          ? `${lowering.condition(value, scope)} ? true : undefined`
          : lowering.attribute(value, scope, attribute.name);
      const guarded = plan === undefined ? undefined : guardedBinding(plan, names, context, (scope) =>
        component ? lowering.value(value, scope) : attributeValueFor(scope));
      const adjusted = component ? attribute.name : svgAttributeName(attribute.name);
      attributes.push(`:${adjusted}${nativeAttribute || adjusted !== attribute.name ? ".attr" : ""}=${bound(guarded ?? (component ? lowering.value(value, names.template) : attributeValueFor(names.template)))}`);
    }
  }
  if (classes.length > 0) attributes.push(`:class=${bound(`{ ${classes.join(", ")} }`)}`);
  if (styles.length > 0) attributes.push(`:style=${bound(`{ ${styles.join(", ")} }`)}`);
  for (const event of node.events ?? []) {
    const handler = context.handlers.get(event.handler);
    if (handler === undefined) fail("HT033", `Handler \`${event.handler}\` is not declared.`);
    // Vue evaluates action modifiers in source order and rewrites click.middle/right to a
    // different event type. HTML Next first checks every filter, then prevents/stops the
    // original event, regardless of modifier order. Keep only native listener options in Vue.
    if (event.modifiers.length > 0) {
      const options = event.modifiers.filter((modifier) => ["once", "capture", "passive"].includes(modifier));
      attributes.push(`@${event.name}${options.map((modifier) => `.${modifier}`).join("")}=${bound(`($event: Event) => runFilteredEvent($event, ${JSON.stringify(event.modifiers)}, ${handler})`)}`);
    } else {
      attributes.push(`@${event.name}${event.modifiers.map((modifier) => `.${modifier}`).join("")}=${attributeValue(handler)}`);
    }
  }
  if (node.ref !== undefined) {
    if (!context.refs.has(node.ref)) context.refs.set(node.ref, context.identifiers.take(`${node.ref}Element`, ""));
    attributes.push(`ref=${quote(node.ref)}`);
  }
  if (isRoot) {
    // The consumer's attributes win over the template's literals and lose to its bindings, as in
    // the runtime; Vue combines class and style itself.
    const tag = context.definition.contract.tag;
    literals.unshift(`data-component=${attributeValue(tag)}`);
    literals.push("v-bind=\"nativeAttrs($attrs)\"");
    if (context.validityValues !== undefined) {
      attributes.push(`v-prop-validity=${bound(`{ contract: propValidityContract, values: ${context.validityValues} }`)}`);
    }
    for (const { propName, attributeName, existing } of reflected) {
      const value = /^[A-Za-z_$][\w$]*$/.test(propName) ? `checkedProps.${propName}` : `checkedProps[${quote(propName)}]`;
      const fallback = existing?.kind === "literal" ? quote(existing.value) : "undefined";
      const type = normalizeType(context.definition.contract.props[propName]!.type);
      const separator = type.kind === "separated-list" ? `, ${quote(type.separator === "space" ? " " : ", ")}` : "";
      attributes.push(`:${attributeName}=${bound(`reflectedProp(${quote(propName)}, ${quote(kebabCase(propName))}, ${value}, ${fallback}, ${existing?.kind === "attribute"}${separator})`)}`);
    }
    // Keep the Vue-facing modelValue/update:modelValue API, but use native control semantics below.
    if (context.model && nativeControl && !twoWayControl) {
        const event = node.name === "select" || node.name === "input" && node.attributes.some((entry) => entry.kind === "literal" && entry.name === "type" && ["checkbox", "radio", "file"].includes(entry.value))
          ? "change" : "input";
        const control = "($event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)";
        attributes.push(`v-bind-control=${bound(`{ tag: ${quote(node.name)}, name: 'value', value: model, ${authoredDefault("value")} }`)}`);
        attributes.push(`@${event}=${bound(`model = readBoundControl(${control}) as any`)}`);
    }
    if (context.hostState) attributes.push(`:${stateAttribute(tag)}="hostState || undefined"`);
    if (context.root && node.ref === undefined) attributes.push(`ref=${quote(context.rootArmRef ?? "root")}`);
  }
  // A <template> without structural flow produces its content with no wrapper element.
  if (node.name === "template" && !isRoot) return content ?? renderChildren(node.children, names, context);
  attributes.unshift(...directives, ...literals);
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const renderedChildren = content ?? renderChildren(node.children, names, context, component ? node.name : undefined);
  const selectBinding = node.name === "select" && twoWayControl
    ? node.attributes.find((attribute) => attribute.kind === "attribute" && attribute.twoWay === true && attribute.name === "value")
    : undefined;
  const selectProperty = node.name === "select"
    ? node.attributes.find((attribute) => attribute.kind === "property" && attribute.name === "value")
    : undefined;
  const selectedValue = selectBinding?.kind === "attribute" && selectBinding.writablePath !== undefined
    ? writableTarget(selectBinding.writablePath, names.template, lowering)
    : selectProperty?.kind === "property"
      ? `String(${lowering.value(ast(selectProperty.expressionPlan, selectProperty.expression), names.template)})`
      : "model";
  const multipleBinding = node.name === "select"
    ? node.attributes.find((attribute) => attribute.name === "multiple")
    : undefined;
  const selectedMultiple = multipleBinding?.kind === "literal" ? "true"
    : multipleBinding?.kind === "attribute"
      ? lowering.condition(ast(multipleBinding.expressionPlan, multipleBinding.expression), names.template)
      : multipleBinding?.kind === "property"
        ? `Boolean(${lowering.value(ast(multipleBinding.expressionPlan, multipleBinding.expression), names.template)})`
        : "false";
  // SelectedOptions marks authored and slotted options for SSR without making Vue's
  // v-model the owner of the live control value.
  const children = node.name === "select" && (selectProperty !== undefined ||
    twoWayControl || isRoot && context.model)
    ? `<SelectedOptions :value=${bound(selectedValue)} :multiple=${bound(selectedMultiple)} :native-property=${bound(selectProperty !== undefined && !twoWayControl ? "true" : "false")}>${renderedChildren}</SelectedOptions>`
    : renderedChildren;
  // An empty component closes itself, as Vue's style guide has it.
  if (component && children === "") return `${open.slice(0, -1)} />`;
  return `${open}${children}</${name}>`;
}

/** A JavaScript predicate for a declared type, so event details are checked as the runtime checks them. */
function typeCheck(type: TypeNode, value: string): string {
  switch (type.kind) {
    case "terminal":
      switch (type.name) {
        case "string": return `typeof ${value} === "string"`;
        case "boolean": return `typeof ${value} === "boolean"`;
        case "number": return `(typeof ${value} === "number" && Number.isFinite(${value}))`;
        case "integer": return `Number.isInteger(${value})`;
        case "null": return `${value} === null`;
        case "absent": return `${value} === undefined`;
        case "function": return `typeof ${value} === "function"`;
        default: return "true";
      }
    case "keyword":
      return `${value} === ${JSON.stringify(type.value)}`;
    case "separated-list":
      return `(Array.isArray(${value}) && (${value} as unknown[]).every((item: unknown) => typeof item === "string"))`;
    case "union":
      return `(${type.members.map((member) => typeCheck(member, value)).join(" || ")})`;
    case "selected":
      return `(${type.options.map((option) => typeCheck(option.type, value)).join(" || ")})`;
    case "constrained":
      return type.values === undefined ? typeCheck(type.base, value)
        : `(${type.values.map((choice) => `${value} === ${JSON.stringify(choice)}`).join(" || ")})`;
    case "list":
      return `(Array.isArray(${value}) && (${value} as unknown[]).every((item: unknown) => ${typeCheck(type.item, "item")}))`;
    case "record":
      return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value}) && Object.values(${value} as object).every((item: unknown) => ${typeCheck(type.value, "item")}))`;
    case "object": {
      const fields = type.fields.map((field) => {
        const read = `(${value} as Record<string, unknown>)[${quote(field.name)}]`;
        const check = typeCheck(field.type, read);
        return field.optional ? `(${read} === undefined || ${check})` : check;
      });
      const closed = type.open ? [] : [`Object.keys(${value} as object).every((key) => ${JSON.stringify(type.fields.map((field) => field.name))}.includes(key))`];
      return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value})${[...fields, ...closed].map((check) => ` && ${check}`).join("")})`;
    }
  }
}

function handlerSource(handler: HandlerDeclaration, name: string, names: Names, events: readonly EventDeclaration[], context: Context): string {
  const { lowering } = context;
  const lines: string[] = [];
  const local = withLocal(names, [["event", UNKNOWN]]);
  const element = (ref: string): string => {
    if (!context.refs.has(ref)) context.refs.set(ref, context.identifiers.take(`${ref}Element`, ""));
    return context.refs.get(ref)!;
  };
  for (const step of handler.steps) {
    const guard = step.guard === undefined ? "" : `if (${lowering.condition(step.guard.ast, local.script)}) `;
    if (step.kind === "set") {
      lines.push(`  ${guard}${writableTarget(step.writablePath, local.script, lowering)} = ${lowering.value(step.value.ast, local.script)};`);
    } else if (step.kind === "dispatch") {
      const detail = step.value === undefined ? "" : `, ${lowering.value(step.value.ast, local.script)}`;
      const declaration = events.find((event) => event.name === step.event);
      if (declaration === undefined) fail("HT034", `Handler \`${handler.name}\` dispatches undeclared event \`${step.event}\`.`);
      lines.push(`  ${guard}dispatch(${quote(step.event)}${detail});`);
    } else if (step.kind === "focus") {
      lines.push(`  ${guard}${element(step.target)}.value?.focus();`);
    } else {
      lines.push(`  ${guard}(${element(step.target)}.value as HTMLInputElement | null)?.reportValidity?.();`);
    }
  }
  const parameter = lines.some((line) => /\bevent\b/.test(line)) ? "event?: Event" : "";
  return [`function ${name}(${parameter}): void {`, ...lines, "}"].join("\n");
}

/** One `data-<tag>-state` token source per styled name: the bare name when truthy, and name=value. */
function stateTokens(name: string, scope: Scope, lowering: Lowering): string[] {
  const node: ExpressionNode = { kind: "id", name };
  const type = typeOf(node, scope);
  const code = lowering.value(node, scope);
  const kind = category(type.type);
  const keywords = type.type.kind === "keyword" ? [type.type.value]
    : type.type.kind === "union" && type.type.members.every((member) => member.kind === "keyword")
      ? type.type.members.map((member) => (member as { value: string }).value)
      : undefined;
  if (kind === "boolean") return [`${code} && ${quote(name)}`];
  if (keywords !== undefined && keywords.every((keyword) => keyword !== "" && encodeURIComponent(keyword) === keyword)) {
    return [`${code} && \`${name} ${name}=\${${code}}\``];
  }
  if (kind === "string" || kind === "number") {
    const value = kind === "string" ? `encodeURIComponent(${code})` : code;
    return [`${code} && ${quote(name)}`, type.nullable ? `${code} != null && \`${name}=\${${value}}\`` : `\`${name}=\${${value}}\``];
  }
  const value = lowering.value(node, scope);
  return [
    `${lowering.condition(node, scope)} && ${quote(name)}`,
    `(typeof ${value} === "string" || typeof ${value} === "number") && \`${name}=\${encodeURIComponent(String(${value}))}\``,
  ];
}

export interface VueConversionOptions {
  /** Resolve projected slot props from the receiving component, including names shadowing consumer state. */
  readonly slotsByTag?: ReadonlyMap<string, readonly SlotContract[]>;
  /** Original controller resource before the public converter relocates its module. */
  readonly controllerSpecifier?: string;
  /** Emit the live runtime's nested-component lowering bound for a graph that can exceed it. */
  readonly guardNestedDepth?: boolean;
}

export function generateVue(definition: ComponentDefinition, version: string, options: VueConversionOptions = {}): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const generics = selectorGenerics(contract.props);
  const parameters = new Map(generics.map(({ from, parameter }) => [from, parameter]));
  const propType = (prop: (typeof target.props)[number]): string =>
    parameters.get(prop.name) ?? dependentPropTypeSource(prop.contract, parameters);
  const selectedNode = (prop: (typeof target.props)[number]): string =>
    prop.contract.select === undefined
      ? JSON.stringify(normalizeType(prop.contract.type))
      : `selectedPropNode(${contract.props[prop.contract.select.from] === undefined
        ? `${stateNames.get(states.find((state) => state.name === prop.contract.select!.from)!)}.value`
        : `props[${quote(prop.contract.select.from)}]`}, ${JSON.stringify(prop.contract.select.options)})`;
  const declarations = definition.declarations ?? [];
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const hasStateSelected = target.props.some((prop) => prop.contract.select !== undefined &&
    contract.props[prop.contract.select.from] === undefined);
  const data = declarations.filter((declaration): declaration is DataDeclaration => declaration.kind === "data");
  const computedValues = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const contexts = declarations.filter((declaration) => declaration.kind === "context");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const events = declarations.filter((declaration): declaration is EventDeclaration => declaration.kind === "event");
  const arms = rootArms(template);
  if (template.flow !== undefined && arms === undefined && template.flow.kind !== "with" && !(template.flow.kind === "match" && template.name !== "template")) {
    fail("HT021", `A component root must always select exactly one native or delegated element.`);
  }

  // A native form-control root with a `value` prop exposes Vue's component v-model API.
  // Its underlying element uses the HTML Next native-control bridge, not Vue's v-model directive.
  const modelProp = ["input", "textarea", "select"].includes(template.name)
    ? target.props.find((prop) => prop.name === "value")
    : undefined;
  const identifiers = new Identifiers(target.props.map((prop) => prop.name));
  const lowering = new Lowering();
  const templateScope = { code: new Map<string, string>(), types: new Map<string, Static>() };
  const script = { code: new Map<string, string>(), types: new Map<string, Static>() };
  const names: Names = { template: templateScope, script };
  const define = (name: string, templateCode: string, scriptCode: string, type: Static): void => {
    templateScope.code.set(name, templateCode);
    script.code.set(name, scriptCode);
    templateScope.types.set(name, type);
    script.types.set(name, type);
  };
  for (const prop of target.props) {
    const identifier = /^[A-Za-z_$][\w$]*$/.test(prop.name);
    const read = prop === modelProp
      ? "(checkedProps.value.modelValue ?? checkedProps.value.value)"
      : identifier ? `checkedProps.value.${prop.name}` : `checkedProps.value[${quote(prop.name)}]`;
    const templateRead = prop === modelProp ? "(checkedProps.modelValue ?? checkedProps.value)"
      : identifier ? `checkedProps.${prop.name}` : `checkedProps[${quote(prop.name)}]`;
    const type = present(normalizeType(prop.contract.type));
    define(prop.name, templateRead, read, { type: type.type, nullable: type.nullable || !prop.contract.required || prop === modelProp, null: !prop.contract.required || prop === modelProp });
  }
  const stateNames = new Map<ReactiveDeclaration, string>();
  for (const state of states) {
    const name = identifiers.take(state.name, "State");
    stateNames.set(state, name);
    const inferred = state.expression === undefined ? UNKNOWN : typeOf(state.expression.ast, script);
    const declaredNode = declarationTypeNode(state.type, state.shape);
    const declared = declaredNode === undefined ? undefined : present(declaredNode);
    // A declared type wins; an absent initial value keeps the state nullable.
    const initial = declared === undefined ? UNKNOWN : { type: declared.type, nullable: declared.nullable || inferred === UNKNOWN, null: (declared.null ?? false) || inferred === UNKNOWN };
    define(state.name, name, `${name}.value`, initial);
  }
  const dataNames = new Map<DataDeclaration, string>();
  for (const declaration of data) {
    const name = identifiers.take(declaration.name, "Data");
    dataNames.set(declaration, name);
    const payload = declaration.type === undefined ? UNKNOWN.type
      : declaration.type === "text" ? { kind: "terminal", name: "string" } as const
      : parseTypeExpression(declaration.type);
    define(declaration.name, name, `${name}.value`, { type: { kind: "object", open: false, fields: [
      { name: "pending", type: { kind: "terminal", name: "boolean" }, optional: false },
      { name: "value", type: { kind: "union", members: [payload, { kind: "terminal", name: "null" }] }, optional: false },
      { name: "error", type: UNKNOWN.type, optional: false },
      { name: "ok", type: { kind: "terminal", name: "boolean" }, optional: false },
    ] }, nullable: false });
  }
  for (const value of computedValues) {
    const name = identifiers.take(value.name, "Computed");
    stateNames.set(value, name);
    define(value.name, name, `${name}.value`, value.expression === undefined ? UNKNOWN : typeOf(value.expression.ast, script));
  }
  const contextNames = new Map(contexts.map((declaration) => [declaration, identifiers.take(declaration.as ?? declaration.name, "Context")]));
  for (const declaration of contexts) {
    const name = contextNames.get(declaration)!;
    define(declaration.as ?? declaration.name, name, `${name}.value`, UNKNOWN);
  }
  const handlerNames = new Map(handlers.map((handler) => [handler.name, identifiers.take(handler.name, "Handler")]));

  const selectorStateNames = new Set(target.props.flatMap((prop) => {
    const source = prop.contract.select?.from;
    return source !== undefined && contract.props[source] === undefined ? [source] : [];
  }));
  const validityValues = target.props.length === 0 ? undefined : [
    "{ ...checkedProps",
    ...[...selectorStateNames].map((name) => {
      const state = states.find((candidate) => candidate.name === name)!;
      return `, ${propKey(name)}: ${stateNames.get(state)}`;
    }),
    " }",
  ].join("");

  const styles = compileComponentStylesForVue(definition.css, definition);
  const controlled = definition.controller !== undefined;
  const dispatches = events.length > 0 || controlled;
  const needsRoot = dispatches || arms !== undefined;
  const context: Context = {
    definition,
    ...(options.slotsByTag === undefined ? {} : { slotsByTag: options.slotsByTag }),
    lowering,
    imports: new Set(),
    refs: new Map(),
    identifiers,
    handlers: handlerNames,
    root: needsRoot,
    ...(arms === undefined ? {} : { rootArmRef: "@html-next/root" }),
    hostState: styles.stateNames.length > 0,
    model: modelProp !== undefined,
    ...(validityValues === undefined ? {} : { validityValues }),
    guarded: [],
    globals: new Set(script.code.keys()),
    usesHtml: false,
    usesHydrationControl: false,
    usesKeyedBoundary: false,
  };
  // A root `$with` always renders one element. Keep its alias reactive in setup instead of
  // adding a v-for fragment around the component's native root.
  const rootWith = template.flow?.kind === "with" ? template.flow : undefined;
  const rootWithValue = rootWith === undefined ? undefined : ast(rootWith.expressionPlan, rootWith.expr);
  const rootWithName = rootWith === undefined ? undefined : identifiers.take("rootWith", "");
  const rootNames: Names = rootWith === undefined ? names : (() => {
    const local = withLocal(names, [[rootWith.alias, typeOf(rootWithValue!, names.template)]]);
    return {
      ...local,
      template: { ...local.template, code: new Map([...local.template.code, [rootWith.alias, rootWithName!] as const]) },
      script: { ...local.script, code: new Map([...local.script.code, [rootWith.alias, `${rootWithName}.value`] as const]) },
    };
  })();
  // A root `$match` is a v-if chain of native roots, which Vue treats as a single root.
  const rootMarkup = arms !== undefined
    ? arms.map((arm, index) => {
      const flow = arm.flow!;
      const directive = flow.kind === "when"
        ? `${index === 0 ? "v-if" : "v-else-if"}=${bound(lowering.condition(ast(flow.testPlan, flow.test), names.template))}`
        : "v-else";
      return renderElement(arm, names, context, true, [directive]);
    }).join("\n")
    : renderElement(elementMatchRoot(template), rootNames, context, true);
  const hydrationExpectedTag = arms === undefined ? quote(elementMatchRoot(template).name)
    : arms.reduceRight((fallback, arm) => {
      const flow = arm.flow!;
      if (flow.kind === "else") return quote(arm.name);
      if (flow.kind !== "when") fail("HT018", `A root $match child in <${contract.tag}> must be a $when or $else arm.`);
      const test = lowering.condition(ast(flow.testPlan, flow.test), names.script);
      return `(${test}) ? ${quote(arm.name)} : (${fallback})`;
    }, "undefined");
  const hydrationInstanceName = identifiers.take("hydrationInstance", "");
  const hydrationNodeName = identifiers.take("hydrationNode", "");
  const nestedDepthName = options.guardNestedDepth ? identifiers.take("nestedDepth", "") : undefined;
  const nestedDepthLimit = nestedDepthName === undefined ? undefined : definitionMayInvokeComponents(definition) ? 32 : 33;
  const hydrationMessage = `Server markup for <${contract.tag}> has an incompatible root.`;
  const rootArmRefs = arms === undefined ? [] : [...new Set(arms.map((arm) => arm.ref ?? context.rootArmRef!))];
  const unnamedRootRef = rootArmRefs.includes(context.rootArmRef ?? "")
    ? identifiers.take("rootArmElement", "") : undefined;
  const rootValues = rootArmRefs.map((name) => name === context.rootArmRef ? unnamedRootRef! : context.refs.get(name)!);
  const reflectsProps = rootMarkup.includes("reflectedProp(");
  // Runtime declarations deliberately use `type: null`: Vue's Boolean casting and type warnings
  // would otherwise change HTML Next's absent/bare-attribute and diagnostic semantics. Every
  // declared optional prop has a default (authored or null), so its resolved type excludes undefined.
  // The separate optional modelValue has no default and retains undefined.
  const optionalType = (source: string, required: boolean): string => required ? source
    : `${source.includes(" extends ") ? `(${source})` : source} | undefined`;
  const propDefinitions = target.props.map((prop) =>
    `  ${propKey(prop.name)}: { type: null as unknown as PropType<${propType(prop)}>${"default" in prop.contract ? `, default: ${defaultSource(prop.contract.default)}` : prop.contract.required ? "" : ", default: null"} },`);
  if (modelProp !== undefined) propDefinitions.push(`  modelValue: { type: null as unknown as PropType<${optionalType(propType(modelProp), false)}> },`);
  const checkedPropSources = target.props.map((prop) => {
    const type = prop.contract.select === undefined
      ? parameters.get(prop.name) ?? (prop.contract.values === undefined ? typeSource(prop.contract.type)
        : prop.contract.values.map((value) => JSON.stringify(value)).join(" | "))
      : propType(prop);
    const checked = `checkedProp<${type}>(props[${quote(prop.name)}], ${selectedNode(prop)}, ${prop.contract.required}, ${quote(prop.name)})`;
    const value = !prop.contract.required && "default" in prop.contract ? `${checked} as ${type}` : checked;
    return hasStateSelected ? `  get ${propKey(prop.name)}() { return ${value}; },`
      : `  ${propKey(prop.name)}: ${value},`;
  });
  if (modelProp !== undefined) checkedPropSources.push(
    `  modelValue: checkedProp<${propType(modelProp)}>(props.modelValue, ${selectedNode(modelProp)}, false, "modelValue"),`);
  // An event whose detail reports a prop's new value (query-change's { query }, open and close's
  // { open }) also updates that prop, so Vue consumers can write v-model:query and v-model:open.
  const modeled = target.props.filter((prop) => prop !== modelProp && events.some((event) => {
    const detail = declarationTypeNode(event.type, event.shape)!;
    return detail.kind === "object" && detail.fields.some((field) => field.name === prop.name);
  }));
  const emits = [
    ...modeled.map((prop) => `  ${quote(`update:${prop.name}`)}: [value: ${typeSource(prop.contract.type)}];`),
    ...(modelProp === undefined ? [] : [`  "update:modelValue": [value: ${modelProp.contract.select === undefined ? "string" : propType(modelProp)}];`]),
    ...events.map((event) => `  ${quote(event.name)}: [event: CustomEvent<${typeScriptType(declarationTypeNode(event.type, event.shape)!)}>];`),
  ];
  const handlerSources = handlers.map((handler) => handlerSource(handler, handlerNames.get(handler.name)!, names, events, context));

  // One check per distinct declared detail type, named once and shared by the events that declare it.
  const checkSources: string[] = [];
  const checkNames = new Map<EventDeclaration, string>();
  const checksBySource = new Map<string, string>();
  for (const event of events) {
    const source = typeCheck(declarationTypeNode(event.type, event.shape)!, "detail").replace(/^\((.*)\)$/s, "$1");
    let name = checksBySource.get(source);
    if (name === undefined) {
      name = identifiers.take(`is${pascal(event.name)}Detail`, "Check");
      checksBySource.set(source, name);
      checkSources.push(`const ${name} = (detail: unknown): boolean => ${source};`);
    }
    checkNames.set(event, name);
  }
  // createDispatch already dispatches a bubbling, composed, uncancelable event; only an event that
  // differs from that needs to declare its own init.
  const declared = events.filter((event) => !(event.bubbles && event.composed && !event.cancelable));
  const dispatchSource = events.length === 0 ? "const dispatch = createDispatch(root);" : [
    "const dispatch = createDispatch(root, emit as (name: string, detail: unknown) => void, {",
    ...(declared.length === 0 ? [] : [
      `  declared: ${JSON.stringify(Object.fromEntries(declared.map((event) => [event.name, { bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable }])))},`,
    ]),
    "  checks: {",
    ...events.map((event) => `    ${propKey(event.name)}: ${checkNames.get(event)},`),
    "  },",
    ...(modeled.length === 0 ? [] : [`  modeled: [${modeled.map((prop) => quote(prop.name)).join(", ")}],`]),
    "});",
  ].join("\n");
  const stateSource = (declaration: ReactiveDeclaration): string => {
    const name = stateNames.get(declaration)!;
    const initial = declaration.expression === undefined ? "null" : lowering.value(declaration.expression.ast, script);
    if (declaration.kind === "computed") {
      const guard = declaration.expression === undefined ? undefined : expressionGuard(declaration.expression, script, definition);
      if (guard !== undefined) return `let ${name}Previous: any;\nconst ${name} = cycleCheckedComputed(() => { if (!(${guard})) return ${name}Previous; return ${name}Previous = ${initial}; });`;
      return `const ${name} = cycleCheckedComputed(() => ${initial});`;
    }
    const type = script.types.get(declaration.name)!;
    // Scalars infer their own type; structured and unknown initial values declare what they hold.
    const plain = ["boolean", "string", "number"].includes(category(type.type)) && !type.nullable;
    return `const ${name} = ref${plain ? "" : `<${typeScript(type)}>`}(${initial});`;
  };
  const dataSource = (declaration: DataDeclaration): string[] => {
    const name = dataNames.get(declaration)!;
    const lines = [`const ${name} = ref<${typeScript(script.types.get(declaration.name)!)}>({ pending: true, value: null, error: null, ok: false });`];
    if (declaration.source !== undefined) {
      const parameters = declaration.parameters.map((parameter) =>
        `${propKey(parameter.name)}: ${lowering.value(parameter.expression.ast, script)}`).join(", ");
      const sources = declaration.parameters.filter((parameter) => parameter.mode === "from")
        .map((parameter) => lowering.value(parameter.expression.ast, script)).join(", ");
      lines.push(`useDataRead(${name}, { source: ${quote(declaration.source)}, definition: ${quote(definition.source.file)}, ${declaration.type === undefined ? "" : `type: ${quote(declaration.type)}, `}${declaration.debounce === undefined ? "" : `debounce: ${parseDuration(declaration.debounce)}, `}${declaration.poll === undefined ? "" : `poll: ${parseDuration(declaration.poll)}, `}sources: () => [${sources}], parameters: () => ({ ${parameters} }) });`);
    }
    return lines;
  };

  const body: string[] = [];
  body.push(
    ...(nestedDepthName === undefined ? [] : [
      `const ${nestedDepthName} = inject<number>('html-next:nested-depth', 0);`,
      `if (${nestedDepthName} >= ${nestedDepthLimit}) {`,
      "  const message = 'Component invocations nested deeper than the lowering limit.';",
      "  throw Object.assign(new Error(`HR008: ${message}`), { name: 'HtmlDiagnosticError', diagnostic: Object.freeze({ code: 'HR008', message }) });",
      "}",
      `provide('html-next:nested-depth', ${nestedDepthName} + 1);`,
    ]),
    ...(target.props.length === 0 ? [] : [
      `const propValidityContract = ${JSON.stringify({ props: Object.fromEntries(Object.entries(contract.props).map(([name, prop]) => [name, { ...prop, type: normalizeType(prop.type) }])) })};`,
      "const props = defineProps({",
      ...propDefinitions,
      "});",
      "const checkedProps = computed(() => ({",
      ...checkedPropSources,
      "}));",
      ...(hasStateSelected ? [] : ["void checkedProps.value;", "watchSyncEffect(() => { void checkedProps.value; });"]),
    ]),
    "function nativeAttrs(attrs: Record<string, unknown>): Record<string, unknown> {",
    "  const names = Object.keys(attrs);",
    "  if (!names.some((name) => Object.hasOwn(Object.prototype, name))) return attrs;",
    "  return Object.fromEntries(names.map((name) => [",
    "    Object.hasOwn(Object.prototype, name) ? name === '__proto__' ? '__Proto__' : name[0]!.toUpperCase() + name.slice(1) : name,",
    "    attrs[name],",
    "  ]));",
    "}",
    ...(context.usesKeyedBoundary ? [
      "const KeyedFailure = defineComponent({",
      "  props: { error: { type: null, required: true } },",
      "  setup(props) { return () => { throw props.error; }; },",
      "});",
      "const KeyedBoundary = defineComponent({",
      "  setup(_props, { slots }) {",
      "    let last: VNode[] = [];",
      "    return () => {",
      "      try { last = slots.default?.() ?? []; return last; }",
      "      catch (error) {",
      "        if (!(error instanceof Error) || (error as Error & { diagnostic?: { code?: string } }).diagnostic?.code !== 'HR004') throw error;",
      "        if (typeof window === 'undefined') throw error;",
      "        return [...last, h(KeyedFailure, { error })];",
      "      }",
      "    };",
      "  },",
      "});",
    ] : []),
    ...(!reflectsProps ? [] : [
      "const componentInstance = getCurrentInstance();",
      "function reflectedProp(name: string, kebab: string, value: unknown, fallback: string | undefined, bound: boolean, separator?: string): string | undefined {",
      "  const incoming = componentInstance?.vnode.props;",
      "  if (!bound && (incoming === null || incoming === undefined || (!Object.hasOwn(incoming, name) && !Object.hasOwn(incoming, kebab)))) return fallback;",
      "  if (value === null || value === undefined) return undefined;",
      "  return Array.isArray(value) && separator !== undefined ? value.join(separator) : typeof value === 'object' ? JSON.stringify(value) : String(value);",
      "}",
    ]),
    `const ${hydrationInstanceName} = getCurrentInstance();`,
    ...(emits.length === 0 ? [] : ["const emit = defineEmits<{", ...emits, "}>();"]),
    ...(modelProp === undefined ? [] : [
      "const model = computed({",
      "  get: () => checkedProps.value.modelValue ?? checkedProps.value.value ?? undefined,",
      `  set: (value) => emit("update:modelValue", value as ${modelProp === undefined || modelProp.contract.select === undefined ? "string" : propType(modelProp)}),`,
      "});",
    ]),
    "",
    ...(arms === undefined && needsRoot && template.ref === undefined ? ["const root = ref<HTMLElement | null>(null);"] : []),
    ...(unnamedRootRef === undefined ? [] : [`const ${unnamedRootRef} = useTemplateRef<HTMLElement>(${quote(context.rootArmRef!)});`]),
    ...[...context.refs].map(([ref, name]) => `const ${name} = useTemplateRef<HTMLElement>(${quote(ref)});`),
    ...(arms === undefined && needsRoot && template.ref !== undefined ? [`const root = ${context.refs.get(template.ref)!};`] : []),
    ...(arms === undefined ? [] : [`const root = ${rootValues.length === 1 ? rootValues[0] : `computed(() => ${rootValues.map((name) => `${name}.value`).join(" ?? ")} ?? null)`};`]),
    ...(arms === undefined ? [] : ["preserveRootFocus(root);"]),
    ...(computedValues.length === 0 ? [] : [
      "// Vue may return an in-progress computed value on a cyclic read; guard the public value access instead.",
      "function cycleCheckedComputed<T>(evaluate: () => T) {",
      "  const value = computed(evaluate);",
      "  let reading = false;",
      "  return new Proxy(value, {",
      "    get(target, property) {",
      "      if (property !== 'value') return Reflect.get(target, property);",
      "      if (reading) {",
      "        const message = 'A reactive computed value depends on itself.';",
      "        throw Object.assign(new Error(`HR006: ${message}`), { name: 'HtmlDiagnosticError', diagnostic: Object.freeze({ code: 'HR006', message }) });",
      "      }",
      "      reading = true;",
      "      try { return target.value; } finally { reading = false; }",
      "    },",
      "  });",
      "}",
    ]),
    ...states.map(stateSource),
    ...(hasStateSelected ? [
      ...target.props.map((prop) => `void checkedProps.value[${quote(prop.name)}];`),
      "watchSyncEffect(() => {",
      ...target.props.map((prop) => `  void checkedProps.value[${quote(prop.name)}];`),
      "});",
    ] : []),
    ...data.flatMap(dataSource),
    ...computedValues.map(stateSource),
    ...(rootWith === undefined ? [] : [`const ${rootWithName} = computed(() => ${lowering.value(rootWithValue!, names.script)});`]),
    ...context.guarded,
    ...states.map((state) =>
      `provide(${quote(`html-next:${contract.tag}:${state.name}`)}, ${stateNames.get(state)!});`),
    ...contexts.flatMap((declaration) => {
      const name = contextNames.get(declaration)!;
      const message = `<${contract.tag}> requires context \`${declaration.name}\` from <${declaration.from}>.`;
      return [
        `const ${name} = inject<any>(${quote(`html-next:${declaration.from}:${declaration.name}`)});`,
        `if (${name} === undefined) throw Object.assign(new Error(${quote(`HR009: ${message}`)}), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR009", message: ${quote(message)} }) });`,
      ];
    }),
    ...(!(definition.slots ?? []).some((slot) => (slot.props?.length ?? 0) > 0) ? [] : [
      "const projectedSlots = useSlots();",
      "function scopedSlotName(value: unknown): string {",
      "  const name = value == null ? '' : String(value);",
      "  if (projectedSlots[name] === undefined && projectedSlots.default?.().some((node) => node.props?.slot === name)) {",
      "    const message = 'Scoped slot `' + name + '` requires a consumer <template slot=\"' + name + '\">.';",
      "    throw Object.assign(new Error(`HR007: ${message}`), { name: 'HtmlDiagnosticError', diagnostic: Object.freeze({ code: 'HR007', message }) });",
      "  }",
      "  return name;",
      "}",
    ]),
    `const ${hydrationNodeName} = ${hydrationInstanceName}?.vnode.el;`,
    `if (typeof window !== "undefined" && ${hydrationNodeName} != null && (!(${hydrationNodeName} instanceof Element) || ${hydrationNodeName}.localName !== (${hydrationExpectedTag}))) {`,
    `  throw Object.assign(new Error(${quote(`HR005: ${hydrationMessage}`)}), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR005", message: ${quote(hydrationMessage)} }) });`,
    "}",
    ...(styles.stateNames.length === 0 ? [] : [
      "",
      "/** The values the styles' :host-state() rules test. */",
      "const hostState = computed(() => [",
      ...styles.stateNames.flatMap((name) => stateTokens(name, script, lowering)).map((token) => `  ${token},`),
      "].filter(Boolean).join(\" \"));",
    ]),
    ...(!dispatches ? [] : ["", ...checkSources, dispatchSource]),
    ...handlerSources.flatMap((source) => ["", source]),
    "",
    ...hostSource(definition, target.methods, {
      props: target.props.length > 0,
      refs: context.refs,
      state: new Map(states.map((state) => [state.name, stateNames.get(state)!])),
      computed: new Map(computedValues.map((value) => [value.name, stateNames.get(value)!])),
    }, options.controllerSpecifier ?? definition.controller),
    ...lowering.fallbacks().flatMap((source) => ["", source]),
  );
  // `props` is named only when the script reads it; the template reads props by name.
  if (!body.some((line) => /\bprops\b/.test(line) && !line.startsWith("const props = ")) && !/\bprops\b/.test(rootMarkup)) {
    const index = body.findIndex((line) => line.startsWith("const props = "));
    if (index !== -1) body[index] = body[index]!.replace("const props = ", "");
  }
  const code = `${body.join("\n")}\n${rootMarkup}`;
  const apis = VUE_APIS.filter((api) => new RegExp(`\\b${api}[<(]`).test(code));
  // The shared module holds what every component's host and dispatcher do the same way.
  const shared = ["createDispatch", "useComponentHost", "useDataRead", "runFilteredEvent", "preserveRootFocus"]
    .filter((name) => code.includes(`${name}(`));
  const vueTypes = [
    ...(target.props.length === 0 ? [] : ["PropType"]),
    ...(context.usesKeyedBoundary ? ["VNode"] : []),
  ];
  const lines: string[] = [
    `<!-- Generated by HTML Next ${version} for Vue 3.5. Do not edit. -->`,
    `<script setup lang="ts"${generics.length === 0 ? "" : ` generic="${generics.map(({ declaration }) => declaration.replaceAll('"', "'")).join(", ")}"`}>`,
    ...(apis.length === 0 ? [] : [`import { ${apis.join(", ")} } from "vue";`]),
    ...(vueTypes.length === 0 ? [] : [`import type { ${vueTypes.join(", ")} } from "vue";`]),
    ...(target.props.length === 0 ? [] : [`import { checkedProp, vPropValidity${target.props.some((prop) => prop.contract.select !== undefined) ? ", selectedPropNode" : ""} } from ${quote(VUE_PROPS_SPECIFIER)};`]),
    ...(shared.length === 0 ? [] : [`import { ${shared.join(", ")} } from ${quote(VUE_HOST_SPECIFIER)};`]),
    ...(context.usesHtml ? [`import { SanitizedHtml } from ${quote(VUE_HTML_SPECIFIER)};`] : []),
    ...(context.usesHydrationControl ? [`import { ${[
      ...(rootMarkup.includes("readBoundControl(") ? ["readBoundControl"] : []),
      ...(rootMarkup.includes("v-bind-control=") ? ["vBindControl"] : []),
      ...(rootMarkup.includes("<SelectedOptions ") ? ["SelectedOptions"] : []),
    ].join(", ")} } from ${quote(VUE_CONTROL_SPECIFIER)};`] : []),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(`./${componentName(tag)}.vue`)};`),
    "",
    "defineOptions({ inheritAttrs: false });",
    "",
    ...body,
    "</script>",
    "",
    "<template>",
    rootMarkup,
    "</template>",
  ];
  if (styles.css !== "") lines.push("", "<style scoped>", styles.css, "</style>");
  const source = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/(?<=<script setup lang="ts">\n)\n/, "").replace(/\n\n(?=<\/script>)/, "\n")}\n`;
  return formatVue(source, `${componentName(contract.tag)}.vue`);
}

function defaultSource(value: unknown): string {
  // Vue requires factories for object and array defaults.
  return value !== null && typeof value === "object" ? `() => (${JSON.stringify(value)})` : JSON.stringify(value);
}

/** The controller host and the methods it exposes: the shared module holds everything repeated. */
function hostSource(
  definition: ComponentDefinition,
  methods: ReturnType<typeof targetComponent>["methods"],
  values: {
    readonly props: boolean;
    readonly refs: ReadonlyMap<string, string>;
    readonly state: ReadonlyMap<string, string>;
    readonly computed: ReadonlyMap<string, string>;
  },
  controllerSpecifier?: string,
): string[] {
  if (definition.controller === undefined) {
    return methods.length === 0 ? [] : [
      `defineExpose({ ${methods.map((method) => `${propKey(method.name)}: () => Promise.reject(new TypeError(${quote(`Controller method \`${method.name}\` is not ready for <${definition.contract.tag}>.`)}))`).join(", ")} });`,
    ];
  }
  const record = (entries: ReadonlyMap<string, string>): string =>
    `{ ${[...entries].map(([name, identifier]) => name === identifier ? name : `${propKey(name)}: ${identifier}`).join(", ")} }`;
  const call = [
    `useComponentHost(() => import(${quote(definition.controller)}), {`,
    "  root,",
    "  dispatch,",
    `  controllerSource: { specifier: ${quote(controllerSpecifier ?? definition.controller!)}, definition: ${quote(definition.source.file)} },`,
    ...(values.props ? ["  props: checkedProps,"] : []),
    ...(values.refs.size === 0 ? [] : [`  refs: ${record(values.refs)},`]),
    ...(values.state.size === 0 ? [] : [`  state: ${record(values.state)},`]),
    ...(values.computed.size === 0 ? [] : [`  computed: ${record(values.computed)},`]),
    "})",
  ].join("\n");
  if (methods.length === 0) return [`${call};`];
  return [
    `const { host, ready } = ${call};`,
    "",
    "defineExpose({",
    ...methods.map((method) => {
      const message = `Controller does not export method \`${method.exportName}\`.`;
      return `  ${propKey(method.name)}: async (...args: unknown[]) => { const controllerModule = await ready(); if (controllerModule === undefined) throw new TypeError(${quote(`Controller method \`${method.name}\` is not ready for <${definition.contract.tag}>.`)}); const method = Reflect.get(controllerModule, ${quote(method.exportName)}); if (typeof method !== "function") throw Object.assign(new Error(${quote(`HJ003: ${message}`)}), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HJ003", message: ${quote(message)} }) }); return method(host, ...args); },`;
    }),
    "});",
  ];
}

/** `query-change` as `QueryChange`, for a name derived from a declared event. */
function pascal(name: string): string {
  return name.replace(/(?:^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_match, character: string) => character.toUpperCase());
}
