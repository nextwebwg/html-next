import { isEnumeratedBoolean, type ExpressionNode } from "../expression.js";
import type {
  AttributeBinding,
  ComponentDefinition,
  ElementNode,
  EventDeclaration,
  HandlerDeclaration,
  HandlerStep,
  PropertyBinding,
  ReactiveDeclaration,
  SlotNode,
  TemplateAttribute,
  TemplateNode,
} from "../template.js";
import { rootArms } from "../template.js";
import type { PropContract } from "../types.js";
import { parseTypeExpression, parseTypedValue } from "../type-system.js";
import { isUrlAttribute } from "../sanitize.js";
import { getDomInterface, resolveDomProperty } from "../platform.js";
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
  readonly kind: "text" | "attribute" | "class" | "style" | "property" | "bound-value" | "bound-checked" | "bound-number";
  readonly expression?: DirectExpression;
  readonly dependencies?: readonly string[];
  readonly name?: string;
  readonly event?: "change" | "input";
}

interface DirectEvent {
  readonly element: string;
  readonly name: string;
  readonly handler: string;
  readonly modifiers: readonly string[];
}

interface DirectState {
  readonly variable: string;
  readonly initial: DirectPrimitive;
  readonly bit: number;
  readonly kind: DirectPrimitiveKind;
}

interface DirectComputed {
  readonly variable: string;
  readonly expression: string;
  readonly dependencies: readonly string[];
  readonly initial: DirectPrimitive;
  readonly bit: number;
  readonly kind: DirectPrimitiveKind;
  readonly stabilizes: boolean;
}

interface DirectValue {
  readonly variable: string;
  readonly bit: number;
  readonly kind: DirectPrimitiveKind;
  /** A construction-only computed can be emitted directly at each use site. */
  readonly source?: string;
}

interface DirectReactivePlan {
  readonly states: ReadonlyMap<string, DirectState>;
  readonly computed: ReadonlyMap<string, DirectComputed>;
  readonly values: ReadonlyMap<string, DirectValue>;
  readonly handlers: ReadonlyMap<string, { readonly variable: string; readonly declaration: HandlerDeclaration }>;
  readonly events: readonly EventDeclaration[];
  readonly readOnly: boolean;
}

interface DirectRenderContext {
  readonly plan: DirectReactivePlan;
  readonly bindings: DirectBinding[];
  readonly events: DirectEvent[];
  /** Static refs resolve to the last template element carrying their name. */
  readonly refs: Map<string, string>;
}

interface DirectProp {
  readonly variable: string;
  readonly contract: PropContract;
}

interface DirectPropBinding {
  readonly element: string;
  readonly prop: string;
  readonly kind: "attribute" | "property" | "text";
  readonly name?: string;
}

interface DirectPropPlan {
  readonly props: ReadonlyMap<string, DirectProp>;
}

interface DirectPropRenderContext {
  readonly plan: DirectPropPlan;
  readonly bindings: DirectPropBinding[];
}

type DirectPrimitive = boolean | number | string;
type DirectPrimitiveKind = "boolean" | "number" | "string";

interface DirectExpression {
  readonly source: string;
  readonly kind: DirectPrimitiveKind;
}

function finiteNumber(node: ExpressionNode): number | undefined {
  return node.kind === "literal" && typeof node.value === "number" && Number.isFinite(node.value)
    ? node.value
    : undefined;
}

function directLiteralValue(node: ExpressionNode): DirectPrimitive | undefined {
  if (node.kind !== "literal") return undefined;
  if (typeof node.value === "boolean" || typeof node.value === "string") return node.value;
  return finiteNumber(node);
}

function directLiteral(node: ExpressionNode): DirectExpression | undefined {
  const value = directLiteralValue(node);
  return value === undefined ? undefined : {
    source: directPrimitiveSource(value),
    kind: directPrimitiveKind(value),
  };
}

function directFormatSource(pattern: string, values: readonly DirectExpression[]): string {
  const parts = pattern.split("%s");
  const source = [js(parts[0]!)];
  for (let index = 1; index < parts.length; index += 1) {
    source.push(index <= values.length ? `String(${values[index - 1]!.source})` : js("%s"));
    source.push(js(parts[index]!));
  }
  return `(${source.join(" + ")})`;
}

function directFormatValue(pattern: string, values: readonly DirectPrimitive[]): string {
  let index = 0;
  return pattern.replace(/%s/g, () => index < values.length ? String(values[index++]!) : "%s");
}

function directSetExpression(
  node: ExpressionNode,
  state: DirectState,
  values: ReadonlyMap<string, DirectValue>,
): string | undefined {
  const expression = directPrimitiveExpression(node, values);
  if (expression?.kind !== state.kind) return undefined;
  // Preserve the compact established numeric increment/decrement emission for the common case.
  if (state.kind === "number" && node.kind === "binary" && (node.op === "+" || node.op === "-") &&
    node.left.kind === "id" && node.left.name !== undefined && values.get(node.left.name)?.variable === state.variable) {
    const value = finiteNumber(node.right);
    if (value !== undefined) return `${state.variable} ${node.op} ${value}`;
  }
  return expression.source;
}

/**
 * Emit only primitive expressions whose JavaScript semantics exactly match the expression
 * interpreter. Keeping the inferred primitive kind lets assignment stay monomorphic, rather
 * than relying on JavaScript coercion for mixed numeric and boolean operations.
 */
function directPrimitiveExpression(
  node: ExpressionNode,
  values: ReadonlyMap<string, DirectValue>,
): DirectExpression | undefined {
  const literal = directLiteral(node);
  if (literal !== undefined) return literal;
  if (node.kind === "id") {
    const value = values.get(node.name);
    return value === undefined ? undefined : { source: value.source ?? value.variable, kind: value.kind };
  }
  if (node.kind === "unary") {
    const operand = directPrimitiveExpression(node.operand, values);
    if (operand === undefined) return undefined;
    if (node.op === "-") {
      return operand.kind === "number" ? { source: `(-${operand.source})`, kind: "number" } : undefined;
    }
    return { source: `!Boolean(${operand.source})`, kind: "boolean" };
  }
  if (node.kind === "binary") {
    const left = directPrimitiveExpression(node.left, values);
    const right = directPrimitiveExpression(node.right, values);
    if (left === undefined || right === undefined) return undefined;
    if (["+", "-", "*", "/", "%"].includes(node.op)) {
      return left.kind === "number" && right.kind === "number"
        ? { source: `(${left.source} ${node.op} ${right.source})`, kind: "number" }
        : undefined;
    }
    if (node.op === "=") return { source: `(${left.source} === ${right.source})`, kind: "boolean" };
    if (node.op === "!=") return { source: `(${left.source} !== ${right.source})`, kind: "boolean" };
    if (["^=", "$=", "*="].includes(node.op)) {
      if (left.kind !== "string" || right.kind !== "string") return undefined;
      const method = node.op === "^=" ? "startsWith" : node.op === "$=" ? "endsWith" : "includes";
      return { source: `${left.source}.${method}(${right.source})`, kind: "boolean" };
    }
    if (node.op === "and" || node.op === "or") {
      return {
        source: `(Boolean(${left.source}) ${node.op === "and" ? "&&" : "||"} Boolean(${right.source}))`,
        kind: "boolean",
      };
    }
    return undefined;
  }
  if (node.kind === "call" && node.fn === "format") {
    const pattern = node.args[0];
    if (pattern?.kind !== "literal" || typeof pattern.value !== "string") return undefined;
    const args = node.args.slice(1).map((argument) => directPrimitiveExpression(argument, values));
    if (args.some((argument) => argument === undefined)) return undefined;
    return { source: directFormatSource(pattern.value, args as DirectExpression[]), kind: "string" };
  }
  if (node.kind !== "call" || !["abs", "round", "min", "max", "clamp"].includes(node.fn)) return undefined;
  const args = node.args.map((argument) => directPrimitiveExpression(argument, values));
  if (args.some((argument) => argument?.kind !== "number")) return undefined;
  if ((node.fn === "abs" || node.fn === "round") && args.length !== 1) return undefined;
  if ((node.fn === "min" || node.fn === "max") && args.length === 0) return undefined;
  if (node.fn === "clamp" && args.length !== 3) return undefined;
  if (node.fn === "clamp") {
    return { source: `Math.min(Math.max(${args[0]!.source}, ${args[1]!.source}), ${args[2]!.source})`, kind: "number" };
  }
  return { source: `Math.${node.fn}(${args.map((argument) => argument!.source).join(", ")})`, kind: "number" };
}

/** The direct primitive subset has only identifier references and side-effect-free operations. */
function directDependencies(node: ExpressionNode): readonly string[] {
  const names = new Set<string>();
  const visit = (current: ExpressionNode): void => {
    if (current.kind === "id") {
      names.add(current.name);
      return;
    }
    if (current.kind === "unary") {
      visit(current.operand);
      return;
    }
    if (current.kind === "binary") {
      visit(current.left);
      visit(current.right);
      return;
    }
    if (current.kind === "call") {
      for (const argument of current.args) visit(argument);
    }
  };
  visit(node);
  return [...names];
}

/** A handlerless, unbound direct leaf cannot mutate any of its private state after construction. */
function directValueIsStatic(
  name: string,
  plan: DirectReactivePlan,
  seen = new Set<string>(),
): boolean {
  if (plan.readOnly && plan.states.has(name)) return true;
  const computed = plan.computed.get(name);
  if (computed === undefined || seen.has(name)) return false;
  const nextSeen = new Set(seen).add(name);
  return computed.dependencies.every((dependency) => directValueIsStatic(dependency, plan, nextSeen));
}

/** Literal expressions and chains of constant direct computeds are construction-only. */
function directExpressionIsStatic(node: ExpressionNode, plan: DirectReactivePlan): boolean {
  return directDependencies(node).every((name) => directValueIsStatic(name, plan));
}

/** Rounding and range operations can retain the same visible value after a state write. */
function directMayStabilize(node: ExpressionNode, kind: DirectPrimitiveKind): boolean {
  if (kind === "boolean") return true;
  if (node.kind === "literal" || node.kind === "id") return false;
  if (node.kind === "unary") return directMayStabilize(node.operand, kind);
  if (node.kind === "binary") return directMayStabilize(node.left, kind) || directMayStabilize(node.right, kind);
  if (node.kind !== "call") return false;
  return ["round", "min", "max", "clamp"].includes(node.fn) ||
    node.args.some((argument) => directMayStabilize(argument, kind));
}

function directPrimitiveValue(
  node: ExpressionNode,
  values: ReadonlyMap<string, DirectPrimitive>,
): DirectPrimitive | undefined {
  const literal = directLiteralValue(node);
  if (literal !== undefined) return literal;
  if (node.kind === "id") return values.get(node.name);
  if (node.kind === "unary") {
    const operand = directPrimitiveValue(node.operand, values);
    if (operand === undefined) return undefined;
    if (node.op === "-") return typeof operand === "number" ? -operand : undefined;
    return !operand;
  }
  if (node.kind === "binary") {
    const left = directPrimitiveValue(node.left, values);
    const right = directPrimitiveValue(node.right, values);
    if (left === undefined || right === undefined) return undefined;
    if (node.op === "=") return left === right;
    if (node.op === "!=") return left !== right;
    if (["^=", "$=", "*="].includes(node.op)) {
      if (typeof left !== "string" || typeof right !== "string") return undefined;
      if (node.op === "^=") return left.startsWith(right);
      if (node.op === "$=") return left.endsWith(right);
      return left.includes(right);
    }
    if (node.op === "and") return Boolean(left) && Boolean(right);
    if (node.op === "or") return Boolean(left) || Boolean(right);
    if (typeof left !== "number" || typeof right !== "number") return undefined;
    switch (node.op) {
      case "+": return left + right;
      case "-": return left - right;
      case "*": return left * right;
      case "/": return left / right;
      case "%": return left % right;
      default: return undefined;
    }
  }
  if (node.kind === "call" && node.fn === "format") {
    const pattern = node.args[0];
    if (pattern?.kind !== "literal" || typeof pattern.value !== "string") return undefined;
    const args = node.args.slice(1).map((argument) => directPrimitiveValue(argument, values));
    return args.some((argument) => argument === undefined)
      ? undefined
      : directFormatValue(pattern.value, args as DirectPrimitive[]);
  }
  if (node.kind !== "call") return undefined;
  const args = node.args.map((argument) => directPrimitiveValue(argument, values));
  if (args.some((argument) => typeof argument !== "number")) return undefined;
  const numbers = args as number[];
  if (node.fn === "abs" && numbers.length === 1) return Math.abs(numbers[0]!);
  if (node.fn === "round" && numbers.length === 1) return Math.round(numbers[0]!);
  if (node.fn === "min" && numbers.length > 0) return Math.min(...numbers);
  if (node.fn === "max" && numbers.length > 0) return Math.max(...numbers);
  if (node.fn === "clamp" && numbers.length === 3) return Math.min(Math.max(numbers[0]!, numbers[1]!), numbers[2]!);
  return undefined;
}

function directPrimitiveSource(value: DirectPrimitive): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return js(value);
  if (Number.isNaN(value)) return "Number.NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return Object.is(value, -0) ? "-0" : String(value);
}

function directPrimitiveKind(value: DirectPrimitive): DirectPrimitiveKind {
  if (typeof value === "boolean") return "boolean";
  return typeof value === "string" ? "string" : "number";
}

/** The direct dispatch boundary accepts primitive detail and delegates declaration validation. */
function directDispatch(
  step: Extract<HandlerStep, { readonly kind: "dispatch" }>,
  events: readonly EventDeclaration[],
  values: ReadonlyMap<string, DirectValue>,
): string | undefined {
  const declaration = events.find((event) => event.name === step.event);
  if (declaration === undefined) return undefined;
  const expression = step.value === undefined ? undefined : directPrimitiveExpression(step.value.ast, values);
  const detail = step.value === undefined ? "undefined" : expression?.source;
  if (detail === undefined) return undefined;
  return `{ name: ${js(declaration.name)}, type: ${js(declaration.type)}, detail: ${detail}, ` +
    `bubbles: ${String(declaration.bubbles)}, composed: ${String(declaration.composed)}, cancelable: ${String(declaration.cancelable)} }`;
}

/** Return declaration-ordered transitive computed inputs for a synchronous direct read. */
function directComputedClosure(
  dependencies: readonly string[],
  computed: ReadonlyMap<string, DirectComputed>,
): readonly string[] {
  if (!dependencies.some((name) => computed.has(name))) return [];
  const required = new Set<string>();
  const visit = (name: string): void => {
    const value = computed.get(name);
    if (value === undefined || required.has(name)) return;
    required.add(name);
    for (const dependency of value.dependencies) visit(dependency);
  };
  for (const dependency of dependencies) visit(dependency);
  return [...computed.keys()].filter((name) => required.has(name));
}

/** Return a dispatch expression's declaration-ordered transitive computed inputs. */
function directDispatchComputedClosure(
  step: HandlerStep,
  computed: ReadonlyMap<string, DirectComputed>,
): readonly string[] {
  return step.kind !== "dispatch" || step.value === undefined
    ? []
    : directComputedClosure(directDependencies(step.value.ast), computed);
}

/** Return a guard expression's declaration-ordered transitive computed inputs. */
function directGuardComputedClosure(
  step: HandlerStep,
  computed: ReadonlyMap<string, DirectComputed>,
): readonly string[] {
  return step.guard === undefined
    ? []
    : directComputedClosure(directDependencies(step.guard.ast), computed);
}

/** A direct read must remain inert when its declared state type rejects the static value. */
function directStateConforms(declaration: ReactiveDeclaration, value: DirectPrimitive): boolean {
  return declaration.type === undefined || parseTypedValue(value, parseTypeExpression(declaration.type)).ok;
}

/** Direct primitive values can use native runtime-equivalent serialization without a shared helper. */
function directNativeAttribute(attribute: TemplateAttribute): attribute is AttributeBinding {
  return attribute.kind === "attribute" && attribute.target === undefined && attribute.twoWay !== true;
}

function directClassAttribute(attribute: TemplateAttribute): attribute is AttributeBinding {
  return attribute.kind === "attribute" && attribute.target === "class" && attribute.twoWay !== true;
}

/** The live runtime writes style values through CSSStyleDeclaration.setProperty(). */
function directStyleAttribute(attribute: TemplateAttribute): attribute is AttributeBinding {
  return attribute.kind === "attribute" && attribute.target === "style" && attribute.twoWay !== true;
}

/** SVG needs the live runtime's browser-assisted name adjustment; data and ARIA names do not. */
function directAttributeSupported(
  attribute: TemplateAttribute,
  svg: boolean,
  kind: DirectPrimitiveKind,
): attribute is AttributeBinding {
  return directNativeAttribute(attribute) && (!svg ||
    attribute.name.startsWith("data-") || attribute.name.startsWith("aria-")) &&
    (kind !== "string" || !isUrlAttribute(attribute.name));
}

/** The live runtime assigns native HTML properties directly; the primitive direct subset can do so too. */
function directNativeProperty(
  attribute: TemplateAttribute,
  element: string,
  svg: boolean,
): attribute is PropertyBinding {
  return !svg && attribute.kind === "property" && resolveDomProperty(element, attribute.name) !== undefined;
}

function directInputType(node: ElementNode): string {
  const type = node.attributes.find((attribute) => attribute.kind === "literal" && attribute.name === "type");
  return type?.kind === "literal" ? type.value.toLowerCase() : "text";
}

/**
 * A native text, checkbox, or range control is only direct when its native event preserves the
 * static primitive state domain. Editable number/file/radio/choice controls differ materially.
 */
function directBoundControlAttribute(
  node: ElementNode,
  attribute: TemplateAttribute,
  values: ReadonlyMap<string, DirectValue>,
  states: ReadonlySet<string>,
): attribute is AttributeBinding {
  if (attribute.kind !== "attribute" || attribute.target !== undefined || attribute.twoWay !== true) return false;
  const name = attribute.expressionPlan?.ast.kind === "id" ? attribute.expressionPlan.ast.name : undefined;
  const value = name === undefined ? undefined : values.get(name);
  if (name === undefined || !states.has(name) ||
    attribute.writablePath?.length !== 1 || attribute.writablePath[0] !== name) return false;
  const checkbox = node.name === "input" && directInputType(node) === "checkbox" && attribute.name === "checked";
  if (checkbox) return value?.kind === "boolean" && !(node.events ?? []).some((binding) => binding.name === "change");
  const range = node.name === "input" && directInputType(node) === "range" && attribute.name === "value";
  if (range) return value?.kind === "number" && !(node.events ?? []).some((binding) => binding.name === "input");
  if (value?.kind !== "string") return false;
  const event = node.name === "select" ? "change" : "input";
  if ((node.events ?? []).some((binding) => binding.name === event)) return false;
  if (node.name === "textarea") return attribute.name === "value";
  if (node.name === "select") {
    return attribute.name === "value" && !node.attributes.some(
      (candidate) => candidate.kind === "literal" && candidate.name === "multiple",
    );
  }
  if (node.name !== "input" || attribute.name !== "value") return false;
  return !["checkbox", "radio", "number", "range", "file"].includes(directInputType(node));
}

function directEventSupported(event: Pick<DirectEvent, "name" | "modifiers">): boolean {
  const supported = new Set([
    "prevent", "stop", "self", "left", "middle", "right",
    "ctrl", "shift", "alt", "meta", "exact",
    "enter", "escape", "space", "tab", "up", "down", "capture", "passive", "once",
  ]);
  return event.modifiers.every((modifier) => supported.has(modifier));
}

/** Lifecycle callbacks receive a synthetic Event, so self and required system keys cannot pass. */
function directLifecycleEventPasses(event: Pick<DirectEvent, "name" | "modifiers">): boolean {
  return !["connect", "disconnect"].includes(event.name) ||
    !event.modifiers.includes("self") &&
    !event.modifiers.some((modifier) => ["ctrl", "shift", "alt", "meta"].includes(modifier));
}

/** Emit the live eventPasses predicate in its original filter order. */
function directEventFilterLines(event: DirectEvent): readonly string[] {
  const lines: string[] = [];
  if (event.modifiers.includes("self")) lines.push(`if (event.target !== ${event.element}) return;`);
  const mouseButtons: Readonly<Record<string, number>> = { left: 0, middle: 1, right: 2 };
  const selectedButtons = event.modifiers.filter((modifier) => modifier in mouseButtons).map((modifier) => mouseButtons[modifier]!);
  if (selectedButtons.length > 0) {
    lines.push(`if (event instanceof MouseEvent && ${selectedButtons.map((button) => `event.button !== ${button}`).join(" && ")}) return;`);
  }
  const systemKeys = ["ctrl", "shift", "alt", "meta"] as const;
  for (const key of systemKeys) {
    if (event.modifiers.includes(key)) lines.push(`if (!event.${key}Key) return;`);
  }
  if (event.modifiers.includes("exact")) {
    for (const key of systemKeys) {
      if (!event.modifiers.includes(key)) lines.push(`if (event.${key}Key) return;`);
    }
  }
  const keyboardKeys: Readonly<Record<string, string>> = {
    enter: "Enter", escape: "Escape", space: " ", tab: "Tab",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  };
  const selectedKeys = event.modifiers.filter((modifier) => modifier in keyboardKeys).map((modifier) => js(keyboardKeys[modifier]!));
  if (selectedKeys.length > 0) {
    lines.push(`if (event instanceof KeyboardEvent && ${selectedKeys.map((key) => `event.key !== ${key}`).join(" && ")}) return;`);
  }
  return lines;
}

function directEventListenerOptions(event: DirectEvent): string | undefined {
  const options = [
    ...(event.modifiers.includes("capture") ? ["capture: true"] : []),
    ...(event.modifiers.includes("passive") ? ["passive: true"] : []),
    ...(event.modifiers.includes("once") ? ["once: true"] : []),
  ];
  return options.length === 0 ? undefined : `{ ${options.join(", ")} }`;
}

function directTemplateSupported(
  node: TemplateNode,
  values: ReadonlyMap<string, DirectValue>,
  handlers: ReadonlySet<string>,
  states: ReadonlySet<string>,
  svgParent = false,
): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot") return false;
  if (node.flow !== undefined) return false;
  const svg = node.name === "svg" || (svgParent && node.name !== "foreignObject");
  if (!(node.events ?? []).every((event) => directEventSupported(event) && handlers.has(event.handler))) return false;
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    const expression = attribute.expressionPlan === undefined
      ? undefined
      : directPrimitiveExpression(attribute.expressionPlan.ast, values);
    const dynamicExpression = expression !== undefined && attribute.expressionPlan !== undefined &&
      directDependencies(attribute.expressionPlan.ast).length > 0;
    const staticExpression = expression !== undefined && attribute.expressionPlan !== undefined &&
      directDependencies(attribute.expressionPlan.ast).length === 0;
    if (attribute.kind === "directive" && attribute.name === "value" && (dynamicExpression || staticExpression)) continue;
    if (directBoundControlAttribute(node, attribute, values, states)) continue;
    if (directClassAttribute(attribute) && (dynamicExpression || staticExpression)) continue;
    if (directStyleAttribute(attribute) && (dynamicExpression || staticExpression)) continue;
    if (directAttributeSupported(attribute, svg, expression?.kind ?? "number") && (dynamicExpression || staticExpression)) continue;
    if (directNativeProperty(attribute, node.name, svg) && (dynamicExpression || staticExpression)) continue;
    return false;
  }
  return node.children.every((child) => directTemplateSupported(child, values, handlers, states, svg));
}

/** Flow-free direct templates resolve duplicate refs in the live runtime's render order. */
function directTemplateRefs(node: TemplateNode, refs = new Set<string>()): ReadonlySet<string> {
  if (node.kind !== "element") return refs;
  if (node.ref !== undefined) refs.add(node.ref);
  for (const child of node.children) directTemplateRefs(child, refs);
  return refs;
}

/** Direct text may observe a static primitive expression; other direct bindings observe one value. */
function directBindingValues(
  node: TemplateNode,
  plan: DirectReactivePlan,
  values: string[] = [],
  svgParent = false,
): readonly string[] {
  if (node.kind !== "element") return values;
  const svg = node.name === "svg" || (svgParent && node.name !== "foreignObject");
  for (const attribute of node.attributes) {
    if (attribute.kind === "directive" && attribute.name === "value" &&
      attribute.expressionPlan !== undefined && !directExpressionIsStatic(attribute.expressionPlan.ast, plan)) {
      values.push(...directDependencies(attribute.expressionPlan.ast));
    } else if (attribute.kind === "attribute" && attribute.twoWay === true &&
      attribute.expressionPlan?.ast.kind === "id") {
      values.push(attribute.expressionPlan.ast.name);
    } else if ((directClassAttribute(attribute) || directStyleAttribute(attribute) ||
      directNativeAttribute(attribute) || directNativeProperty(attribute, node.name, svg)) &&
      attribute.expressionPlan !== undefined && !directExpressionIsStatic(attribute.expressionPlan.ast, plan)) {
      values.push(...directDependencies(attribute.expressionPlan.ast));
    }
  }
  for (const child of node.children) directBindingValues(child, plan, values, svg);
  return values;
}

/** Retain fixed computed variables used by construction-time direct bindings. */
function directStaticBindingValues(
  node: TemplateNode,
  plan: DirectReactivePlan,
  values: string[] = [],
  svgParent = false,
): readonly string[] {
  if (node.kind !== "element") return values;
  const svg = node.name === "svg" || (svgParent && node.name !== "foreignObject");
  for (const attribute of node.attributes) {
    const supported = attribute.kind === "directive" && attribute.name === "value" ||
      directClassAttribute(attribute) || directStyleAttribute(attribute) ||
      directNativeAttribute(attribute) || directNativeProperty(attribute, node.name, svg);
    if (supported && attribute.expressionPlan !== undefined &&
      directExpressionIsStatic(attribute.expressionPlan.ast, plan)) {
      values.push(...directDependencies(attribute.expressionPlan.ast));
    }
  }
  for (const child of node.children) directStaticBindingValues(child, plan, values, svg);
  return values;
}

/** Inline direct expressions deliberately skip the identifier-only rendered-value cache. */
function hasDirectExpressionBinding(
  node: TemplateNode,
  plan: DirectReactivePlan,
  svgParent = false,
): boolean {
  if (node.kind !== "element") return false;
  const svg = node.name === "svg" || (svgParent && node.name !== "foreignObject");
  return node.attributes.some((attribute) =>
    (attribute.kind === "directive" && attribute.name === "value" ||
      directClassAttribute(attribute) || directStyleAttribute(attribute) ||
      directNativeAttribute(attribute) || directNativeProperty(attribute, node.name, svg)) &&
    attribute.expressionPlan !== undefined && attribute.expressionPlan.ast.kind !== "id" &&
    !directExpressionIsStatic(attribute.expressionPlan.ast, plan)
  ) || node.children.some((child) => hasDirectExpressionBinding(child, plan, svg));
}

function directExpressionBinding(
  attribute: TemplateAttribute,
  context: DirectRenderContext,
): Pick<DirectBinding, "state" | "expression" | "dependencies"> | undefined {
  if (attribute.kind === "literal" || attribute.expressionPlan === undefined) return undefined;
  const expression = directPrimitiveExpression(attribute.expressionPlan.ast, context.plan.values);
  const dependencies = directDependencies(attribute.expressionPlan.ast);
  return expression === undefined || directExpressionIsStatic(attribute.expressionPlan.ast, context.plan)
    ? undefined
    : { state: dependencies[0]!, expression, dependencies };
}

/** Dependency-free primitive bindings are construction writes, not update-loop bindings. */
function directStaticExpression(
  attribute: TemplateAttribute,
  context: DirectRenderContext,
): DirectExpression | undefined {
  if (attribute.kind === "literal" || attribute.expressionPlan === undefined) return undefined;
  const expression = directPrimitiveExpression(attribute.expressionPlan.ast, context.plan.values);
  return expression === undefined || !directExpressionIsStatic(attribute.expressionPlan.ast, context.plan)
    ? undefined
    : expression;
}

function hasTwoWayBinding(node: TemplateNode): boolean {
  if (node.kind !== "element") return false;
  return node.attributes.some((attribute) => attribute.kind === "attribute" && attribute.twoWay === true) ||
    node.children.some(hasTwoWayBinding);
}

/**
 * A handlerless reactive leaf has no externally writable local state. The unplugin can preserve
 * a bare child invocation, literal invocation data, static projected content, or a literal-only component
 * descendant inside that projection as a factory call. Dynamic content, component inputs, events,
 * refs, and flow still need the general runtime's full contract.
 */
function hasUnsupportedDirectProjection(node: TemplateNode, root = true): boolean {
  if (node.kind !== "element") return node.kind === "slot";
  const staticComponent = node.name.includes("-") && node.children.length === 0 && node.attributes.every((attribute) =>
    attribute.kind === "literal" && attribute.name !== "data-component"
  );
  return (!staticComponent && node.name.includes("-")) || node.flow !== undefined || node.ref !== undefined ||
    (node.events?.length ?? 0) > 0 || node.attributes.some((attribute) =>
      attribute.kind !== "literal" || (!root && attribute.name === "slot")
    ) || node.children.some((child) => hasUnsupportedDirectProjection(child, false));
}

function hasNonBareComponentInvocation(node: TemplateNode): boolean {
  if (node.kind !== "element") return false;
  if (node.name.includes("-") && (
    node.attributes.some((attribute) => attribute.kind !== "literal" || attribute.name === "data-component") ||
    node.children.some((child) => hasUnsupportedDirectProjection(child)) || node.flow !== undefined ||
    node.ref !== undefined || (node.events?.length ?? 0) > 0
  )) return true;
  return node.children.some(hasNonBareComponentInvocation);
}

function hasDirectLifecycleEvent(node: TemplateNode): boolean {
  return node.kind === "element" && (
    (node.events ?? []).some((event) =>
      ((event.name === "connect" || event.name === "disconnect") && directLifecycleEventPasses(event)) ||
      (event.name !== "connect" && event.name !== "disconnect" && event.modifiers.includes("once"))) ||
    node.children.some(hasDirectLifecycleEvent)
  );
}

function hasDirectDisconnectEvent(node: TemplateNode): boolean {
  return node.kind === "element" && (
    (node.events ?? []).some((event) => event.name === "disconnect" && directLifecycleEventPasses(event)) ||
    node.children.some(hasDirectDisconnectEvent)
  );
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
  const events = declarations.filter(
    (declaration): declaration is EventDeclaration => declaration.kind === "event",
  );
  if (reactive.length === 0 && handlers.length === 0) return undefined;
  if (reactive.length + handlers.length + events.length !== declarations.length) return undefined;
  const refs = directTemplateRefs(definition.template);

  const states = new Map<string, DirectState>();
  const computed = new Map<string, DirectComputed>();
  const values = new Map<string, DirectValue>();
  const initialValues = new Map<string, DirectPrimitive>();
  // The live runtime initializes every state before it defines any computed value. A state may
  // therefore read an earlier state here, but must not observe a precomputed declaration.
  const initialStates = new Map<string, DirectPrimitive>();
  for (const [index, declaration] of reactive.entries()) {
    const variable = declaration.kind === "state" ? `state${index}` : `computed${index}`;
    const bit = 2 ** index;
    if (declaration.kind === "state") {
      const initial = declaration.expression === undefined ? undefined : directPrimitiveValue(declaration.expression.ast, initialStates);
      if (initial === undefined || !directStateConforms(declaration, initial)) return undefined;
      const state = { variable, initial, bit, kind: directPrimitiveKind(initial) };
      states.set(declaration.name, state);
      values.set(declaration.name, state);
      initialValues.set(declaration.name, initial);
      initialStates.set(declaration.name, initial);
      continue;
    }
    const expression = declaration.expression === undefined
      ? undefined
      : directPrimitiveExpression(declaration.expression.ast, values);
    const initial = declaration.expression === undefined
      ? undefined
      : directPrimitiveValue(declaration.expression.ast, initialValues);
    if (expression === undefined || initial === undefined || expression.kind !== directPrimitiveKind(initial)) return undefined;
    const derived = {
      variable,
      expression: expression.source,
      dependencies: directDependencies(declaration.expression!.ast),
      initial,
      bit,
      kind: expression.kind,
      stabilizes: directMayStabilize(declaration.expression!.ast, expression.kind),
    };
    computed.set(declaration.name, derived);
    values.set(declaration.name, derived);
    initialValues.set(declaration.name, initial);
  }

  const handlerPlans = new Map<string, { variable: string; declaration: HandlerDeclaration }>();
  for (const [index, declaration] of handlers.entries()) {
    if (declaration.steps.length === 0 || declaration.steps.some((step) => {
      if (step.guard !== undefined) {
        const guard = directPrimitiveExpression(step.guard.ast, values);
        if (guard?.kind !== "boolean") return true;
      }
      if (step.kind === "dispatch") return directDispatch(step, events, values) === undefined;
      if (step.kind === "focus" || step.kind === "validate") return !refs.has(step.target);
      if (step.kind !== "set" || step.writablePath.length !== 1 ||
        typeof step.writablePath[0] !== "string" || !states.has(step.writablePath[0])) return true;
      const state = states.get(step.writablePath[0])!;
      return directSetExpression(step.value.ast, state, values) === undefined;
    })) return undefined;
    handlerPlans.set(declaration.name, { variable: `handler${index}`, declaration });
  }
  if (!directTemplateSupported(
    definition.template,
    values,
    new Set(handlerPlans.keys()),
    new Set(states.keys()),
  )) {
    return undefined;
  }
  const readOnly = handlerPlans.size === 0 && !hasTwoWayBinding(definition.template);
  // Mutable declared types are checked when read by the live runtime. The direct path cannot
  // publish an invalid intermediate value (for example, a numeric division by zero) instead.
  if (!readOnly && reactive.some((declaration) => declaration.kind === "state" && declaration.type !== undefined)) {
    return undefined;
  }
  if (readOnly && hasNonBareComponentInvocation(definition.template)) {
    return undefined;
  }
  const plan = { states, computed, values, handlers: handlerPlans, events, readOnly };
  if (readOnly) {
    for (const [name, state] of states) {
      const current = values.get(name)!;
      values.set(name, { ...current, source: directPrimitiveSource(state.initial) });
    }
  }
  for (const [name, value] of computed) {
    if (!directValueIsStatic(name, plan)) continue;
    const current = values.get(name)!;
    values.set(name, { ...current, source: directPrimitiveSource(value.initial) });
  }
  return plan;
}

function directHasDispatch(plan: DirectReactivePlan | undefined): boolean {
  return plan !== undefined && [...plan.handlers.values()].some(({ declaration }) =>
    declaration.steps.some((step) => step.kind === "dispatch")
  );
}

/** Retain handler reads that can reach a rendered value or declared event. */
function directHandlerDependencies(plan: DirectReactivePlan, boundValues: readonly string[]): readonly string[] {
  const names = new Set(boundValues);
  for (const { declaration } of plan.handlers.values()) {
    for (const step of declaration.steps) {
      if (step.guard !== undefined) {
        for (const name of directDependencies(step.guard.ast)) names.add(name);
      }
      if (step.kind === "dispatch" && step.value !== undefined) {
        for (const name of directDependencies(step.value.ast)) names.add(name);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      for (const dependency of plan.computed.get(name)?.dependencies ?? []) {
        if (!names.has(dependency)) { names.add(dependency); changed = true; }
      }
    }
    for (const { declaration } of plan.handlers.values()) {
      for (const step of declaration.steps) {
        if (step.kind !== "set" || !names.has(String(step.writablePath[0]))) continue;
        for (const dependency of directDependencies(step.value.ast)) {
          if (!names.has(dependency)) { names.add(dependency); changed = true; }
        }
      }
    }
  }
  return [...names];
}

function directDependencyMask(
  plan: DirectReactivePlan,
  dependencies: readonly string[],
): number {
  let mask = 0;
  for (const dependency of dependencies) mask |= plan.values.get(dependency)!.bit;
  return mask;
}

/** Retain each bound computed and its declaration-ordered pure dependencies. */
function directLiveComputed(
  plan: DirectReactivePlan,
  boundValues: ReadonlySet<string>,
): ReadonlySet<string> {
  const live = new Set<string>();
  const visit = (name: string): void => {
    const computed = plan.computed.get(name);
    if (computed === undefined || live.has(name)) return;
    live.add(name);
    for (const dependency of computed.dependencies) visit(dependency);
  };
  for (const value of boundValues) visit(value);
  return live;
}

/** A direct state is live when it is bound itself or feeds a retained computed value. */
function directLiveStates(
  plan: DirectReactivePlan,
  boundValues: ReadonlySet<string>,
  liveComputed: ReadonlySet<string>,
): ReadonlySet<string> {
  const live = new Set<string>();
  for (const value of boundValues) {
    if (plan.states.has(value)) live.add(value);
  }
  for (const name of liveComputed) {
    for (const dependency of plan.computed.get(name)!.dependencies) {
      if (plan.states.has(dependency)) live.add(dependency);
    }
  }
  return live;
}

/**
 * Direct components have pure, statically ordered primitive expressions. When at least two state
 * roots and four computed nodes exist, dirty bits let generated code skip unrelated branches and
 * equal-result descendants. Keep the ordinary direct emitter for smaller graphs: its eager
 * straight-line form is smaller than the dependency bookkeeping.
 */
function usesSelectiveDirectUpdates(
  plan: DirectReactivePlan,
  liveComputed: ReadonlySet<string>,
  liveStates: ReadonlySet<string>,
): boolean {
  const count = plan.values.size;
  if (liveStates.size < 2 || liveComputed.size < 4 || count > 30) return false;
  const all = 2 ** count - 1;
  return [...liveComputed].some((name) =>
    directDependencyMask(plan, plan.computed.get(name)!.dependencies) !== all
  );
}

function directPropType(prop: PropContract): "string" | "boolean" | "number" | readonly string[] | undefined {
  if (prop.pattern !== undefined) return undefined;
  if (prop.type === "string" || prop.type === "boolean" || prop.type === "number") return prop.type;
  if ("enum" in prop.type) return prop.type.enum;
  if (prop.type.kind === "enum" && prop.type.members.every((member) => typeof member === "string")) {
    return prop.type.members as readonly string[];
  }
  return undefined;
}

function directPropTemplateSupported(
  node: TemplateNode,
  props: ReadonlySet<string>,
  nativeProperties: boolean,
  svgParent = false,
): boolean {
  if (node.kind === "text") return true;
  if (node.kind === "slot") {
    return node.nameExpression === undefined &&
      (node.fallback ?? []).every((child) => directPropTemplateSupported(child, props, nativeProperties, svgParent));
  }
  if (node.flow !== undefined || node.ref !== undefined || (node.events?.length ?? 0) > 0) return false;
  const svg = node.name === "svg" || (svgParent && node.name !== "foreignObject");
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") continue;
    const name = attribute.expressionPlan?.ast.kind === "id"
      ? attribute.expressionPlan.ast.name
      : undefined;
    if (name === undefined || !props.has(name)) return false;
    if (attribute.kind === "directive") {
      if (attribute.name !== "value") return false;
    } else if (nativeProperties && directNativeProperty(attribute, node.name, svg)) {
      continue;
    } else if (attribute.kind !== "attribute" || attribute.twoWay === true || attribute.target !== undefined ||
      !/^(?:aria-|data-)/.test(attribute.name)) return false;
  }
  return node.children.every((child) => directPropTemplateSupported(child, props, nativeProperties, svg));
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
  // Property bindings use the compact manager only for the measured one-prop boundary.
  return directPropTemplateSupported(definition.template, new Set(props.keys()), entries.length === 1)
    ? { props }
    : undefined;
}

function collectDirectEvents(node: ElementNode, variable: string, context: DirectRenderContext): void {
  for (const event of node.events ?? []) {
    context.events.push({ element: variable, name: event.name, handler: event.handler, modifiers: event.modifiers });
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
  if (direct !== undefined && node.ref !== undefined) direct.refs.set(node.ref, variable);
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
  // Only the root carries a component marker, so the factory records what it projects.
  lines.push(`    for (const child of ${assigned}) {`);
  lines.push(`      const node = typeof child === "string" ? document.createTextNode(child) : child;`);
  lines.push(`      if (node.nodeType === 1) node.setAttribute("data-slotted", "");`);
  lines.push(`      projected.push([node, ${js(node.name ?? "")}]);`);
  lines.push(`      ${parent}.append(node);`);
  lines.push("    }");
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
  root = false,
): void {
  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      const name = js(attribute.name);
      const value = js(attribute.value);
      // On the root the invocation's attributes win over the template's; class and style combine.
      lines.push(!root
        ? `${indent}${variable}.setAttribute(${name}, ${value});`
        : attribute.name === "class" || attribute.name === "style"
          ? `${indent}${variable}.setAttribute(${name}, [${value}, ${variable}.getAttribute(${name})].filter(Boolean).join(${js(attribute.name === "class" ? " " : "; ")}));`
          : `${indent}if (!${variable}.hasAttribute(${name})) ${variable}.setAttribute(${name}, ${value});`);
      continue;
    }
    if (attribute.kind === "directive") {
      const binding = direct === undefined ? undefined : directExpressionBinding(attribute, direct);
      if (direct !== undefined && binding !== undefined && attribute.name === "value") {
        direct.bindings.push({ element: variable, ...binding, kind: "text" });
      } else if (direct !== undefined && attribute.name === "value" && attribute.expressionPlan !== undefined) {
        const expression = directStaticExpression(attribute, direct);
        if (expression !== undefined) {
          lines.push(`${indent}${variable}.textContent = String(${expression.source});`);
        }
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
    if (direct !== undefined && attribute.kind === "attribute" && attribute.twoWay === true &&
      attribute.expressionPlan?.ast.kind === "id") {
      direct.bindings.push({
        element: variable,
        state: attribute.expressionPlan.ast.name,
        kind: attribute.name === "checked"
          ? "bound-checked"
          : node.name === "input" && directInputType(node) === "range"
            ? "bound-number"
            : "bound-value",
        event: attribute.name === "checked" || node.name === "select" ? "change" : "input",
      });
      continue;
    }
    const staticExpression = direct === undefined ? undefined : directStaticExpression(attribute, direct);
    if (direct !== undefined && staticExpression !== undefined && directNativeAttribute(attribute)) {
      if (staticExpression.kind !== "boolean") {
        lines.push(`${indent}${variable}.setAttribute(${js(attribute.name)}, String(${staticExpression.source}));`);
      } else if (isEnumeratedBoolean(attribute.name)) {
        lines.push(`${indent}${variable}.setAttribute(${js(attribute.name)}, String(${staticExpression.source}));`);
      } else {
        lines.push(`${indent}${staticExpression.source} ? ${variable}.setAttribute(${js(attribute.name)}, "") : ${variable}.removeAttribute(${js(attribute.name)});`);
      }
      continue;
    }
    if (direct !== undefined && staticExpression !== undefined && directClassAttribute(attribute)) {
      lines.push(`${indent}${variable}.classList.toggle(${js(attribute.name!)}, Boolean(${staticExpression.source}));`);
      continue;
    }
    if (direct !== undefined && staticExpression !== undefined && directStyleAttribute(attribute)) {
      lines.push(`${indent}${variable}.style.setProperty(${js(attribute.name!)}, String(${staticExpression.source}));`);
      continue;
    }
    if (direct !== undefined && staticExpression !== undefined && attribute.kind === "property") {
      lines.push(`${indent}${variable}[${js(attribute.name)}] = ${staticExpression.source};`);
      continue;
    }
    if (direct !== undefined && directNativeAttribute(attribute) &&
      directExpressionBinding(attribute, direct) !== undefined) {
      direct.bindings.push({
        element: variable,
        ...directExpressionBinding(attribute, direct)!,
        kind: "attribute",
        name: attribute.name,
      });
      continue;
    }
    if (direct !== undefined && directClassAttribute(attribute) &&
      directExpressionBinding(attribute, direct) !== undefined) {
      direct.bindings.push({
        element: variable,
        ...directExpressionBinding(attribute, direct)!,
        kind: "class",
        name: attribute.name,
      });
      continue;
    }
    if (direct !== undefined && directStyleAttribute(attribute) &&
      directExpressionBinding(attribute, direct) !== undefined) {
      direct.bindings.push({
        element: variable,
        ...directExpressionBinding(attribute, direct)!,
        kind: "style",
        name: attribute.name,
      });
      continue;
    }
    if (direct !== undefined && attribute.kind === "property" &&
      directExpressionBinding(attribute, direct) !== undefined) {
      // directTemplateSupported() already proved this is a native HTML property in the direct subset.
      direct.bindings.push({
        element: variable,
        ...directExpressionBinding(attribute, direct)!,
        kind: "property",
        name: attribute.name,
      });
      continue;
    }
    const prop = props[attribute.expression];
    if (prop === undefined) continue;
    const directProp = directProps?.plan.props.get(attribute.expression);
    const expression = directProp?.variable ?? `componentProps[${js(attribute.expression)}] === undefined ? ${"default" in prop ? JSON.stringify(prop.default) : "null"} : componentProps[${js(attribute.expression)}]`;
    if (directProp !== undefined && attribute.kind === "property") {
      directProps!.bindings.push({
        element: variable,
        prop: attribute.expression,
        kind: "property",
        name: attribute.name,
      });
    } else if (directProp !== undefined && attribute.kind === "attribute" &&
      (variable !== "element" || attribute.name !== `data-${kebabCase(attribute.expression)}`)) {
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
    } else if (prop.type === "boolean" && isEnumeratedBoolean(attribute.name)) {
      lines.push(`${indent}if (typeof ${local} === "boolean") ${variable}.setAttribute(${js(attribute.name)}, String(${local}));`);
      lines.push(`${indent}else ${variable}.removeAttribute(${js(attribute.name)});`);
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
  // A root `$match` renders the arm the props choose; the runtime makes that choice, as it does in HTML.
  const arms = rootArms(template);
  const direct = directReactivePlan(definition);
  const directHasLifecycle = direct !== undefined && hasDirectLifecycleEvent(template);
  const directHasDisconnect = direct !== undefined && hasDirectDisconnectEvent(template);
  const directDispatches = directHasDispatch(direct);
  const directBindings = direct === undefined ? [] : directBindingValues(template, direct);
  const directStaticBindings = direct === undefined ? [] : directStaticBindingValues(template, direct);
  const directHasExpressionBinding = direct !== undefined && hasDirectExpressionBinding(template, direct);
  const directBound = new Set([
    ...directBindings,
    ...directStaticBindings,
    ...(direct === undefined ? [] : directHandlerDependencies(direct, [...directBindings, ...directStaticBindings])),
  ]);
  const directLive = direct === undefined
    ? new Set<string>()
    : directLiveComputed(direct, directBound);
  const directStates = direct === undefined
    ? new Set<string>()
    : directLiveStates(direct, directBound, directLive);
  const directStateEntries = direct === undefined
    ? []
    : [...direct.states.entries()].filter(([name]) => directStates.has(name) && !directValueIsStatic(name, direct));
  const directStaticComputed = direct === undefined
    ? new Set<string>()
    : new Set([...direct.computed.keys()].filter((name) => directLive.has(name) && directValueIsStatic(name, direct)));
  const directComputed = direct === undefined
    ? []
    : [...direct.computed.entries()].filter(([name]) => directLive.has(name) && !directStaticComputed.has(name));
  const directSelectiveUpdates = direct !== undefined && usesSelectiveDirectUpdates(
    direct,
    directLive,
    directStates,
  );
  const directRendered = direct !== undefined && !directSelectiveUpdates && !directHasExpressionBinding
    ? directBindings.map((name, index) =>
        direct.computed.get(name)?.stabilizes === true ? `rendered${index}` : undefined
      )
    : [];
  const directOutputEquality = directRendered.some((variable) => variable !== undefined);
  const directInitialOutputEquality = directOutputEquality &&
    directRendered.every((variable) => variable !== undefined);
  const directProps = direct === undefined ? directPropPlan(definition) : undefined;
  const directPropSingle = directProps !== undefined && directProps.props.size === 1;
  const needsRuntime = direct === undefined && directProps === undefined && (
    arms !== undefined || props.length > 0 || (definition.declarations?.length ?? 0) > 0 || definition.controller !== undefined
  );
  const generatedRuntimeImports = [
    ...(directProps === undefined ? [] : [directPropSingle ? "manageGeneratedProp" : "manageGeneratedProps"]),
    ...(directHasLifecycle ? ["manageGeneratedLifecycle"] : []),
    ...(directDispatches ? ["dispatchGeneratedEvent"] : []),
  ];
  const lines = [
    `// Generated by HTML Next ${version} for Vanilla DOM. Do not edit.`,
    ...(generatedRuntimeImports.length === 0
      ? []
      : [`import { ${generatedRuntimeImports.join(", ")} } from "@nextwebwg/html-next/generated-runtime";`]),
    ...(needsRuntime
      ? [`import { ${arms === undefined ? "" : "componentRootIndex, "}manageComponentLifecycle } from "@nextwebwg/html-next/runtime";`]
      : []),
    ...(definition.controller === undefined ? [] : [`import * as controller from ${js(definition.controller)};`]),
    `import "../styles/${contract.tag}.css";`,
    "",
    ...(needsRuntime ? [`const definition = ${serializedDefinition(definition)};`, ""] : []),
    `export function create${contract.name}(options${hasRequired ? "" : " = {}"}) {`,
    `  const { attributes = {}, children = [], slots = {}${needsRuntime || directProps !== undefined ? ", ...componentProps" : ""} } = options;`,
    "  const projected = [];",
    ...(direct === undefined
      ? []
      : [
          ...directStateEntries.map(([, { variable, initial }]) => `  let ${variable} = ${directPrimitiveSource(initial)};`),
          ...directComputed.map(([name, { variable, initial }]) =>
            `  let ${variable}${directSelectiveUpdates || directInitialOutputEquality || directStaticComputed.has(name) ? ` = ${directPrimitiveSource(initial)}` : ""};`
          ),
          ...directRendered.flatMap((variable, index) => variable === undefined
            ? []
            : [`  let ${variable}${directInitialOutputEquality ? ` = ${direct!.values.get(directBindings[index]!)!.variable}` : ""};`]
          ),
        ]),
    ...(directProps === undefined
      ? []
      : [...directProps.props.entries()].map(([name, prop]) =>
        `  const ${prop.variable} = componentProps[${js(name)}] === undefined ? ${"default" in prop.contract ? JSON.stringify(prop.contract.default) : "undefined"} : componentProps[${js(name)}];`
      )),
  ];
  const valueCounter = { value: 0 };
  const directRender: DirectRenderContext | undefined = direct === undefined
    ? undefined
    : { plan: direct, bindings: [], events: [], refs: new Map() };
  const directPropRender: DirectPropRenderContext | undefined = directProps === undefined
    ? undefined
    : { plan: directProps, bindings: [] };
  const counter: RenderCounter = { value: 0, svgParents: new Set() };
  const renderRoot = (root: ElementNode): void => {
    lines.push(
      `  ${arms === undefined ? "const " : ""}element = document.createElement(${js(root.name)});`,
      "  for (const [name, value] of Object.entries(attributes)) {",
      "    if (value === null || value === undefined || value === false) continue;",
      "    element.setAttribute(name, value === true ? \"\" : String(value));",
      "  }",
    );
    renderAttributes(root, "element", lines, contract.props, valueCounter, "  ", directRender, directPropRender, true);
    if (directRender !== undefined) collectDirectEvents(root, "element", directRender);
    if (directRender !== undefined && root.ref !== undefined) directRender.refs.set(root.ref, "element");
    lines.push(`  element.setAttribute("data-component", ${js(contract.tag)});`);
    for (const child of root.children) {
      renderNode(child, lines, counter, "element", contract.props, valueCounter, contract.tag, "slots", directRender, directPropRender);
    }
  };
  if (arms === undefined) {
    renderRoot(template);
  } else {
    lines.push("  const root = componentRootIndex(definition, componentProps);", "  let element;");
    for (const [index, arm] of arms.entries()) {
      lines.push(index === 0 ? "  if (root === 0) {" : index === arms.length - 1 ? "  } else {" : `  } else if (root === ${index}) {`);
      const start = lines.length;
      renderRoot(arm);
      for (let line = start; line < lines.length; line += 1) lines[line] = `  ${lines[line]}`;
    }
    lines.push("  }");
  }
  if (directRender !== undefined) {
    const directPlan = directRender.plan;
    const selective = directSelectiveUpdates;
    const writeDirectBinding = (binding: DirectBinding, value: DirectValue): string => {
      const source = binding.expression?.source ?? value.variable;
      const kind = binding.expression?.kind ?? value.kind;
      if (binding.kind === "text") return `${binding.element}.textContent = String(${source});`;
      if (binding.kind === "bound-value") {
        return `if (${binding.element}.value !== ${source}) ${binding.element}.value = ${source};`;
      }
      if (binding.kind === "bound-checked") {
        return `if (${binding.element}.checked !== ${source}) ${binding.element}.checked = ${source};`;
      }
      if (binding.kind === "bound-number") {
        return `if (${binding.element}.value !== String(${source})) ${binding.element}.value = String(${source});`;
      }
      if (binding.kind === "property") return `${binding.element}[${js(binding.name!)}] = ${source};`;
      if (binding.kind === "class") return `${binding.element}.classList.toggle(${js(binding.name!)}, Boolean(${source}));`;
      if (binding.kind === "style") return `${binding.element}.style.setProperty(${js(binding.name!)}, String(${source}));`;
      if (kind !== "boolean") return `${binding.element}.setAttribute(${js(binding.name!)}, String(${source}));`;
      if (isEnumeratedBoolean(binding.name!)) {
        return `${binding.element}.setAttribute(${js(binding.name!)}, String(${source}));`;
      }
      return `${source} ? ${binding.element}.setAttribute(${js(binding.name!)}, "") : ${binding.element}.removeAttribute(${js(binding.name!)});`;
    };
    const directEvents = directRender.events.filter((event) =>
      directLifecycleEventPasses(event) &&
      directPlan.handlers.get(event.handler)!.declaration.steps.some((step) =>
        step.kind === "dispatch" || step.kind === "focus" || step.kind === "validate" ||
        step.kind === "set" && directStates.has(String(step.writablePath[0]))
      )
    );
    const directHandlerNames = new Set(directEvents.filter((event) => event.name !== "disconnect").map((event) => event.handler));
    const directDisconnectHandlerNames = new Set(directEvents.filter((event) => event.name === "disconnect").map((event) => event.handler));
    const directHasBindings = directRender.bindings.length > 0;
    const directNeedsScheduler = directHasBindings || directHasDisconnect;
    if (directNeedsScheduler) {
      lines.push("  let pending = false;");
      if (directHasDisconnect) lines.push("  let connected = false;", "  let stale = false;", "  let initialized = false;");
      if (selective) lines.push("  let dirty = 0;");
      lines.push("  const update = () => {");
      lines.push("    pending = false;");
      if (directHasDisconnect) {
        lines.push("    if (initialized && (!connected || !element.isConnected)) { stale = true; return; }");
        lines.push("    stale = false;");
        lines.push("    initialized = true;");
      }
      if (selective) {
        lines.push("    let changed = dirty;");
        lines.push("    dirty = 0;");
        for (const [name, { variable, expression, dependencies, bit }] of directComputed) {
          if (directStaticComputed.has(name)) continue;
          const mask = directDependencyMask(directPlan, dependencies);
          lines.push(`    if (changed & ${mask}) {`);
          lines.push(`      const next = ${expression};`);
          lines.push(`      if (!Object.is(${variable}, next)) { ${variable} = next; changed |= ${bit}; }`);
          lines.push("    }");
        }
        for (const binding of directRender.bindings) {
          const value = directPlan.values.get(binding.state)!;
          const mask = binding.dependencies === undefined
            ? value.bit
            : directDependencyMask(directPlan, binding.dependencies);
          lines.push(`    if (changed & ${mask}) ${writeDirectBinding(binding, value)}`);
        }
      } else {
        for (const [name, { variable, expression }] of directComputed) {
          if (directStaticComputed.has(name)) continue;
          lines.push(`    ${variable} = ${expression};`);
        }
        for (const [index, binding] of directRender.bindings.entries()) {
          const value = directPlan.values.get(binding.state)!;
          const rendered = directRendered[index];
          if (rendered !== undefined) {
            lines.push(`    if (!Object.is(${rendered}, ${value.variable})) { ${rendered} = ${value.variable}; ${writeDirectBinding(binding, value)} }`);
          } else {
            lines.push(`    ${writeDirectBinding(binding, value)}`);
          }
        }
      }
      lines.push("  };");
      lines.push("  const schedule = () => {");
      if (directHasDisconnect) {
        lines.push("    stale = true;");
        lines.push("    if (connected && !pending) { pending = true; queueMicrotask(update); }");
      } else {
        lines.push("    if (!pending) { pending = true; queueMicrotask(update); }");
      }
      lines.push("  };");
    }
    const emitDirectHandler = (
      variable: string,
      declaration: HandlerDeclaration,
      connectedGuard: boolean,
    ): void => {
      lines.push(`  const ${variable} = () => {`);
      if (connectedGuard) {
        lines.push(directHasDisconnect
          ? "    if (!element.isConnected || !connected) return;"
          : "    if (!element.isConnected) return;");
      }
      for (const [stepIndex, step] of declaration.steps.entries()) {
        const guard = step.guard === undefined
          ? undefined
          : directPrimitiveExpression(step.guard.ast, directPlan.values)!;
        const guardComputedClosure = new Set(directGuardComputedClosure(step, directPlan.computed));
        for (const [name, { variable, expression }] of directComputed) {
          if (guardComputedClosure.has(name) && !directStaticComputed.has(name)) lines.push(`    ${variable} = ${expression};`);
        }
        if (guard !== undefined) lines.push(`    if (${guard.source}) {`);
        const indent = guard === undefined ? "    " : "      ";
        if (step.kind === "focus" || step.kind === "validate") {
          const target = directRender.refs.get(step.target)!;
          lines.push(`${indent}${target}.${step.kind === "focus" ? "focus()" : "reportValidity?.()"};`);
          if (guard !== undefined) lines.push("    }");
          continue;
        }
        if (step.kind === "dispatch") {
          const computedClosure = new Set(directDispatchComputedClosure(step, directPlan.computed));
          for (const [name, { variable, expression }] of directComputed) {
            if (computedClosure.has(name) && !guardComputedClosure.has(name) && !directStaticComputed.has(name)) lines.push(`${indent}${variable} = ${expression};`);
          }
          lines.push(`${indent}dispatchGeneratedEvent(element, ${directDispatch(step, directPlan.events, directPlan.values)!});`);
          if (guard !== undefined) lines.push("    }");
          continue;
        }
        if (step.kind !== "set") {
          if (guard !== undefined) lines.push("    }");
          continue;
        }
        const state = String(step.writablePath[0]);
        if (!directStates.has(state)) {
          if (guard !== undefined) lines.push("    }");
          continue;
        }
        const computedClosure = new Set(directComputedClosure(directDependencies(step.value.ast), directPlan.computed));
        for (const [name, { variable, expression }] of directComputed) {
          if (computedClosure.has(name) && !guardComputedClosure.has(name) && !directStaticComputed.has(name)) {
            lines.push(`${indent}${variable} = ${expression};`);
          }
        }
        const stateVariable = directPlan.states.get(state)!.variable;
        const next = directSetExpression(
          step.value.ast,
          directPlan.states.get(state)!,
          directPlan.values,
        )!;
        const nextVariable = `next${stepIndex}`;
        lines.push(`${indent}const ${nextVariable} = ${next};`);
        lines.push(
          `${indent}if (!Object.is(${stateVariable}, ${nextVariable})) { ${stateVariable} = ${nextVariable};` +
          `${selective ? ` dirty |= ${directPlan.states.get(state)!.bit};` : ""}${directHasBindings ? " schedule();" : ""} }`,
        );
        if (guard !== undefined) lines.push("    }");
      }
      lines.push("  };");
    };
    for (const [handlerName, { variable, declaration }] of directPlan.handlers) {
      if (directHandlerNames.has(handlerName)) emitDirectHandler(variable, declaration, true);
      if (directDisconnectHandlerNames.has(handlerName)) emitDirectHandler(`${variable}Disconnect`, declaration, false);
    }
    const onceEventListeners: Array<{ readonly attach: string; readonly detach: string }> = [];
    const connectHandlers: string[] = [];
    const disconnectHandlers: string[] = [];
    for (const [index, event] of directEvents.entries()) {
      const handler = directPlan.handlers.get(event.handler)!.variable;
      if (event.name === "connect") {
        connectHandlers.push(`${handler}();`);
        continue;
      }
      if (event.name === "disconnect") {
        disconnectHandlers.push(`${handler}Disconnect();`);
        continue;
      }
      if (event.modifiers.length === 0) {
        lines.push(`  ${event.element}.addEventListener(${js(event.name)}, ${handler});`);
        continue;
      }
      const listenerOptions = directEventListenerOptions(event);
      lines.push(`  const event${index} = (event) => {`);
      lines.push("    if (!element.isConnected) return;");
      for (const filter of directEventFilterLines(event)) lines.push(`    ${filter}`);
      if (event.modifiers.includes("prevent")) lines.push("    event.preventDefault();");
      if (event.modifiers.includes("stop")) lines.push("    event.stopPropagation();");
      lines.push(`    ${handler}();`);
      lines.push("  };");
      const attach = `${event.element}.addEventListener(${js(event.name)}, event${index}${listenerOptions === undefined ? "" : `, ${listenerOptions}`});`;
      if (event.modifiers.includes("once")) {
        onceEventListeners.push({
          attach,
          detach: `${event.element}.removeEventListener(${js(event.name)}, event${index}${event.modifiers.includes("capture") ? ", true" : ""});`,
        });
      } else lines.push(`  ${attach}`);
    }
    if (onceEventListeners.length > 0 || connectHandlers.length > 0 || disconnectHandlers.length > 0) {
      lines.push("  manageGeneratedLifecycle(element, () => {");
      if (directHasDisconnect) {
        lines.push("    connected = true;");
        lines.push("    if (stale) update();");
      }
      for (const { attach } of onceEventListeners) lines.push(`    ${attach}`);
      for (const handler of connectHandlers) lines.push(`    ${handler}`);
      lines.push("  }, () => {");
      if (directHasDisconnect) lines.push("    connected = false;");
      for (const { detach } of onceEventListeners) lines.push(`    ${detach}`);
      for (const handler of disconnectHandlers) lines.push(`    ${handler}`);
      lines.push("  });");
    }
    for (const [index, binding] of directRender.bindings.entries()) {
      if (binding.kind !== "bound-value" && binding.kind !== "bound-checked" && binding.kind !== "bound-number") continue;
      const state = directPlan.states.get(binding.state)!;
      const next = binding.kind === "bound-value"
        ? `${binding.element}.value`
        : binding.kind === "bound-checked"
          ? `${binding.element}.checked`
          : `${binding.element}.valueAsNumber`;
      const event = binding.event!;
      lines.push(`  const binding${index} = () => {`);
      lines.push("    if (!element.isConnected) return;");
      lines.push(`    const next = ${next};`);
      lines.push(
        `    if (!Object.is(${state.variable}, next)) { ${state.variable} = next;` +
        `${selective ? ` dirty |= ${state.bit};` : ""} schedule(); }`,
      );
      lines.push("  };");
      lines.push(`  ${binding.element}.addEventListener(${js(event)}, binding${index});`);
    }
    if (!directHasBindings) {
      // Construction-only bindings already wrote their values while rendering.
    } else if (selective || directInitialOutputEquality) {
      for (const binding of directRender.bindings) {
        lines.push(`  ${writeDirectBinding(binding, directPlan.values.get(binding.state)! )}`);
      }
    } else {
      lines.push("  update();");
    }
  }
  if (directPropRender !== undefined) {
    const renderBindings = (bindings: readonly DirectPropBinding[]): void => {
      for (const binding of bindings) {
        if (binding.kind === "text") {
          lines.push(`      ${binding.element}.textContent = value == null ? "" : String(value);`);
        } else if (binding.kind === "property") {
          lines.push(`      ${binding.element}[${js(binding.name!)}] = value;`);
        } else {
          const enumerated = isEnumeratedBoolean(binding.name!);
          lines.push(`      if (value === null || value === undefined${enumerated ? "" : " || value === false"}) ${binding.element}.removeAttribute(${js(binding.name!)});`);
          lines.push(`      else ${binding.element}.setAttribute(${js(binding.name!)}, ${enumerated ? "String(value)" : "value === true ? \"\" : String(value)"});`);
        }
      }
    };
    const descriptor = (name: string, prop: DirectProp): string => {
      const type = directPropType(prop.contract)!;
      // The raw option (undefined when omitted) so only explicit values are reflected.
      return `{ name: ${js(name)}, attribute: ${js(`data-${kebabCase(name)}`)}, value: componentProps[${js(name)}]${"default" in prop.contract ? `, default: ${JSON.stringify(prop.contract.default)}` : ""}${template.attributes.some((binding) => binding.kind === "attribute" && binding.name === `data-${kebabCase(name)}`) ? ", bound: true" : ""}, type: ${typeof type === "string" ? js(type) : JSON.stringify(type)}, required: ${String(prop.contract.required)} }`;
    };
    if (directPropSingle) {
      const entry = directPropRender.plan.props.entries().next().value as [string, DirectProp];
      const [name, prop] = entry;
      const bindings = directPropRender.bindings.filter((binding) => binding.prop === name);
      if (bindings.length === 0) {
        lines.push(`  manageGeneratedProp(element, ${descriptor(name, prop)});`);
      } else {
        lines.push(`  manageGeneratedProp(element, ${descriptor(name, prop)}, (value) => {`);
        renderBindings(bindings);
        lines.push("  });");
      }
    } else {
      lines.push("  manageGeneratedProps(element, [");
      for (const [name] of directPropRender.plan.props) {
        lines.push(`    ${descriptor(name, directPropRender.plan.props.get(name)!)},`);
      }
      if (directPropRender.bindings.length === 0) {
        lines.push("  ]);");
      } else {
        lines.push("  ], (name, value) => {");
        for (const [name] of directPropRender.plan.props) {
          const bindings = directPropRender.bindings.filter((binding) => binding.prop === name);
          if (bindings.length === 0) continue;
          lines.push(`    if (name === ${js(name)}) {`);
          renderBindings(bindings);
          lines.push("    }");
        }
        lines.push("  });");
      }
    }
  }
  if (needsRuntime) {
    lines.push(
      "  manageComponentLifecycle(element, definition, { props: componentProps, projected,",
      ...(definition.controller === undefined ? [] : ["    controller,"]),
      "  });",
    );
  }
  lines.push("  return element;", "}", "");

  const domType = arms === undefined ? getDomInterface(contract.nativeElement) ?? "HTMLElement" : "HTMLElement";
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
    "}",
    `export declare function create${contract.name}(props${hasRequired ? "" : "?"}: ${contract.name}Props): ${elementType};`,
    "",
  ].join("\n");

  return { module: `${lines.join("\n")}\n`, declaration };
}
