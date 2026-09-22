import type { ExpressionNode } from "../expression.js";
import type {
  ComponentDefinition,
  ElementNode,
  HandlerDeclaration,
  ReactiveDeclaration,
  SlotNode,
  TemplateNode,
} from "../template.js";
import type { PropContract } from "../types.js";
import { getDomInterface } from "../platform.js";
import { kebabCase } from "../names.js";
import { propTypeSource, serializedDefinition } from "./shared.js";
import { targetComponent } from "./backend.js";

function js(value: string): string {
  return JSON.stringify(value);
}

function tsKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : js(name);
}

function optional(prop: PropContract): string {
  return prop.required ? "" : "?";
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
  readonly computed: ReadonlyMap<string, { readonly variable: string; readonly expression: string }>;
  readonly values: ReadonlyMap<string, { readonly variable: string }>;
  readonly handlers: ReadonlyMap<string, { readonly variable: string; readonly declaration: HandlerDeclaration }>;
}

interface DirectRenderContext {
  readonly plan: DirectReactivePlan;
  readonly bindings: DirectBinding[];
  readonly events: DirectEvent[];
}

interface DirectProp {
  readonly variable: string;
  readonly contract: PropContract;
}

interface DirectPropBinding {
  readonly element: string;
  readonly prop: string;
  readonly kind: "attribute" | "text";
  readonly name?: string;
}

interface DirectPropPlan {
  readonly props: ReadonlyMap<string, DirectProp>;
}

interface DirectPropRenderContext {
  readonly plan: DirectPropPlan;
  readonly bindings: DirectPropBinding[];
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

function directNumericExpression(
  node: ExpressionNode,
  values: ReadonlyMap<string, { readonly variable: string }>,
): string | undefined {
  if (node.kind === "literal" && typeof node.value === "number" && Number.isFinite(node.value)) {
    return String(node.value);
  }
  if (node.kind === "id") return values.get(node.name)?.variable;
  if (node.kind === "unary" && node.op === "-") {
    const operand = directNumericExpression(node.operand, values);
    return operand === undefined ? undefined : `(-${operand})`;
  }
  if (node.kind === "binary" && ["+", "-", "*", "/", "%"].includes(node.op)) {
    const left = directNumericExpression(node.left, values);
    const right = directNumericExpression(node.right, values);
    return left === undefined || right === undefined ? undefined : `(${left} ${node.op} ${right})`;
  }
  if (node.kind === "call" && ["abs", "round", "min", "max", "clamp"].includes(node.fn)) {
    const args = node.args.map((argument) => directNumericExpression(argument, values));
    if (args.some((argument) => argument === undefined)) return undefined;
    if ((node.fn === "abs" || node.fn === "round") && args.length !== 1) return undefined;
    if ((node.fn === "min" || node.fn === "max") && args.length === 0) return undefined;
    if (node.fn === "clamp" && args.length !== 3) return undefined;
    if (node.fn === "clamp") return `Math.min(Math.max(${args[0]}, ${args[1]}), ${args[2]})`;
    return `Math.${node.fn}(${args.join(", ")})`;
  }
  return undefined;
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
  if (reactive.length === 0) return undefined;
  if (reactive.length + handlers.length !== declarations.length) return undefined;

  const states = new Map<string, { variable: string; initial: number }>();
  const computed = new Map<string, { variable: string; expression: string }>();
  const values = new Map<string, { variable: string }>();
  for (const [index, declaration] of reactive.entries()) {
    const variable = declaration.kind === "state" ? `state${index}` : `computed${index}`;
    if (declaration.kind === "state") {
      const initial = declaration.expression === undefined ? undefined : finiteNumber(declaration.expression.ast);
      if (initial === undefined) return undefined;
      const state = { variable, initial };
      states.set(declaration.name, state);
      values.set(declaration.name, state);
      continue;
    }
    const expression = declaration.expression === undefined
      ? undefined
      : directNumericExpression(declaration.expression.ast, values);
    if (expression === undefined) return undefined;
    const derived = { variable, expression };
    computed.set(declaration.name, derived);
    values.set(declaration.name, derived);
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
  if (!directTemplateSupported(definition.template, new Set(values.keys()), new Set(handlerPlans.keys()))) {
    return undefined;
  }
  return { states, computed, values, handlers: handlerPlans };
}

function directPropType(prop: PropContract): "string" | "boolean" | "number" | readonly string[] | undefined {
  if (prop.type === "string" || prop.type === "boolean" || prop.type === "number") return prop.type;
  if ("enum" in prop.type) return prop.type.enum;
  return undefined;
}

function directPropTemplateSupported(node: TemplateNode, props: ReadonlySet<string>): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot") {
    return node.nameExpression === undefined &&
      (node.fallback ?? []).every((child) => directPropTemplateSupported(child, props));
  }
  if (node.flow !== undefined || node.ref !== undefined || (node.events?.length ?? 0) > 0) return false;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    const name = attribute.expressionPlan?.ast.kind === "id"
      ? attribute.expressionPlan.ast.name
      : undefined;
    if (name === undefined || !props.has(name)) return false;
    if (attribute.kind === "directive") {
      if (attribute.name !== "value") return false;
    } else if (
      attribute.kind !== "attribute" || attribute.twoWay === true || attribute.target !== undefined ||
      !/^(?:aria-|data-)/.test(attribute.name)
    ) return false;
  }
  return node.children.every((child) => directPropTemplateSupported(child, props));
}

function directPropPlan(definition: ComponentDefinition): DirectPropPlan | undefined {
  const entries = Object.entries(definition.contract.props);
  if (
    definition.controller !== undefined ||
    (definition.declarations?.length ?? 0) > 0 ||
    entries.length === 0 ||
    entries.some(([, prop]) => directPropType(prop) === undefined)
  ) return undefined;
  const props = new Map(entries.map(([name, contract], index) => [
    name,
    { variable: `prop${index}`, contract },
  ]));
  return directPropTemplateSupported(definition.template, new Set(props.keys())) ? { props } : undefined;
}

function collectDirectEvents(node: ElementNode, variable: string, context: DirectRenderContext): void {
  for (const event of node.events ?? []) {
    context.events.push({ element: variable, name: event.name, handler: event.handler });
  }
}

function renderNode(
  node: TemplateNode,
  lines: string[],
  counter: RenderCounter,
  parent: string,
  props: Readonly<Record<string, PropContract>>,
  valueCounter: { value: number },
  owner: string,
  slots = "slots",
  direct?: DirectRenderContext,
  directProps?: DirectPropRenderContext,
): void {
  if (node.kind === "text") {
    lines.push(`  ${parent}.append(${js(node.value)});`);
    return;
  }
  if (node.kind === "slot") {
    renderSlot(node, lines, counter, parent, props, valueCounter, owner, slots, direct, directProps);
    return;
  }

  const variable = `element${counter.value++}`;
  // SVG subtrees must be created in the SVG namespace; <foreignObject> children return to HTML.
  const svg = node.name === "svg" || counter.svgParents.has(parent);
  lines.push(svg
    ? `  const ${variable} = document.createElementNS("http://www.w3.org/2000/svg", ${js(node.name)});`
    : `  const ${variable} = document.createElement(${js(node.name)});`);
  if (svg && node.name !== "foreignObject") counter.svgParents.add(variable);
  renderAttributes(node, variable, lines, props, valueCounter, "  ", direct, directProps);
  if (direct !== undefined) collectDirectEvents(node, variable, direct);
  for (const child of node.children) {
    renderNode(child, lines, counter, variable, props, valueCounter, owner, slots, direct, directProps);
  }
  lines.push(`  ${parent}.append(${variable});`);
}

interface RenderCounter {
  value: number;
  /** Generated variables naming SVG elements whose children are also SVG. */
  readonly svgParents: Set<string>;
}

function renderSlot(
  node: SlotNode,
  lines: string[],
  counter: RenderCounter,
  parent: string,
  props: Readonly<Record<string, PropContract>>,
  valueCounter: { value: number },
  owner: string,
  slots: string,
  direct?: DirectRenderContext,
  directProps?: DirectPropRenderContext,
): void {
  const assigned = node.name === undefined ? "children" : `${slots}[${js(node.name)}] ?? []`;
  lines.push(`  if (${assigned}.length > 0) {`);
  lines.push(`    for (const child of ${assigned}) ${parent}.append(child);`);
  lines.push("  } else {");
  for (const child of node.fallback ?? []) {
    renderNode(child, lines, counter, parent, props, valueCounter, owner, slots, direct, directProps);
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
  directProps?: DirectPropRenderContext,
): void {
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      lines.push(`${indent}${variable}.setAttribute(${js(attribute.name)}, ${js(attribute.value)});`);
      continue;
    }
    if (attribute.kind === "directive") {
      if (direct !== undefined && attribute.name === "value" && attribute.expressionPlan?.ast.kind === "id") {
        direct.bindings.push({ element: variable, state: attribute.expressionPlan.ast.name });
      } else if (
        directProps !== undefined && attribute.name === "value" &&
        attribute.expressionPlan?.ast.kind === "id"
      ) {
        const name = attribute.expressionPlan.ast.name;
        const prop = directProps.plan.props.get(name)!;
        directProps.bindings.push({ element: variable, prop: name, kind: "text" });
        lines.push(`${indent}${variable}.textContent = ${prop.variable} == null ? "" : String(${prop.variable});`);
      }
      continue;
    }
    const prop = props[attribute.expression];
    if (prop === undefined) continue;
    const directProp = directProps?.plan.props.get(attribute.expression);
    const expression = directProp?.variable ?? `componentProps[${js(attribute.expression)}] === undefined ? ${"default" in prop ? JSON.stringify(prop.default) : "undefined"} : componentProps[${js(attribute.expression)}]`;
    if (
      directProp !== undefined && attribute.kind === "attribute" &&
      (variable !== "element" || attribute.name !== `data-${kebabCase(attribute.expression)}`)
    ) {
      directProps!.bindings.push({
        element: variable,
        prop: attribute.expression,
        kind: "attribute",
        name: attribute.name,
      });
    }
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
  const directProps = direct === undefined ? directPropPlan(definition) : undefined;
  const needsRuntime = direct === undefined && directProps === undefined && (
    props.length > 0 || (definition.declarations?.length ?? 0) > 0 || definition.controller !== undefined
  );
  const lines = [
    `// Generated by HTML Next ${version} for Vanilla DOM. Do not edit.`,
    ...(directProps === undefined
      ? []
      : [`import { manageGeneratedProps } from "@nextwebwg/declarative-components/generated-runtime";`]),
    ...(needsRuntime
      ? [`import { manageComponentLifecycle } from "@nextwebwg/declarative-components/runtime";`]
      : []),
    ...(definition.controller === undefined ? [] : [`import * as controller from ${js(definition.controller)};`]),
    `import "../styles/${contract.tag}.css";`,
    "",
    ...(needsRuntime ? [`const definition = ${serializedDefinition(definition)};`, ""] : []),
    `export function create${contract.name}(options${hasRequired ? "" : " = {}"}) {`,
    `  const { attributes = {}, children = [], slots = {}, as${needsRuntime || directProps !== undefined ? ", ...componentProps" : ""} } = options;`,
    ...(direct === undefined
      ? []
      : [
          ...[...direct.states.values()].map(({ variable, initial }) => `  let ${variable} = ${String(initial)};`),
          ...[...direct.computed.values()].map(({ variable }) => `  let ${variable};`),
        ]),
    ...(directProps === undefined
      ? []
      : [...directProps.props.entries()].map(([name, prop]) =>
        `  const ${prop.variable} = componentProps[${js(name)}] === undefined ? ${"default" in prop.contract ? JSON.stringify(prop.contract.default) : "undefined"} : componentProps[${js(name)}];`
      )),
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
  const directPropRender: DirectPropRenderContext | undefined = directProps === undefined
    ? undefined
    : { plan: directProps, bindings: [] };
  renderAttributes(
    template,
    "element",
    lines,
    contract.props,
    valueCounter,
    "  ",
    directRender,
    directPropRender,
  );
  if (directRender !== undefined) collectDirectEvents(template, "element", directRender);
  lines.push(`  element.setAttribute("data-component", ${js(contract.tag)});`);
  const counter: RenderCounter = { value: 0, svgParents: new Set() };
  for (const child of template.children) {
    renderNode(
      child,
      lines,
      counter,
      "element",
      contract.props,
      valueCounter,
      contract.tag,
      "slots",
      directRender,
      directPropRender,
    );
  }
  if (directRender !== undefined) {
    const directPlan = directRender.plan;
    lines.push("  let pending = false;");
    lines.push("  const update = () => {");
    lines.push("    pending = false;");
    for (const { variable, expression } of directPlan.computed.values()) {
      lines.push(`    ${variable} = ${expression};`);
    }
    for (const binding of directRender.bindings) {
      lines.push(`    ${binding.element}.textContent = String(${directPlan.values.get(binding.state)!.variable});`);
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
  if (directPropRender !== undefined) {
    lines.push("  manageGeneratedProps(element, [");
    for (const [name, prop] of directPropRender.plan.props) {
      const type = directPropType(prop.contract)!;
      lines.push(
        // The raw option (undefined when omitted) so only explicit values are reflected.
        `    { name: ${js(name)}, attribute: ${js(`data-${kebabCase(name)}`)}, value: componentProps[${js(name)}]${"default" in prop.contract ? `, default: ${JSON.stringify(prop.contract.default)}` : ""}${template.attributes.some((binding) => binding.kind === "attribute" && binding.name === `data-${kebabCase(name)}`) ? ", bound: true" : ""}, type: ${typeof type === "string" ? js(type) : JSON.stringify(type)}, required: ${String(prop.contract.required)} },`,
      );
    }
    if (directPropRender.bindings.length === 0) {
      lines.push("  ]);");
    } else {
      lines.push("  ], (name, value) => {");
      for (const [name] of directPropRender.plan.props) {
        const bindings = directPropRender.bindings.filter((binding) => binding.prop === name);
        if (bindings.length === 0) continue;
        lines.push(`    if (name === ${js(name)}) {`);
        for (const binding of bindings) {
          if (binding.kind === "text") {
            lines.push(`      ${binding.element}.textContent = value == null ? "" : String(value);`);
          } else {
            lines.push(`      if (value === null || value === undefined || value === false) ${binding.element}.removeAttribute(${js(binding.name!)});`);
            lines.push(`      else ${binding.element}.setAttribute(${js(binding.name!)}, value === true ? "" : String(value));`);
          }
        }
        lines.push("    }");
      }
      lines.push("  });");
    }
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
      ([name, prop]) => `  ${tsKey(name)}${optional(prop)}: ${propTypeSource(prop)};`,
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
