import type { ExpressionNode, WritablePath, WritablePathSegment } from "../expression.js";
import { initialAt } from "../state-initial.js";
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

/**
 * Conforming states a framework target may also read unchecked. Its handler writes check only a
 * value's own kind (an object is an object, nested fields keep their authored input), so only a
 * string, number, integer or boolean state is checked in full on every write.
 */
export function conformingScalarStates(definition: ComponentDefinition): ReadonlySet<string> {
  const scalars = new Set<string>();
  for (const name of conformingStates(definition)) {
    const declaration = definition.declarations?.find((entry) => entry.kind === "state" && entry.name === name);
    const node = declaration?.kind === "state" ? declarationTypeNode(declaration.type, declaration.shape) : undefined;
    if (node?.kind === "terminal" && ["string", "number", "integer", "boolean"].includes(node.name)) scalars.add(name);
  }
  return scalars;
}

/**
 * The states of `definition` a build publishes to `<context>` readers: those a component in `graph`
 * reads. Every state can be read, so a build whose readers may lie outside it publishes them all.
 */
export function publishedStates(definition: ComponentDefinition, graph: Iterable<ComponentDefinition>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const reader of graph) {
    for (const declaration of reader.declarations ?? []) {
      if (declaration.kind === "context" && declaration.from === definition.contract.tag) names.add(declaration.name);
    }
  }
  return names;
}

/** A state's declared `value` as a literal, which a null write and `host.reset` restore; null without one. */
export function declaredStateLiteral(definition: ComponentDefinition, name: string): unknown {
  const declaration = definition.declarations?.find((item) => item.kind === "state" && item.name === name);
  return declaration?.kind !== "state" || declaration.expression === undefined ? null : literalInitial(declaration.expression.ast)?.value ?? null;
}

/** A framework host's \`initials\` option: each state's declared value, when any state has one. */
export function controllerInitials(definition: ComponentDefinition, indent: string): string[] {
  const entries = (definition.declarations ?? []).flatMap((item) => {
    if (item.kind !== "state") return [];
    const value = declaredStateLiteral(definition, item.name);
    return value === null ? [] : [`${JSON.stringify(item.name)}: ${JSON.stringify(value).replaceAll('"__proto__":', '["__proto__"]:')}`];
  });
  return entries.length === 0 ? [] : [`${indent}initials: { ${entries.join(", ")} },`];
}

/**
 * Source for what a write of null or undefined at `path` stores instead: the state's declared value
 * there (types#null-and-missing-values), or undefined when that is null and the write stores null.
 * A dynamic key reads the declared value at run time.
 */
export function revertSource(definition: ComponentDefinition, path: WritablePath,
  key: (segment: Extract<WritablePathSegment, object>) => string): string | undefined {
  const initial = declaredStateLiteral(definition, String(path[0]));
  if (initial === null) return undefined;
  const keys = path.slice(1);
  if (keys.every((segment) => typeof segment !== "object")) {
    const value = initialAt(initial, keys as readonly (string | number)[]);
    return value === null ? undefined : JSON.stringify(value).replaceAll('"__proto__":', '["__proto__"]:');
  }
  // Below a static prefix with nothing in it, every dynamic key finds null.
  const dynamic = keys.findIndex((segment) => typeof segment === "object");
  const prefix = initialAt(initial, keys.slice(0, dynamic) as readonly (string | number)[]);
  if (prefix === null || typeof prefix !== "object" || Object.keys(prefix).length === 0) return undefined;
  return `((${JSON.stringify(initial)} as any)${keys.map((segment) => `?.[${typeof segment === "object" ? key(segment) : JSON.stringify(segment)}]`).join("")} ?? null)`;
}

/**
 * Source for a two-way binding's revert at run time: the state's declared value, at the keys `path`
 * names (an expression for the key list), or undefined when the state has no declared value.
 */
export function bindingRevertSource(definition: ComponentDefinition, state: string, path?: string): string | undefined {
  const initial = declaredStateLiteral(definition, state);
  if (initial === null) return undefined;
  const json = JSON.stringify(initial).replaceAll('"__proto__":', '["__proto__"]:');
  return path === undefined ? json : `(${path}.reduce((value: any, key: any) => value?.[key], ${json} as any) ?? null)`;
}

/**
 * A written value with its revert: `value ?? revert`, or the revert alone for a null literal. An
 * operator's or a literal's result is never null, so it keeps no revert (TypeScript also rejects a
 * `??` whose left side can never be nullish).
 */
export function withRevert(value: string, ast: ExpressionNode, revert: string | undefined): string {
  if (revert === undefined) return value;
  if (ast.kind === "literal") return ast.value === null ? revert : value;
  if (ast.kind === "object" || ast.kind === "array" || ast.kind === "unary" || ast.kind === "binary") return value;
  return `(${value} ?? ${revert})`;
}
