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
import { compileComponentStylesForVue } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import { parseTypeExpression, type TypeNode } from "../type-system.js";
import { targetComponent } from "./backend.js";
import { escapeHtml, isVoidElement, propKey, propTypeSource, quote } from "./shared.js";

/** Expression helpers with HTML Next semantics, emitted into each component (not imported) as used. */
const HELPERS: readonly (readonly [name: string, source: string])[] = [
  ["t", `  t: (v: unknown): boolean => v === true || (typeof v === "string" ? v.length > 0 : typeof v === "number" ? v !== 0 && v === v : Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v).length > 0 : false),`],
  ["n", `  n: (v: unknown): number | undefined => typeof v === "number" && v === v ? v : undefined,`],
  ["op", `  op: (op: string, a: unknown, b: unknown): unknown => {
    const x = hn.n(a), y = hn.n(b);
    if (x === undefined || y === undefined) return undefined;
    switch (op) {
      case "<": return x < y; case "<=": return x <= y; case ">": return x > y; case ">=": return x >= y;
      case "+": return x + y; case "-": return x - y; case "*": return x * y; case "/": return x / y; case "%": return x % y;
    }
    return undefined;
  },`],
  ["match", `  match: (op: string, a: unknown, b: unknown): boolean | undefined => typeof a === "string" && typeof b === "string"
    ? op === "^=" ? a.startsWith(b) : op === "$=" ? a.endsWith(b) : a.includes(b)
    : undefined,`],
  ["text", `  text: (v: unknown): string => v === undefined || v === null ? "" : Array.isArray(v) ? v.map(hn.text).join(" ") : typeof v === "object" ? "" : String(v),`],
  // Vue types intrinsic attributes more narrowly than the strings the platform accepts.
  ["attr", `  attr: (v: unknown): any => v === undefined || v === null || v === false ? undefined : v === true ? "" : Array.isArray(v) ? v.map(hn.text).join(" ") : typeof v === "object" ? undefined : String(v),`],
  ["call", `  call: (fn: string, ...args: unknown[]): unknown => {
    if (fn === "format") {
      let index = 1;
      return typeof args[0] === "string" ? args[0].replace(/%s/g, () => index < args.length ? hn.text(args[index++]) : "%s") : undefined;
    }
    const n = args.map(hn.n);
    if (n.some((value) => value === undefined)) return undefined;
    const v = n as number[];
    switch (fn) {
      case "abs": return v.length === 1 ? Math.abs(v[0]!) : undefined;
      case "round": return v.length === 1 ? Math.round(v[0]!) : undefined;
      case "min": return v.length > 0 ? Math.min(...v) : undefined;
      case "max": return v.length > 0 ? Math.max(...v) : undefined;
      case "clamp": return v.length === 3 ? Math.min(Math.max(v[0]!, v[1]!), v[2]!) : undefined;
    }
    return undefined;
  },`],
  ["shape", `  shape: (items: unknown, where: ((item: any) => unknown) | undefined, sort: readonly string[], limit: unknown): any[] => {
    let list = Array.isArray(items) ? items.slice() : [];
    if (where !== undefined) list = list.filter((item) => hn.t(where(item)));
    if (sort.length > 0) {
      const field = (item: unknown, path: string): unknown => item !== null && typeof item === "object" && !Array.isArray(item)
        ? path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], item)
        : item;
      const compare = (a: unknown, b: unknown): number => typeof a === "number" && typeof b === "number" ? a - b : hn.text(a).localeCompare(hn.text(b));
      list.sort((a, b) => {
        for (const key of sort) {
          const descending = key.startsWith("-");
          const order = compare(field(a, descending ? key.slice(1) : key), field(b, descending ? key.slice(1) : key));
          if (order !== 0) return descending ? -order : order;
        }
        return 0;
      });
    }
    return typeof limit === "number" ? list.slice(0, Math.max(0, Math.trunc(limit))) : list;
  },`],
];

/** The `hn` object holding the helpers `code` uses, and the helpers they use. */
function helperSource(code: string): string {
  const used = new Set<string>();
  const visit = (source: string): void => {
    for (const [, name] of source.matchAll(/\bhn\.(\w+)/g)) {
      if (used.has(name!)) continue;
      used.add(name!);
      visit(HELPERS.find(([helper]) => helper === name)?.[1] ?? "");
    }
  };
  visit(code);
  const entries = HELPERS.filter(([name]) => used.has(name));
  return entries.length === 0 ? "" : `const hn = {\n${entries.map(([, source]) => source).join("\n")}\n};\n`;
}

const VUE_APIS = ["computed", "onBeforeUnmount", "onMounted", "ref", "shallowRef", "watchEffect"] as const;

interface Names {
  /** How each expression root is read, by context. */
  readonly template: Map<string, string>;
  readonly script: Map<string, string>;
}

/** Translates an HTML Next expression to JavaScript with the same absence and typing rules. */
function expression(node: ExpressionNode, names: ReadonlyMap<string, string>): string {
  switch (node.kind) {
    case "literal":
      return node.value === undefined ? "undefined" : JSON.stringify(node.value);
    case "id":
      return names.get(node.name) ?? "undefined";
    case "member":
      return /^[A-Za-z_$][\w$]*$/.test(node.key)
        ? `(${expression(node.object, names)})?.${node.key}`
        : `(${expression(node.object, names)})?.[${quote(node.key)}]`;
    case "index":
      return `(${expression(node.object, names)})?.[${expression(node.index, names) as string}]`;
    case "unary":
      return node.op === "not" ? `!hn.t(${expression(node.operand, names)})` : `hn.op("-", 0, ${expression(node.operand, names)})`;
    case "binary": {
      const left = expression(node.left, names);
      const right = expression(node.right, names);
      if (node.op === "and") return `(hn.t(${left}) && hn.t(${right}))`;
      if (node.op === "or") return `(hn.t(${left}) || hn.t(${right}))`;
      if (node.op === "=") return `(${left} === ${right})`;
      if (node.op === "!=") return `(${left} !== ${right})`;
      if (node.op === "^=" || node.op === "$=" || node.op === "*=") return `hn.match(${quote(node.op)}, ${left}, ${right})`;
      return `hn.op(${quote(node.op)}, ${left}, ${right})`;
    }
    case "call":
      return `hn.call(${[quote(node.fn), ...node.args.map((argument) => expression(argument, names))].join(", ")})`;
    case "object":
      return `({ ${node.pairs.map((pair) => `${quote(pair.key)}: ${expression(pair.value, names)}`).join(", ")} })`;
    case "array":
      return `[${node.items.map((item) => expression(item, names)).join(", ")}]`;
  }
}

function compiled(plan: { ast: ExpressionNode } | undefined, names: ReadonlyMap<string, string>, source: string): string {
  if (plan === undefined) fail("HT030", `Expression \`${source}\` could not be converted.`);
  return expression(plan.ast, names);
}

/** A double-quoted HTML attribute value (Vue decodes character references in attributes). */
function attributeValue(value: string): string {
  return `"${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
}

/**
 * A template binding: the JavaScript expression as an attribute value. String literals use single
 * quotes so the attribute needs no `&quot;`, which Vue's type checker does not decode.
 */
function bound(code: string): string {
  return attributeValue(code.replace(/"(?:\\.|[^"\\])*"/g, (literal) =>
    `'${literal.slice(1, -1).replace(/\\"/g, "\"").replace(/'/g, "\\'")}'`));
}

function writableTarget(path: readonly WritablePathSegment[], names: ReadonlyMap<string, string>): string {
  const [root, ...rest] = path;
  const base = names.get(String(root));
  if (base === undefined) fail("HT031", `\`${String(root)}\` is not a writable state path.`);
  return `${base}${rest.map((segment: WritablePathSegment) => `[${JSON.stringify(segment)}]`).join("")}`;
}

interface Context {
  readonly definition: ComponentDefinition;
  readonly imports: Set<string>;
  readonly usesRefs: { value: boolean };
  /** Whether the root needs a Vue ref (for dispatch and the controller host). */
  readonly root: boolean;
  readonly hostState: boolean;
}

function isComponentTag(name: string): boolean {
  return name.includes("-") && getDomInterface(name) === undefined;
}

function renderChildren(nodes: readonly TemplateNode[], names: Names, context: Context): string {
  return nodes.map((child) => renderNode(child, names, context)).join("");
}

function withLocal(names: Names, entries: readonly [string, string][]): Names {
  const template = new Map(names.template);
  const script = new Map(names.script);
  for (const [name, code] of entries) {
    template.set(name, code);
    script.set(name, code);
  }
  return { template, script };
}

function renderNode(node: TemplateNode, names: Names, context: Context): string {
  if (node.kind === "text") return escapeHtml(node.value).replace(/\{\{/g, "{{ '{{' }}");
  if (node.kind === "slot") {
    const name = node.nameExpression !== undefined
      ? ` :name=${bound(compiled(node.nameExpression, names.template, "slot name"))}`
      : node.name === undefined ? "" : ` name=${quote(node.name)}`;
    return `<slot${name}>${renderChildren(node.fallback ?? [], names, context)}</slot>`;
  }
  const flow = node.flow;
  if (flow?.kind === "each") {
    const list = compiled(flow.listPlan, names.template, flow.list);
    const item = flow.item;
    const index = flow.index ?? "index";
    const local = withLocal(names, [[item, item], [index, index]]);
    const where = flow.wherePlan === undefined ? "undefined" : `(${item}) => ${expression(flow.wherePlan.ast, local.template)}`;
    const sort = JSON.stringify((flow.sort ?? "").split(",").map((key) => key.trim()).filter(Boolean));
    const limit = flow.limitPlan === undefined ? "undefined" : expression(flow.limitPlan.ast, names.template);
    const key = flow.keyPlan === undefined ? index : expression(flow.keyPlan.ast, local.template);
    const { flow: _flow, ...body } = node;
    return `<template v-for=${bound(`(${item}, ${index}) in hn.shape(${list}, ${where}, ${sort}, ${limit})`)} :key=${bound(key)}>${renderNode(body, local, context)}</template>`;
  }
  if (flow?.kind === "with") {
    const value = compiled(flow.expressionPlan, names.template, flow.expr);
    const { flow: _flow, ...body } = node;
    return `<template v-for=${bound(`${flow.alias} in [${value}]`)}>${renderNode(body, withLocal(names, [[flow.alias, flow.alias]]), context)}</template>`;
  }
  if (flow?.kind === "match") {
    const local = flow.alias === undefined ? names : withLocal(names, [[flow.alias, flow.alias]]);
    const arms = node.children
      .filter((child): child is ElementNode => child.kind === "element" && (child.flow?.kind === "when" || child.flow?.kind === "else"))
      .map((arm, index) => {
        const { flow: armFlow, ...armBody } = arm;
        const test = armFlow?.kind === "when" ? compiled(armFlow.testPlan, local.template, armFlow.test) : undefined;
        const directive = test === undefined ? "v-else" : `${index === 0 ? "v-if" : "v-else-if"}=${bound(`hn.t(${test})`)}`;
        return `<template ${directive}>${renderNode(armBody, local, context)}</template>`;
      }).join("");
    const inner = node.name === "template" ? arms : `<${node.name}${literalAttributes(node)}>${arms}</${node.name}>`;
    if (flow.expr === undefined) return inner;
    const value = compiled(flow.expressionPlan, names.template, flow.expr);
    return `<template v-for=${bound(`${flow.alias} in [${value}]`)}>${inner}</template>`;
  }
  if (flow?.kind === "if") {
    const { flow: _flow, ...body } = node;
    return `<template v-if=${bound(`hn.t(${compiled(flow.testPlan, names.template, flow.test)})`)}>${renderNode(body, names, context)}</template>`;
  }
  return renderElement(node, names, context, false);
}

function literalAttributes(node: ElementNode): string {
  return node.attributes
    .filter((attribute) => attribute.kind === "literal")
    .map((attribute) => ` ${attribute.name}=${attributeValue((attribute as { value: string }).value)}`)
    .join("");
}

function renderElement(node: ElementNode, names: Names, context: Context, isRoot: boolean): string {
  const component = isComponentTag(node.name);
  const name = component ? componentName(node.name) : node.name;
  if (component) context.imports.add(node.name);
  const attributes: string[] = [];
  const classes: string[] = [];
  const styles: string[] = [];
  let content: string | undefined;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      attributes.push(`${attribute.name}=${attributeValue(attribute.value)}`);
    } else if (attribute.kind === "directive") {
      if (attribute.name === "html") fail("HT032", "`$html` is not supported in Vue conversion yet.");
      content = `{{ hn.text(${compiled(attribute.expressionPlan, names.template, attribute.expression)}) }}`;
    } else if (attribute.kind === "property") {
      attributes.push(`:${attribute.name}.prop=${bound(compiled(attribute.expressionPlan, names.template, attribute.expression))}`);
    } else if (attribute.target === "class") {
      classes.push(`${quote(attribute.name)}: hn.t(${compiled(attribute.expressionPlan, names.template, attribute.expression)})`);
    } else if (attribute.target === "style") {
      styles.push(`${quote(attribute.name)}: hn.text(${compiled(attribute.expressionPlan, names.template, attribute.expression)})`);
    } else if (attribute.twoWay === true && attribute.writablePath !== undefined) {
      attributes.push(`v-model=${bound(writableTarget(attribute.writablePath, names.template))}`);
    } else {
      const value = compiled(attribute.expressionPlan, names.template, attribute.expression);
      attributes.push(component ? `:${attribute.name}=${bound(value)}` : `:${attribute.name}=${bound(`hn.attr(${value})`)}`);
    }
  }
  if (classes.length > 0) attributes.push(`:class=${bound(`{ ${classes.join(", ")} }`)}`);
  if (styles.length > 0) attributes.push(`:style=${bound(`{ ${styles.join(", ")} }`)}`);
  for (const event of node.events ?? []) {
    const handler = (context.definition.declarations ?? []).find((declaration): declaration is HandlerDeclaration =>
      declaration.kind === "handler" && declaration.name === event.handler);
    if (handler === undefined) fail("HT033", `Handler \`${event.handler}\` is not declared.`);
    attributes.push(`@${event.name}${event.modifiers.map((modifier) => `.${modifier}`).join("")}=${attributeValue(`handler_${safe(event.handler)}`)}`);
  }
  if (node.ref !== undefined) {
    context.usesRefs.value = true;
    attributes.push(`:ref=${bound(`(element) => { refs[${quote(node.ref)}] = element }`)}`);
  }
  if (isRoot) {
    const tag = context.definition.contract.tag;
    attributes.unshift("v-bind=\"$attrs\"", `data-component=${attributeValue(tag)}`);
    if (context.hostState) attributes.push(`:${stateAttribute(tag)}="hostState || undefined"`);
    if (context.root) attributes.push("ref=\"root\"");
  }
  // A <template> without structural flow produces its content with no wrapper element.
  if (node.name === "template" && !isRoot) return content ?? renderChildren(node.children, names, context);
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

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function handlerSource(handler: HandlerDeclaration, names: Names, events: readonly EventDeclaration[]): string {
  const lines = [`const handler_${safe(handler.name)} = (event?: Event): void => {`];
  const local = withLocal(names, [["event", "event"]]);
  for (const step of handler.steps) {
    const guard = step.guard === undefined ? "" : `if (hn.t(${expression(step.guard.ast, local.script)})) `;
    if (step.kind === "set") {
      lines.push(`  ${guard}${writableTarget(step.writablePath, local.script)} = ${expression(step.value.ast, local.script)};`);
    } else if (step.kind === "dispatch") {
      const detail = step.value === undefined ? "undefined" : expression(step.value.ast, local.script);
      const declaration = events.find((event) => event.name === step.event);
      if (declaration === undefined) fail("HT034", `Handler \`${handler.name}\` dispatches undeclared event \`${step.event}\`.`);
      lines.push(`  ${guard}dispatch(${quote(step.event)}, ${detail});`);
    } else if (step.kind === "focus") {
      lines.push(`  ${guard}(refs[${quote(step.target)}] as HTMLElement | undefined)?.focus();`);
    } else {
      lines.push(`  ${guard}(refs[${quote(step.target)}] as HTMLInputElement | undefined)?.reportValidity?.();`);
    }
  }
  lines.push("};");
  return lines.join("\n");
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

  const names: Names = { template: new Map(), script: new Map() };
  for (const prop of target.props) {
    const read = /^[A-Za-z_$][\w$]*$/.test(prop.name) ? `props.${prop.name}` : `props[${quote(prop.name)}]`;
    names.template.set(prop.name, read);
    names.script.set(prop.name, read);
  }
  for (const state of states) {
    names.template.set(state.name, `state_${safe(state.name)}`);
    names.script.set(state.name, `state_${safe(state.name)}.value`);
  }
  for (const value of computedValues) {
    names.template.set(value.name, `computed_${safe(value.name)}`);
    names.script.set(value.name, `computed_${safe(value.name)}.value`);
  }

  if (template.flow !== undefined) {
    fail("HT036", `<${contract.tag}> has a structural directive on its root, which Vue conversion does not support yet.`);
  }
  const styles = compileComponentStylesForVue(definition.css, definition);
  const controlled = definition.controller !== undefined;
  const dispatches = events.length > 0 || controlled;
  const reads = styles.stateNames.length > 0 || controlled;
  const context: Context = { definition, imports: new Set(), usesRefs: { value: false }, root: dispatches, hostState: styles.stateNames.length > 0 };
  const rootMarkup = renderElement(template, names, context, true);
  const defaults = target.props.filter((prop) => "default" in prop.contract);
  const propsType = ["{", ...target.props.map((prop) => `  ${propKey(prop.name)}?: ${propTypeSource(prop.contract)};`), "}"].join("\n");

  const body: string[] = [
    ...(target.props.length === 0 ? [] : defaults.length === 0 ? [`const props = defineProps<${propsType}>();`] : [
      `const props = withDefaults(defineProps<${propsType}>(), {`,
      ...defaults.map((prop) => `  ${propKey(prop.name)}: ${defaultSource((prop.contract as { default: unknown }).default)},`),
      "});",
    ]),
    ...(events.length === 0 ? [] : [
      "const emit = defineEmits<{",
      ...events.map((event) => {
        const typed = target.events.find((candidate) => candidate.name === event.name);
        return `  ${quote(event.name)}: [detail: ${typed?.detailType ?? "unknown"}];`;
      }),
      "}>();",
    ]),
    ...(dispatches ? ["const root = ref<HTMLElement | null>(null);"] : []),
    ...(context.usesRefs.value || controlled ? ["const refs: Record<string, Element | undefined> = {};"] : []),
    ...states.map((state) => `const state_${safe(state.name)} = ref<any>(${state.expression === undefined ? "undefined" : expression(state.expression.ast, names.script)});`),
    ...computedValues.map((value) => `const computed_${safe(value.name)} = computed(() => ${value.expression === undefined ? "undefined" : expression(value.expression.ast, names.script)});`),
    ...(!dispatches ? [] : [
      "",
      "/** Dispatches a component event to Vue listeners and, for controllers and page code, on the root. */",
      "const dispatch = (name: string, detail?: unknown): boolean => {",
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
      "};",
    ]),
    ...handlers.map((handler) => handlerSource(handler, names, events)),
    ...(styles.stateNames.length === 0 ? [] : [
      "",
      "/** The resolved values the styles' :host-state() rules test. */",
      `const hostState = computed(() => (${JSON.stringify(styles.stateNames)} as const).flatMap((name) => {`,
      "  const value = read(name);",
      "  const tokens: string[] = hn.t(value) ? [name] : [];",
      "  if (typeof value === \"string\" || typeof value === \"number\") tokens.push(`${name}=${encodeURIComponent(String(value))}`);",
      "  return tokens;",
      "}).join(\" \"));",
    ]),
    ...(!reads ? [] : [
      "",
      "function read(name: string): unknown {",
      ...states.map((state) => `  if (name === ${quote(state.name)}) return state_${safe(state.name)}.value;`),
      ...computedValues.map((value) => `  if (name === ${quote(value.name)}) return computed_${safe(value.name)}.value;`),
      target.props.length === 0 ? "  return undefined;" : "  return (props as Record<string, unknown>)[name];",
      "}",
    ]),
    ...(!controlled ? [] : [
      "",
      "function write(name: string, value: unknown): boolean {",
      ...states.map((state) => `  if (name === ${quote(state.name)}) { state_${safe(state.name)}.value = value; return true; }`),
      "  throw new TypeError(`Only declared state is writable; \\`${name}\\` is not.`);",
      "}",
    ]),
    "",
    ...hostSource(definition, target.methods),
  ];
  const code = `${body.join("\n")}\n${rootMarkup}`;
  const apis = VUE_APIS.filter((api) => new RegExp(`\\b${api}[<(]`).test(code));
  const script: string[] = [
    `<!-- Generated by HTML Next ${version} for Vue 3.5. Do not edit. -->`,
    '<script setup lang="ts">',
    ...(apis.length === 0 ? [] : [`import { ${apis.join(", ")} } from "vue";`]),
    ...[...context.imports].sort().map((tag) => `import ${componentName(tag)} from ${quote(`./${componentName(tag)}.vue`)};`),
    ...(definition.controller === undefined ? [] : [`import * as controllerModule from ${quote(definition.controller)};`]),
    "",
    "defineOptions({ inheritAttrs: false });",
    "",
    helperSource(code),
    ...body,
    "</script>",
    "",
    "<template>",
    `  ${rootMarkup}`,
    "</template>",
  ];
  if (styles.css !== "") script.push("", "<style scoped>", styles.css, "</style>");
  return `${script.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function defaultSource(value: unknown): string {
  // Vue requires factories for object and array defaults.
  return value !== null && typeof value === "object" ? `() => (${JSON.stringify(value)})` : JSON.stringify(value);
}

/** The controller host, built from Vue refs, effects, and lifecycle. */
function hostSource(
  definition: ComponentDefinition,
  methods: ReturnType<typeof targetComponent>["methods"],
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
    "  refs: refs as Readonly<Record<string, Element>>,",
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

