/**
 * Converts a definition to a Vue 3.5 single-file component that depends only on Vue and the
 * component's own modules. Props, state, computed values, bindings, structural directives, slots,
 * events, and methods map to Vue's own facilities; the controller receives a host generated here from
 * Vue refs, effects, and lifecycle; styles become `<style scoped>`.
 */
import { fail } from "../diagnostics.js";
import type { ExpressionNode } from "../expression.js";
import { componentName } from "../names.js";
import { getDomInterface } from "../platform.js";
import type {
  ComponentDefinition,
  ElementNode,
  EventDeclaration,
  HandlerDeclaration,
  ReactiveDeclaration,
  TemplateNode,
} from "../template.js";
import type { WritablePathSegment } from "../expression.js";
import postcss from "postcss";
import { compileComponentStylesForVue } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import { normalizeType, parseTypeExpression, type TypeNode } from "../type-system.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, propKey, propTypeSource, quote, typeSource } from "./shared.js";
import { category, Lowering, present, typeOf, typeScript, UNKNOWN, type Scope, type Static } from "./vue-lowering.js";

const VUE_APIS = ["computed", "onBeforeUnmount", "onMounted", "ref", "shallowRef", "useTemplateRef", "watchEffect"] as const;

/** Names the generated script defines itself, which declared names must not take. */
const RESERVED = new Set([
  "props", "emit", "root", "refs", "dispatch", "host", "hostState", "read", "write", "stops", "cleanup", "ready",
  "model", "controllerModule", "event", "element", "truthy", "text", "attribute", "list", "number", "sortBy",
  "String", "Boolean", "Number", "Math", "Object", "Array", "CustomEvent", "Promise", "Proxy", "TypeError",
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
  readonly lowering: Lowering;
  readonly imports: Set<string>;
  /** Template refs, by ref name, and the script variable holding each. */
  readonly refs: Map<string, string>;
  readonly identifiers: Identifiers;
  /** Handler script names, by declared name. */
  readonly handlers: ReadonlyMap<string, string>;
  /** Whether the root needs a Vue ref (for dispatch and the controller host). */
  readonly root: boolean;
  /** Whether the root is a native form control bound to the component's `v-model`. */
  readonly model: boolean;
  readonly hostState: boolean;
}

function isComponentTag(name: string): boolean {
  return name.includes("-") && getDomInterface(name) === undefined;
}

function renderChildren(nodes: readonly TemplateNode[], names: Names, context: Context): string {
  return nodes.map((child) => renderNode(child, names, context)).join("");
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
  return { template: scope(names.template), script: scope(names.script) };
}

function renderNode(node: TemplateNode, names: Names, context: Context): string {
  const { lowering } = context;
  if (node.kind === "text") return escapeHtml(node.value).replace(/\{\{/g, "{{ '{{' }}");
  if (node.kind === "slot") {
    const name = node.nameExpression !== undefined
      ? ` :name=${bound(lowering.value(ast(node.nameExpression, "slot name"), names.template))}`
      : node.name === undefined ? "" : ` name=${quote(node.name)}`;
    return `<slot${name}>${renderChildren(node.fallback ?? [], names, context)}</slot>`;
  }
  const flow = node.flow;
  if (flow?.kind === "each") {
    const listNode = ast(flow.listPlan, flow.list);
    const listType = typeOf(listNode, names.template);
    const itemType: Static = listType.type.kind === "list" ? { type: present(listType.type.item).type, nullable: false } : { ...UNKNOWN, nullable: false };
    const item = flow.item;
    const index = flow.index ?? "index";
    const local = withLocal(names, [[item, itemType], [index, { type: { kind: "terminal", name: "number" }, nullable: false }]]);
    const list = lowering.list(listNode, names.template, item, {
      ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
      itemScope: local.template,
      sort: (flow.sort ?? "").split(",").map((key) => key.trim()).filter(Boolean),
      ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }),
    });
    const key = flow.keyPlan === undefined ? index : lowering.value(flow.keyPlan.ast, local.template);
    const { flow: _flow, ...body } = node;
    const loop = flow.index === undefined && flow.keyPlan !== undefined ? item : `(${item}, ${index})`;
    return wrap(body, [`v-for=${bound(`${loop} in ${list}`)}`, `:key=${bound(key)}`], local, context);
  }
  if (flow?.kind === "with") {
    const value = ast(flow.expressionPlan, flow.expr);
    const { flow: _flow, ...body } = node;
    return `<template v-for=${bound(`${flow.alias} in [${lowering.value(value, names.template)}]`)}>${renderNode(body, withLocal(names, [[flow.alias, typeOf(value, names.template)]]), context)}</template>`;
  }
  if (flow?.kind === "match") {
    const value = flow.expr === undefined ? undefined : ast(flow.expressionPlan, flow.expr);
    const local = flow.alias === undefined ? names : withLocal(names, [[flow.alias, value === undefined ? UNKNOWN : typeOf(value, names.template)]]);
    const arms = node.children
      .filter((child): child is ElementNode => child.kind === "element" && (child.flow?.kind === "when" || child.flow?.kind === "else"))
      .map((arm, index) => {
        const { flow: armFlow, ...armBody } = arm;
        const test = armFlow?.kind === "when" ? lowering.condition(ast(armFlow.testPlan, armFlow.test), local.template) : undefined;
        const directive = test === undefined ? "v-else" : `${index === 0 ? "v-if" : "v-else-if"}=${bound(test)}`;
        return wrap(armBody, [directive], local, context);
      }).join("");
    const inner = node.name === "template" ? arms : `<${node.name}${literalAttributes(node)}>${arms}</${node.name}>`;
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

function literalAttributes(node: ElementNode): string {
  return node.attributes
    .filter((attribute) => attribute.kind === "literal")
    .map((attribute) => ` ${attribute.name}=${attributeValue((attribute as { value: string }).value)}`)
    .join("");
}

function renderElement(node: ElementNode, names: Names, context: Context, isRoot: boolean, directives: readonly string[] = []): string {
  const { lowering } = context;
  const component = isComponentTag(node.name);
  const name = component ? componentName(node.name) : node.name;
  if (component) context.imports.add(node.name);
  const literals: string[] = [];
  const attributes: string[] = [];
  const classes: string[] = [];
  const styles: string[] = [];
  let content: string | undefined;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      literals.push(`${attribute.name}=${attributeValue(attribute.value)}`);
    } else if (attribute.kind === "directive") {
      if (attribute.name === "html") fail("HT032", "`$html` is not supported in Vue conversion yet.");
      content = `{{ ${lowering.text(ast(attribute.expressionPlan, attribute.expression), names.template)} }}`;
    } else if (attribute.kind === "property") {
      const value = ast(attribute.expressionPlan, attribute.expression);
      const type = typeOf(value, names.template);
      // DOM property types are narrower than an absent or untyped HTML Next value.
      const code = lowering.value(value, names.template);
      attributes.push(`:${attribute.name}.prop=${bound(type.nullable || category(type.type) === "unknown" ? `${code} as any` : code)}`);
    } else if (attribute.target === "class") {
      classes.push(`${quote(attribute.name)}: ${lowering.condition(ast(attribute.expressionPlan, attribute.expression), names.template)}`);
    } else if (attribute.target === "style") {
      styles.push(`${quote(attribute.name)}: ${lowering.text(ast(attribute.expressionPlan, attribute.expression), names.template)}`);
    } else if (attribute.twoWay === true && attribute.writablePath !== undefined) {
      attributes.push(`v-model=${bound(writableTarget(attribute.writablePath, names.template, lowering))}`);
    } else if (isRoot && context.model && attribute.name === "value") {
      // The model supplies the root's value (below).
    } else {
      const value = ast(attribute.expressionPlan, attribute.expression);
      attributes.push(`:${attribute.name}=${bound(component ? lowering.value(value, names.template) : lowering.attribute(value, names.template, attribute.name))}`);
    }
  }
  if (classes.length > 0) attributes.push(`:class=${bound(`{ ${classes.join(", ")} }`)}`);
  if (styles.length > 0) attributes.push(`:style=${bound(`{ ${styles.join(", ")} }`)}`);
  for (const event of node.events ?? []) {
    const handler = context.handlers.get(event.handler);
    if (handler === undefined) fail("HT033", `Handler \`${event.handler}\` is not declared.`);
    attributes.push(`@${event.name}${event.modifiers.map((modifier) => `.${modifier}`).join("")}=${attributeValue(handler)}`);
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
    literals.push("v-bind=\"$attrs\"");
    // Vue's own v-model keeps a native control's value, a select's included, in step with the model.
    if (context.model) attributes.push('v-model="model"');
    if (context.hostState) attributes.push(`:${stateAttribute(tag)}="hostState || undefined"`);
    if (context.root) attributes.push("ref=\"root\"");
  }
  // A <template> without structural flow produces its content with no wrapper element.
  if (node.name === "template" && !isRoot) return content ?? renderChildren(node.children, names, context);
  attributes.unshift(...directives, ...literals);
  const open = `<${name}${attributes.length === 0 ? "" : ` ${attributes.join(" ")}`}>`;
  if (!component && isVoidElement(node.name)) return open;
  const children = content ?? renderChildren(node.children, names, context);
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
    case "union":
      return `(${type.members.map((member) => typeCheck(member, value)).join(" || ")})`;
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

export function generateVue(definition: ComponentDefinition, version: string): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const declarations = definition.declarations ?? [];
  if (declarations.some((declaration) => declaration.kind === "data")) {
    fail("HT035", `<${contract.tag}> declares <data>, which Vue conversion does not support yet.`);
  }
  const states = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "state");
  const computedValues = declarations.filter((declaration): declaration is ReactiveDeclaration => declaration.kind === "computed");
  const handlers = declarations.filter((declaration): declaration is HandlerDeclaration => declaration.kind === "handler");
  const events = declarations.filter((declaration): declaration is EventDeclaration => declaration.kind === "event");
  if (template.flow !== undefined) {
    fail("HT036", `<${contract.tag}> has a structural directive on its root, which Vue conversion does not support yet.`);
  }

  // A native form-control root with a `value` prop takes Vue's v-model: `modelValue` sets the value
  // and the control's input (change, for a select) reports it.
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
  // A prop with a default or marked required is present; others may be absent.
  const optional = (prop: (typeof target.props)[number]): boolean => !prop.contract.required && !("default" in prop.contract);
  for (const prop of target.props) {
    const identifier = /^[A-Za-z_$][\w$]*$/.test(prop.name);
    const read = prop === modelProp
      ? "(props.modelValue ?? props.value)"
      : identifier ? `props.${prop.name}` : `props[${quote(prop.name)}]`;
    // A template reads a prop by its name, as Vue exposes it.
    const templateRead = prop === modelProp ? "(modelValue ?? value)" : identifier && !RESERVED.has(prop.name) ? prop.name : read;
    const type = present(normalizeType(prop.contract.type));
    define(prop.name, templateRead, read, { type: type.type, nullable: type.nullable || optional(prop) || prop === modelProp });
  }
  const stateNames = new Map<ReactiveDeclaration, string>();
  for (const state of states) {
    const name = identifiers.take(state.name, "State");
    stateNames.set(state, name);
    const inferred = state.expression === undefined ? UNKNOWN : typeOf(state.expression.ast, script);
    const declared = state.type === undefined ? undefined : present(parseTypeExpression(state.type));
    // A declared type wins; an absent initial value keeps the state nullable.
    const initial = declared === undefined ? inferred : { type: declared.type, nullable: declared.nullable || inferred === UNKNOWN };
    define(state.name, name, `${name}.value`, initial);
  }
  for (const value of computedValues) {
    const name = identifiers.take(value.name, "Computed");
    stateNames.set(value, name);
    define(value.name, name, `${name}.value`, value.expression === undefined ? UNKNOWN : typeOf(value.expression.ast, script));
  }
  const handlerNames = new Map(handlers.map((handler) => [handler.name, identifiers.take(handler.name, "Handler")]));

  const styles = compileComponentStylesForVue(definition.css, definition);
  const controlled = definition.controller !== undefined;
  const dispatches = events.length > 0 || controlled;
  const context: Context = {
    definition,
    lowering,
    imports: new Set(),
    refs: new Map(),
    identifiers,
    handlers: handlerNames,
    root: dispatches,
    hostState: styles.stateNames.length > 0,
    model: modelProp !== undefined,
  };
  const rootMarkup = renderElement(template, names, context, true);
  const defaults = target.props.filter((prop) => "default" in prop.contract);
  // An optional prop is declared as Vue authors declare one, `name?: T`; absent is undefined.
  const propType = (prop: (typeof target.props)[number]): string => typeSource(prop.contract.type);
  const propsType = [
    "{",
    ...target.props.map((prop) => `  ${propKey(prop.name)}?: ${propType(prop)};`),
    ...(modelProp === undefined ? [] : [`  modelValue?: ${propTypeSource(modelProp.contract)};`]),
    "}",
  ].join("\n");
  const emits = [
    ...events.map((event) => {
      const typed = target.events.find((candidate) => candidate.name === event.name);
      return `  ${quote(event.name)}: [detail: ${typed?.detailType ?? "unknown"}];`;
    }),
    ...(modelProp === undefined ? [] : ['  "update:modelValue": [value: string];']),
  ];
  const handlerSources = handlers.map((handler) => handlerSource(handler, handlerNames.get(handler.name)!, names, events, context));
  const stateSource = (declaration: ReactiveDeclaration): string => {
    const name = stateNames.get(declaration)!;
    const initial = declaration.expression === undefined ? "undefined" : lowering.value(declaration.expression.ast, script);
    if (declaration.kind === "computed") return `const ${name} = computed(() => ${initial});`;
    const type = script.types.get(declaration.name)!;
    // Scalars infer their own type; structured and unknown initial values declare what they hold.
    const plain = ["boolean", "string", "number"].includes(category(type.type)) && !type.nullable;
    return `const ${name} = ref${plain ? "" : `<${typeScript(type)}>`}(${initial});`;
  };

  const body: string[] = [];
  body.push(
    ...(target.props.length === 0 ? [] : defaults.length === 0 ? [`const props = defineProps<${propsType}>();`] : [
      `const props = withDefaults(defineProps<${propsType}>(), {`,
      ...defaults.map((prop) => `  ${propKey(prop.name)}: ${defaultSource((prop.contract as { default: unknown }).default)},`),
      "});",
    ]),
    ...(emits.length === 0 ? [] : ["const emit = defineEmits<{", ...emits, "}>();"]),
    ...(modelProp === undefined ? [] : [
      "const model = computed({",
      "  get: () => props.modelValue ?? props.value ?? undefined,",
      '  set: (value) => emit("update:modelValue", value as string),',
      "});",
    ]),
    "",
    ...(dispatches ? ["const root = ref<HTMLElement | null>(null);"] : []),
    ...[...context.refs].map(([ref, name]) => `const ${name} = useTemplateRef<HTMLElement>(${quote(ref)});`),
    ...states.map(stateSource),
    ...computedValues.map(stateSource),
    ...(styles.stateNames.length === 0 ? [] : [
      "",
      "/** The values the styles' :host-state() rules test. */",
      "const hostState = computed(() => [",
      ...styles.stateNames.flatMap((name) => stateTokens(name, script, lowering)).map((token) => `  ${token},`),
      "].filter(Boolean).join(\" \"));",
    ]),
    ...(!dispatches ? [] : [
      "",
      "/** Dispatches a component event to Vue listeners and, for controllers and page code, on the root. */",
      "function dispatch(name: string, detail?: unknown): boolean {",
      ...(events.length === 0 ? [] : [
        `  const declared = ${JSON.stringify(Object.fromEntries(events.map((event) => [event.name, { bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable }])))} as Record<string, EventInit | undefined>;`,
        "  const checks: Record<string, (detail: unknown) => boolean> = {",
        ...events.map((event) => `    ${quote(event.name)}: (detail: unknown) => ${typeCheck(parseTypeExpression(event.type), "detail")},`),
        "  };",
        "  if (detail !== undefined && checks[name] !== undefined && !checks[name]!(detail)) {",
        "    throw new TypeError(`HR002: Event \\`${name}\\` detail does not satisfy its declared type.`);",
        "  }",
        "  (emit as (name: string, detail: unknown) => void)(name, detail);",
      ]),
      `  return root.value?.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, ${events.length === 0 ? "" : "...declared[name], "}detail })) ?? true;`,
      "}",
    ]),
    ...handlerSources.flatMap((source) => ["", source]),
    ...(!controlled ? [] : [
      "",
      "function read(name: string): unknown {",
      ...[...states, ...computedValues].map((declaration) => `  if (name === ${quote(declaration.name)}) return ${stateNames.get(declaration)}.value;`),
      target.props.length === 0 ? "  return undefined;" : "  return (props as Record<string, unknown>)[name];",
      "}",
      "",
      "function write(name: string, value: unknown): boolean {",
      ...states.map((state) => `  if (name === ${quote(state.name)}) { ${stateNames.get(state)}.value = value as never; return true; }`),
      "  throw new TypeError(`Only declared state is writable; \\`${name}\\` is not.`);",
      "}",
    ]),
    "",
    ...hostSource(definition, target.methods, context.refs),
    ...lowering.fallbacks().flatMap((source) => ["", source]),
  );
  // `props` is named only when the script reads it; the template reads props by name.
  if (!body.some((line) => /\bprops\b/.test(line) && !line.startsWith("const props = "))) {
    const index = body.findIndex((line) => line.startsWith("const props = "));
    if (index !== -1) body[index] = body[index]!.replace("const props = ", "");
  }
  const code = `${body.join("\n")}\n${rootMarkup}`;
  const apis = VUE_APIS.filter((api) => new RegExp(`\\b${api}[<(]`).test(code));
  const lines: string[] = [
    `<!-- Generated by HTML Next ${version} for Vue 3.5. Do not edit. -->`,
    '<script setup lang="ts">',
    ...(apis.length === 0 ? [] : [`import { ${apis.join(", ")} } from "vue";`]),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(`./${componentName(tag)}.vue`)};`),
    ...(definition.controller === undefined ? [] : [`import * as controllerModule from ${quote(definition.controller)};`]),
    "",
    "defineOptions({ inheritAttrs: false });",
    "",
    ...body,
    "</script>",
    "",
    "<template>",
    formatTemplate(rootMarkup, "  "),
    "</template>",
  ];
  if (styles.css !== "") lines.push("", "<style scoped>", formatStyles(styles.css), "</style>");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/(?<=<script setup lang="ts">\n)\n/, "").replace(/\n\n(?=<\/script>)/, "\n")}\n`;
}

/**
 * Indents generated markup the way a Vue author lays it out: one element per line, text kept inline
 * with its element, and a long start tag's attributes one per line. Vue's compiler drops the
 * whitespace-only text this adds between elements.
 */
function formatTemplate(markup: string, indent: string): string {
  interface Element { readonly open: string; readonly name: string; readonly children: Node[]; closed: boolean }
  type Node = Element | string;
  const root: Element = { open: "", name: "", children: [], closed: true };
  const stack: Element[] = [root];
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/y;
  let index = 0;
  while (index < markup.length) {
    const next = markup.indexOf("<", index);
    if (next !== index) {
      const text = markup.slice(index, next === -1 ? undefined : next);
      stack.at(-1)!.children.push(text);
      if (next === -1) break;
      index = next;
      continue;
    }
    tag.lastIndex = index;
    const match = tag.exec(markup);
    if (match === null) {
      stack.at(-1)!.children.push("<");
      index += 1;
      continue;
    }
    index = tag.lastIndex;
    const [whole, closing, name] = match;
    if (closing) {
      while (stack.length > 1 && stack.pop()!.name !== name);
      continue;
    }
    const element: Element = { open: whole, name: name!, children: [], closed: isVoidElement(name!) };
    stack.at(-1)!.children.push(element);
    if (!element.closed) stack.push(element);
  }
  // An empty slot or component closes itself, as Vue authors write them.
  const selfClosing = (element: Element): boolean =>
    !element.closed && element.children.length === 0 && (element.name === "slot" || /^[A-Z]/.test(element.name));
  const close = (element: Element): string => element.closed || selfClosing(element) ? "" : `</${element.name}>`;
  const opening = (element: Element, open: string): string => selfClosing(element) ? open.replace(/>$/, " />").replace(/\n( *) \/>$/, "\n$1/>") : open;
  const inline = (node: Node): string => typeof node === "string" ? node
    : `${opening(node, node.open)}${node.children.map(inline).join("")}${close(node)}`;
  const openTag = (element: Element, depth: string): string => {
    if (element.open.length + depth.length <= 100) return element.open;
    const attributes = element.open.slice(element.name.length + 1, -1).match(/[^\s=]+(?:="[^"]*"|='[^']*')?/g) ?? [];
    return `<${element.name}\n${attributes.map((attribute) => `${depth}  ${attribute}`).join("\n")}\n${depth}>`;
  };
  const print = (element: Element, depth: string): string => {
    const children = element.children.filter((child) => typeof child !== "string" || child.trim() !== "");
    const hasText = children.some((child) => typeof child === "string");
    if (element.closed || children.length === 0 || hasText) {
      const body = element.children.map(inline).join("");
      const line = `${depth}${opening(element, element.open)}${body}${close(element)}`;
      if (line.length <= 100 || hasText) return line;
      return `${depth}${opening(element, openTag(element, depth))}${body}${close(element)}`;
    }
    return [
      `${depth}${openTag(element, depth)}`,
      ...children.map((child) => print(child as Element, `${depth}  `)),
      `${depth}</${element.name}>`,
    ].join("\n");
  };
  return root.children
    .filter((child): child is Element => typeof child !== "string")
    .map((child) => print(child, indent))
    .join("\n");
}

/** Re-indents compiled component CSS two spaces per level, one blank line between top-level rules. */
function formatStyles(css: string): string {
  const root = postcss.parse(css);
  root.walk((node) => {
    let depth = 0;
    for (let parent = node.parent as postcss.Node | undefined; parent !== undefined && parent.type !== "root"; parent = parent.parent as postcss.Node | undefined) depth++;
    const indent = "  ".repeat(depth);
    node.raws.before = node.parent === root ? (node === root.first ? "" : "\n\n") : `\n${indent}`;
    if (node.type === "rule" || node.type === "atrule") {
      node.raws.after = `\n${indent}`;
      if (node.type === "rule") node.raws.between = " ";
    }
    if (node.type === "decl") node.raws.between = ": ";
  });
  return root.toString().trim();
}

function defaultSource(value: unknown): string {
  // Vue requires factories for object and array defaults.
  return value !== null && typeof value === "object" ? `() => (${JSON.stringify(value)})` : JSON.stringify(value);
}

/** The controller host, built from Vue refs, effects, and lifecycle. */
function hostSource(
  definition: ComponentDefinition,
  methods: ReturnType<typeof targetComponent>["methods"],
  refs: ReadonlyMap<string, string>,
): string[] {
  if (definition.controller === undefined) return methods.length === 0 ? [] : [
    `defineExpose({ ${methods.map((method) => `${propKey(method.name)}: () => Promise.reject(new TypeError(${quote(`<${definition.contract.tag}> has no controller.`)}))`).join(", ")} });`,
  ];
  return [
    "const stops: Array<() => void> = [];",
    "const host = {",
    "  get element(): Element { return root.value as Element; },",
    "  state: new Proxy({} as Record<string, unknown>, {",
    "    get: (_target, name) => typeof name === \"string\" ? read(name) : undefined,",
    "    set: (_target, name, value) => typeof name === \"string\" && write(name, value),",
    "  }),",
    "  refs: {",
    ...[...refs].map(([ref, name]) => `    get ${propKey(ref)}(): Element { return ${name}.value as Element; },`),
    "  } as Readonly<Record<string, Element>>,",
    "  elements: new Proxy({} as Record<string, Element | RadioNodeList | undefined>, {",
    "    get: (_target, name) => {",
    "      if (typeof name !== \"string\" || root.value === null) return undefined;",
    "      const form = root.value instanceof HTMLFormElement ? root.value : root.value.querySelector(\"form\");",
    "      return form?.elements.namedItem(name) ?? root.value.querySelector(`[name=\"${CSS.escape(name)}\"]`) ?? undefined;",
    "    },",
    "  }),",
    "  signal<T>(initialValue: T) {",
    "    const value = shallowRef(initialValue);",
    "    return {",
    "      get: (): T => value.value,",
    "      set: (next: T): void => { if (!Object.is(value.value, next)) value.value = next; },",
    "      update: (next: (current: T) => T): void => { const updated = next(value.value); if (!Object.is(value.value, updated)) value.value = updated; },",
    "    };",
    "  },",
    "  computed<T>(compute: () => T) {",
    "    const value = computed(compute);",
    "    return { get: (): T => value.value };",
    "  },",
    "  effect(run: () => void | (() => void)): () => void {",
    "    const stop = watchEffect((onCleanup) => {",
    "      const cleanup = run();",
    "      if (typeof cleanup === \"function\") onCleanup(cleanup);",
    "    }, { flush: \"post\" });",
    "    stops.push(stop);",
    "    return stop;",
    "  },",
    "  on(event: string, listener: EventListener): () => void {",
    "    const element = root.value;",
    "    element?.addEventListener(event, listener);",
    "    const off = (): void => element?.removeEventListener(event, listener);",
    "    stops.push(off);",
    "    return off;",
    "  },",
    "  dispatch,",
    "};",
    "",
    "let cleanup: void | (() => void);",
    "let ready: Promise<void> | undefined;",
    "onMounted(() => {",
    "  ready = Promise.resolve(controllerModule.default(host as never)).then((result) => { cleanup = result; });",
    "});",
    "onBeforeUnmount(() => {",
    "  for (const stop of stops.splice(0)) stop();",
    "  if (typeof cleanup === \"function\") cleanup();",
    "});",
    ...(methods.length === 0 ? [] : [
      "defineExpose({",
      ...methods.map((method) =>
        `  ${propKey(method.name)}: async (...args: unknown[]) => { await ready; return (controllerModule as Record<string, (...values: unknown[]) => unknown>)[${quote(method.exportName)}]!(host, ...args); },`),
      "});",
    ]),
  ];
}

