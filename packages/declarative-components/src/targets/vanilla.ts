import type { ExpressionNode } from "../expression.js";
import type {
  ComponentDefinition,
  ElementNode,
  HandlerDeclaration,
  ReactiveDeclaration,
  SlotNode,
  TemplateNode,
} from "../template.js";
import type { PropContract, PropType } from "../types.js";
import { getDomInterface } from "../platform.js";
import { typeScriptType } from "../type-system.js";
import { serializedDefinition } from "./shared.js";
import { targetComponent } from "./backend.js";

function js(value: string): string {
  return JSON.stringify(value);
}

function tsKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : js(name);
}

function tsType(type: PropType): string {
  return typeScriptType(type);
}

function optional(prop: PropContract): string {
  return prop.required ? "" : "?";
}

function nullable(prop: PropContract): string {
  return prop.required ? "" : " | null";
}

interface DirectBinding {
  readonly element: string;
  readonly state: string;
}

interface DirectEvent {
  readonly element: string;
  readonly name: string;
  readonly handler: string;
}

interface DirectReactivePlan {
  readonly states: ReadonlyMap<string, { readonly variable: string; readonly initial: number }>;
  readonly handlers: ReadonlyMap<string, { readonly variable: string; readonly declaration: HandlerDeclaration }>;
}

interface DirectRenderContext {
  readonly plan: DirectReactivePlan;
  readonly bindings: DirectBinding[];
  readonly events: DirectEvent[];
}

function finiteNumber(node: ExpressionNode): number | undefined {
  return node.kind === "literal" && typeof node.value === "number" && Number.isFinite(node.value)
    ? node.value
    : undefined;
}

function directSetExpression(node: ExpressionNode, state: string): { readonly op?: "+" | "-"; readonly value: number } | undefined {
  const literal = finiteNumber(node);
  if (literal !== undefined) return { value: literal };
  if (
    node.kind !== "binary" ||
    (node.op !== "+" && node.op !== "-") ||
    node.left.kind !== "id" ||
    node.left.name !== state
  ) return undefined;
  const value = finiteNumber(node.right);
  return value === undefined ? undefined : { op: node.op, value };
}

function directTemplateSupported(
  node: TemplateNode,
  states: ReadonlySet<string>,
  handlers: ReadonlySet<string>,
): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot") return false;
  if (node.flow !== undefined || node.ref !== undefined) return false;
  if (!(node.events ?? []).every(
    (event) => event.name !== "connect" && event.name !== "disconnect" &&
      event.modifiers.length === 0 && handlers.has(event.handler),
  )) return false;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    if (
      attribute.kind !== "directive" ||
      attribute.name !== "value" ||
      attribute.expressionPlan?.ast.kind !== "id" ||
      !states.has(attribute.expressionPlan.ast.name)
    ) return false;
  }
  return node.children.every((child) => directTemplateSupported(child, states, handlers));
}

function directReactivePlan(definition: ComponentDefinition): DirectReactivePlan | undefined {
  if (definition.controller !== undefined || Object.keys(definition.contract.props).length > 0) return undefined;
  const declarations = definition.declarations ?? [];
  const reactive = declarations.filter(
    (declaration): declaration is ReactiveDeclaration => declaration.kind === "state" || declaration.kind === "computed",
  );
  const handlers = declarations.filter(
    (declaration): declaration is HandlerDeclaration => declaration.kind === "handler",
  );
  if (reactive.length === 0 || reactive.some((declaration) => declaration.kind !== "state")) return undefined;
  if (reactive.length + handlers.length !== declarations.length) return undefined;

  const states = new Map<string, { variable: string; initial: number }>();
  for (const [index, declaration] of reactive.entries()) {
    const initial = declaration.expression === undefined ? undefined : finiteNumber(declaration.expression.ast);
    if (initial === undefined) return undefined;
    states.set(declaration.name, { variable: `state${index}`, initial });
  }

  const handlerPlans = new Map<string, { variable: string; declaration: HandlerDeclaration }>();
  for (const [index, declaration] of handlers.entries()) {
    if (declaration.steps.length === 0 || declaration.steps.some((step) => {
      if (
        step.kind !== "set" ||
        step.guard !== undefined ||
        step.writablePath.length !== 1 ||
        typeof step.writablePath[0] !== "string" ||
        !states.has(step.writablePath[0])
      ) return true;
      return directSetExpression(step.value.ast, step.writablePath[0]) === undefined;
    })) return undefined;
    handlerPlans.set(declaration.name, { variable: `handler${index}`, declaration });
  }
  if (handlerPlans.size === 0) return undefined;
  if (!directTemplateSupported(definition.template, new Set(states.keys()), new Set(handlerPlans.keys()))) {
    return undefined;
  }
  return { states, handlers: handlerPlans };
}

function collectDirectEvents(node: ElementNode, variable: string, context: DirectRenderContext): void {
  for (const event of node.events ?? []) {
    context.events.push({ element: variable, name: event.name, handler: event.handler });
  }
}

function renderNode(
  node: TemplateNode,
  lines: string[],
  counter: { value: number },
  parent: string,
  props: Readonly<Record<string, PropContract>>,
  valueCounter: { value: number },
  owner: string,
  slots = "slots",
  direct?: DirectRenderContext,
): void {
  if (node.kind === "text") {
    lines.push(`  ${parent}.append(${js(node.value)});`);
    return;
  }
  if (node.kind === "slot") {
    renderSlot(node, lines, counter, parent, props, valueCounter, owner, slots, direct);
    return;
  }

  const variable = `element${counter.value++}`;
  lines.push(`  const ${variable} = document.createElement(${js(node.name)});`);
  renderAttributes(node, variable, lines, props, valueCounter, "  ", direct);
  if (direct !== undefined) collectDirectEvents(node, variable, direct);
  lines.push(`  ${variable}.setAttribute("data-component", ${js(owner)});`);
  for (const child of node.children) renderNode(child, lines, counter, variable, props, valueCounter, owner, slots, direct);
  lines.push(`  ${parent}.append(${variable});`);
}

function renderSlot(
  node: SlotNode,
  lines: string[],
  counter: { value: number },
  parent: string,
  props: Readonly<Record<string, PropContract>>,
  valueCounter: { value: number },
  owner: string,
  slots: string,
  direct?: DirectRenderContext,
): void {
  const assigned = node.name === undefined ? "children" : `${slots}[${js(node.name)}] ?? []`;
  lines.push(`  if (${assigned}.length > 0) {`);
  lines.push(`    for (const child of ${assigned}) ${parent}.append(child);`);
  lines.push("  } else {");
  for (const child of node.fallback ?? []) {
    renderNode(child, lines, counter, parent, props, valueCounter, owner, slots, direct);
  }
  lines.push("  }");
}

function renderAttributes(
  node: ElementNode,
  variable: string,
  lines: string[],
  props: Readonly<Record<string, PropContract>>,
  valueCounter: { value: number },
  indent: string,
  direct?: DirectRenderContext,
): void {
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      lines.push(`${indent}${variable}.setAttribute(${js(attribute.name)}, ${js(attribute.value)});`);
      continue;
    }
    if (attribute.kind === "directive") {
      if (direct !== undefined && attribute.name === "value" && attribute.expressionPlan?.ast.kind === "id") {
        direct.bindings.push({ element: variable, state: attribute.expressionPlan.ast.name });
      }
      continue;
    }
    const prop = props[attribute.expression];
    if (prop === undefined) continue;
    const expression = `componentProps[${js(attribute.expression)}] === undefined ? ${"default" in prop ? JSON.stringify(prop.default) : "undefined"} : componentProps[${js(attribute.expression)}]`;
    const local = `value${valueCounter.value++}`;
    lines.push(`${indent}const ${local} = ${expression};`);
    if (attribute.kind === "property") {
      lines.push(`${indent}if (${local} !== undefined) ${variable}[${js(attribute.name)}] = ${local};`);
    } else if (prop.type === "boolean") {
      lines.push(`${indent}if (${local} === true) ${variable}.setAttribute(${js(attribute.name)}, "");`);
      lines.push(`${indent}else ${variable}.removeAttribute(${js(attribute.name)});`);
    } else {
      lines.push(`${indent}if (${local} === null || ${local} === undefined) ${variable}.removeAttribute(${js(attribute.name)});`);
      lines.push(`${indent}else ${variable}.setAttribute(${js(attribute.name)}, String(${local}));`);
    }
  }
}

export function generateVanilla(
  definition: ComponentDefinition,
  version: string,
): { readonly module: string; readonly declaration: string } {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const props = target.props.map(({ name, contract }) => [name, contract] as const);
  const hasRequired = props.some(([, prop]) => prop.required);
  const polymorphic = target.polymorphic;
  const direct = directReactivePlan(definition);
  const needsRuntime = direct === undefined && (
    props.length > 0 || (definition.declarations?.length ?? 0) > 0 || definition.controller !== undefined
  );
  const lines = [
    `// Generated by HTML Next ${version} for Vanilla DOM. Do not edit.`,
    ...(needsRuntime
      ? [`import { manageComponentLifecycle } from "@nextwebwg/declarative-components/runtime";`]
      : []),
    ...(definition.controller === undefined ? [] : [`import * as controller from ${js(definition.controller)};`]),
    `import "../styles/${contract.tag}.css";`,
    "",
    ...(needsRuntime ? [`const definition = ${serializedDefinition(definition)};`, ""] : []),
    `export function create${contract.name}(options${hasRequired ? "" : " = {}"}) {`,
    `  const { attributes = {}, children = [], slots = {}, as${needsRuntime ? ", ...componentProps" : ""} } = options;`,
    ...(direct === undefined
      ? []
      : [...direct.states.values()].map(({ variable, initial }) => `  let ${variable} = ${String(initial)};`)),
    `  const element = document.createElement(${polymorphic ? `as ?? ${js(template.name)}` : js(template.name)});`,
    "  for (const [name, value] of Object.entries(attributes)) {",
    "    if (value === null || value === undefined || value === false) continue;",
    "    element.setAttribute(name, value === true ? \"\" : String(value));",
    "  }",
  ];
  const valueCounter = { value: 0 };
  const directRender: DirectRenderContext | undefined = direct === undefined
    ? undefined
    : { plan: direct, bindings: [], events: [] };
  renderAttributes(template, "element", lines, contract.props, valueCounter, "  ", directRender);
  if (directRender !== undefined) collectDirectEvents(template, "element", directRender);
  lines.push(
    `  element.setAttribute("data-component", ${js(contract.tag)});`,
    `  element.setAttribute("data-component-root", ${js(contract.tag)});`,
  );
  const counter = { value: 0 };
  for (const child of template.children) {
    renderNode(child, lines, counter, "element", contract.props, valueCounter, contract.tag, "slots", directRender);
  }
  if (directRender !== undefined) {
    const directPlan = directRender.plan;
    lines.push("  let pending = false;");
    lines.push("  const update = () => {");
    lines.push("    pending = false;");
    for (const binding of directRender.bindings) {
      lines.push(`    ${binding.element}.textContent = String(${directPlan.states.get(binding.state)!.variable});`);
    }
    lines.push("  };");
    lines.push("  const schedule = () => {");
    lines.push("    if (!pending) { pending = true; queueMicrotask(update); }");
    lines.push("  };");
    for (const { variable, declaration } of directPlan.handlers.values()) {
      lines.push(`  const ${variable} = () => {`);
      lines.push("    if (!element.isConnected) return;");
      for (const [stepIndex, step] of declaration.steps.entries()) {
        if (step.kind !== "set") continue;
        const state = String(step.writablePath[0]);
        const stateVariable = directPlan.states.get(state)!.variable;
        const expression = directSetExpression(step.value.ast, state)!;
        const next = expression.op === undefined
          ? String(expression.value)
          : `${stateVariable} ${expression.op} ${String(expression.value)}`;
        const nextVariable = `next${stepIndex}`;
        lines.push(`    const ${nextVariable} = ${next};`);
        lines.push(`    if (!Object.is(${stateVariable}, ${nextVariable})) { ${stateVariable} = ${nextVariable}; schedule(); }`);
      }
      lines.push("  };");
    }
    for (const event of directRender.events) {
      lines.push(`  ${event.element}.addEventListener(${js(event.name)}, ${directPlan.handlers.get(event.handler)!.variable});`);
    }
    lines.push("  update();");
  }
  if (needsRuntime) {
    lines.push(
      "  manageComponentLifecycle(element, definition, { props: componentProps," ,
      ...(definition.controller === undefined ? [] : ["    controller,"]),
      "  });",
    );
  }
  lines.push("  return element;", "}", "");

  const domType = getDomInterface(contract.nativeElement) ?? "HTMLElement";
  const elementType = `${contract.name}Element`;
  const declaration = [
    `// Generated by HTML Next ${version} for Vanilla DOM. Do not edit.`,
    `export interface ${contract.name}EventMap {`,
    ...target.events.map((event) => `  ${tsKey(event.name)}: CustomEvent<${event.detailType}>;`),
    "}",
    `export interface ${elementType} extends ${domType} {`,
    ...target.methods.map((method) => `  ${tsKey(method.name)}(): ${method.returnType};`),
    `  addEventListener<K extends keyof ${contract.name}EventMap>(type: K, listener: (this: ${elementType}, event: ${contract.name}EventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;`,
    `  removeEventListener<K extends keyof ${contract.name}EventMap>(type: K, listener: (this: ${elementType}, event: ${contract.name}EventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;`,
    "}",
    `export interface ${contract.name}Props {`,
    ...props.map(
      ([name, prop]) => `  ${tsKey(name)}${optional(prop)}: ${tsType(prop.type)}${nullable(prop)};`,
    ),
    "  attributes?: Readonly<Record<string, string | number | boolean | null | undefined>>;",
    "  children?: readonly (string | Node)[];",
    "  slots?: Readonly<Record<string, readonly (string | Node)[]>>;",
    ...(polymorphic ? [`  as?: ${definition.root!.kind === "native" ? definition.root!.choices.map(js).join(" | ") : "never"};`] : []),
    "}",
    `export declare function create${contract.name}(props${hasRequired ? "" : "?"}: ${contract.name}Props): ${elementType};`,
    "",
  ].join("\n");

  return { module: `${lines.join("\n")}\n`, declaration };
}
