import type { ExpressionNode } from "../expression.js";
import type { ComponentDefinition, TemplateNode } from "../template.js";
import { declarationTypeNode, parseTypedValue } from "../type-system.js";

/** A state's initial value that is not a plain literal, which the factory then evaluates instead. */
export class NotLiteral extends Error {}

/** The value of a literal initial-state expression; anything else is evaluated by the factory. */
export function literalValue(node: ExpressionNode): unknown {
  if (node.kind === "literal") {
    const value = node.value;
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    throw new NotLiteral();
  }
  if (node.kind === "array") return node.items.map(literalValue);
  if (node.kind === "object") {
    const value: Record<string, unknown> = {};
    for (const pair of node.pairs) {
      // ponytail: the interpreter assigns `__proto__` through its setter; the factory evaluates it so.
      if (pair.key === "__proto__") throw new NotLiteral();
      value[pair.key] = literalValue(pair.value);
    }
    return value;
  }
  throw new NotLiteral();
}

/** The value of a literal initializer, or undefined for one that needs evaluating. */
export function literalInitial(node: ExpressionNode): { readonly value: unknown } | undefined {
  try { return { value: literalValue(node) }; }
  catch (error) {
    if (error instanceof NotLiteral) return undefined;
    throw error;
  }
}

/** Roots a two-way binding writes: a control's value is stored unchecked, as live stores it. */
export function twoWayRoots(definition: ComponentDefinition): Set<string> {
  const names = new Set<string>();
  const visit = (node: TemplateNode): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") {
      node.fallback?.forEach(visit);
      return;
    }
    for (const attribute of node.attributes) {
      if (attribute.kind === "attribute" && attribute.twoWay === true && typeof attribute.writablePath?.[0] === "string") {
        names.add(attribute.writablePath[0]);
      }
    }
    node.children.forEach(visit);
  };
  visit(definition.template);
  return names;
}

const conforming = new WeakMap<ComponentDefinition, ReadonlySet<string>>();

/**
 * Typed states whose own value always satisfies the declared type: the initial value is a
 * conforming literal, and every later write is checked (handlers and controllers) or refused.
 * Reading such a root needs no reference check, in any target; a path below it still does.
 */
export function conformingStates(definition: ComponentDefinition): ReadonlySet<string> {
  let names = conforming.get(definition);
  if (names !== undefined) return names;
  const controlled = twoWayRoots(definition);
  const result = new Set<string>();
  for (const declaration of definition.declarations ?? []) {
    if (declaration.kind !== "state" || controlled.has(declaration.name)) continue;
    const node = declarationTypeNode(declaration.type, declaration.shape);
    if (node === undefined) continue;
    const literal = declaration.expression === undefined ? { value: null } : literalInitial(declaration.expression.ast);
    if (literal !== undefined && (literal.value === null || parseTypedValue(literal.value, node, "$", "value").ok)) result.add(declaration.name);
  }
  conforming.set(definition, names = result);
  return names;
}
