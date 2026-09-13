import type { ExpressionNode } from "../expression.js";
import type {
  ComponentDefinition,
  EventDeclaration,
  HandlerDeclaration,
  HandlerStep,
  ReactiveDeclaration,
  TemplateNode,
} from "../template.js";

export interface NativeState {
  readonly name: string;
  readonly variable: string;
  readonly setter: string;
  readonly initial: string;
}

export interface NativeComputed {
  readonly name: string;
  readonly variable: string;
  readonly expression: string;
  readonly ast: ExpressionNode;
}

export interface NativeHandler {
  readonly name: string;
  readonly variable: string;
  readonly declaration: HandlerDeclaration;
}

export interface NativeDispatch {
  readonly event: string;
  readonly type: string;
  readonly detail: string;
  readonly bubbles: boolean;
  readonly composed: boolean;
  readonly cancelable: boolean;
}

export function nativeEventDispatch(target: string, dispatch: NativeDispatch): string {
  return `dispatchGeneratedEvent(${target}, { name: ${JSON.stringify(dispatch.event)}, type: ${JSON.stringify(dispatch.type)}, detail: ${dispatch.detail}, bubbles: ${dispatch.bubbles}, composed: ${dispatch.composed}, cancelable: ${dispatch.cancelable} })`;
}

export function hasNativeDispatch(plan: NativeReactivePlan | undefined): boolean {
  return plan?.handlers.some(({ declaration }) =>
    declaration.steps.some(({ kind }) => kind === "dispatch")
  ) ?? false;
}

export interface NativeReactivePlan {
  readonly values: ReadonlyMap<string, string>;
  readonly states: readonly NativeState[];
  readonly computed: readonly NativeComputed[];
  readonly handlers: readonly NativeHandler[];
}

export function nativeDispatch(
  step: Extract<HandlerStep, { readonly kind: "dispatch" }>,
  events: readonly EventDeclaration[],
  values: ReadonlyMap<string, string>,
): NativeDispatch | undefined {
  const declaration = events.find(({ name }) => name === step.event);
  const detail = step.value === undefined ? "undefined" : nativeExpression(step.value.ast, values);
  if (declaration === undefined || detail === undefined) return undefined;
  return {
    event: step.event,
    type: declaration.type,
    detail,
    bubbles: declaration.bubbles,
    composed: declaration.composed,
    cancelable: declaration.cancelable,
  };
}

const operators: Readonly<Record<string, string>> = {
  and: "&&",
  or: "||",
  "=": "===",
  "!=": "!==",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

export function nativeExpression(
  node: ExpressionNode,
  values: ReadonlyMap<string, string>,
): string | undefined {
  if (node.kind === "literal") {
    if (typeof node.value === "symbol" || typeof node.value === "object" && node.value !== null) return undefined;
    return JSON.stringify(node.value);
  }
  if (node.kind === "id") return values.get(node.name);
  if (node.kind === "unary") {
    const operand = nativeExpression(node.operand, values);
    if (operand === undefined) return undefined;
    return node.op === "not" ? `(!${operand})` : `(-${operand})`;
  }
  if (node.kind === "binary") {
    const operator = operators[node.op];
    const left = nativeExpression(node.left, values);
    const right = nativeExpression(node.right, values);
    return operator === undefined || left === undefined || right === undefined
      ? undefined
      : `(${left} ${operator} ${right})`;
  }
  if (node.kind === "call" && ["abs", "round", "min", "max", "clamp"].includes(node.fn)) {
    const args = node.args.map((argument) => nativeExpression(argument, values));
    if (args.some((argument) => argument === undefined)) return undefined;
    if ((node.fn === "abs" || node.fn === "round") && args.length !== 1) return undefined;
    if ((node.fn === "min" || node.fn === "max") && args.length === 0) return undefined;
    if (node.fn === "clamp" && args.length !== 3) return undefined;
    if (node.fn === "clamp") return `Math.min(Math.max(${args[0]}, ${args[1]}), ${args[2]})`;
    return `Math.${node.fn}(${args.join(", ")})`;
  }
  return undefined;
}

function templateSupported(
  node: TemplateNode,
  values: ReadonlyMap<string, string>,
  handlers: ReadonlySet<string>,
): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot") {
    return node.nameExpression === undefined &&
      (node.fallback ?? []).every((child) => templateSupported(child, values, handlers));
  }
  if (node.flow !== undefined || node.ref !== undefined) return false;
  if (!(node.events ?? []).every((event) =>
    event.modifiers.length === 0 && /^[a-z][a-z0-9]*$/.test(event.name) && handlers.has(event.handler)
  )) {
    return false;
  }
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    if (attribute.expressionPlan === undefined || nativeExpression(attribute.expressionPlan.ast, values) === undefined) {
      return false;
    }
    if (attribute.kind === "directive" && attribute.name !== "value") return false;
    if (attribute.kind === "attribute" && attribute.twoWay === true) return false;
  }
  return node.children.every((child) => templateSupported(child, values, handlers));
}

export function nativeReactivePlan(
  definition: ComponentDefinition,
  propValues?: ReadonlyMap<string, string>,
): NativeReactivePlan | undefined {
  if (definition.controller !== undefined) return undefined;
  const declarations = definition.declarations ?? [];
  if (declarations.length === 0) return undefined;
  if (declarations.some((declaration) =>
    declaration.kind !== "state" && declaration.kind !== "computed" &&
    declaration.kind !== "event" && declaration.kind !== "handler"
  )) return undefined;

  const values = new Map<string, string>(propValues ??
    Object.keys(definition.contract.props).map((name, index) => [name, `prop${index}`]));
  const states: NativeState[] = [];
  const computed: NativeComputed[] = [];
  const reactive = declarations.filter(
    (declaration): declaration is ReactiveDeclaration => declaration.kind === "state" || declaration.kind === "computed",
  );
  for (const [index, declaration] of reactive.entries()) {
    const expression = declaration.expression === undefined
      ? undefined
      : nativeExpression(declaration.expression.ast, values);
    if (expression === undefined) return undefined;
    if (declaration.kind === "state") {
      const state = {
        name: declaration.name,
        variable: `state${index}`,
        setter: `setState${index}`,
        initial: expression,
      };
      states.push(state);
      values.set(declaration.name, state.variable);
    } else {
      const value = {
        name: declaration.name,
        variable: `computed${index}`,
        expression,
        ast: declaration.expression!.ast,
      };
      computed.push(value);
      values.set(declaration.name, value.variable);
    }
  }

  const handlers = declarations.filter(
    (declaration): declaration is HandlerDeclaration => declaration.kind === "handler",
  ).map((declaration, index) => ({
    name: declaration.name,
    variable: `handler${index}`,
    declaration,
  }));
  const stateNames = new Set(states.map(({ name }) => name));
  const events = declarations.filter(
    (declaration): declaration is EventDeclaration => declaration.kind === "event",
  );
  for (const handler of handlers) {
    if (handler.declaration.steps.length === 0 || handler.declaration.steps.some((step) => {
      if (step.guard !== undefined) return true;
      if (step.kind === "dispatch") return nativeDispatch(step, events, values) === undefined;
      return step.kind !== "set" || step.writablePath.length !== 1 ||
        typeof step.writablePath[0] !== "string" || !stateNames.has(step.writablePath[0]) ||
        nativeExpression(step.value.ast, values) === undefined;
    })) return undefined;
  }
  if (!templateSupported(definition.template, values, new Set(handlers.map(({ name }) => name)))) {
    return undefined;
  }
  return Object.freeze({
    values,
    states: Object.freeze(states),
    computed: Object.freeze(computed),
    handlers: Object.freeze(handlers),
  });
}
