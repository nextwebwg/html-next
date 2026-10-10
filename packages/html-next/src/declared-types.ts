/**
 * Declared types of the paths a component's expressions read. The live runtime's scopes and the
 * compiler answer the same questions from them: which type a reference must satisfy, and which
 * paths carry a dimension (`length`, `percentage`, `duration`) into arithmetic and math calls.
 */

import { selectedPropType } from "./contract.js";
import { compileExpression, dimensionType, type CompiledExpression, type Scope } from "./expression.js";
import type { ComponentDefinition } from "./template.js";
import { declarationTypeNode, normalizeType, parseTypeExpression, typeAtKey, type TypeNode } from "./type-system.js";

/** The state surface a declared read publishes, so a path through it resolves to a declared type. */
const DATA_STATE_FIELDS: Readonly<Record<string, TypeNode | undefined>> = {
  pending: { kind: "terminal", name: "boolean" },
  ok: { kind: "terminal", name: "boolean" },
  error: { kind: "terminal", name: "unknown" },
};

const declaredPathTypes = new WeakMap<ComponentDefinition, Map<string, TypeNode | undefined>>();

/**
 * The type a reference must satisfy, or undefined when nothing declares one.
 *
 * Only a declaration carrying a type constrains a reference: a prop, a typed `<state>`/`<computed>`,
 * or a `<data>` read (whose declared type describes `.value`). A loop alias or an untyped
 * declaration says nothing, so references through it are unconstrained.
 */
export function declaredTypeAt(definition: ComponentDefinition, path: string | readonly (string | number)[], scope?: Scope): TypeNode | undefined {
  let cache = declaredPathTypes.get(definition);
  if (cache === undefined) {
    cache = new Map();
    declaredPathTypes.set(definition, cache);
  }
  const segments = typeof path === "string" ? path.split(".") : path.map(String);
  const cacheKey = JSON.stringify(segments);
  const selected = definition.contract.props[segments[0]!]?.select !== undefined && scope !== undefined;
  if (!selected && cache.has(cacheKey)) return cache.get(cacheKey);

  const [root, ...steps] = segments;
  let type = rootDeclaredType(definition, root!, steps, scope);
  for (const step of type === undefined ? [] : steps) {
    if (type === undefined) break;
    type = typeAtKey(type, step);
  }
  if (!selected) cache.set(cacheKey, type);
  return type;
}

/** Resolves the declared type of a path's root, consuming the steps a `<data>` surface owns. */
function rootDeclaredType(
  definition: ComponentDefinition,
  root: string,
  steps: string[],
  scope?: Scope,
): TypeNode | undefined {
  const prop = definition.contract.props[root];
  if (prop !== undefined) {
    const type = prop.select === undefined || scope === undefined
      ? prop.type : selectedPropType(definition.contract, prop, { [prop.select.from]: scope.get(prop.select.from) });
    return type === null ? { kind: "terminal", name: "null" } : normalizeType(type);
  }
  for (const declaration of definition.declarations ?? []) {
    if (declaration.name !== root) continue;
    if (declaration.kind === "state" || declaration.kind === "computed") {
      return declarationTypeNode(declaration.type, declaration.shape);
    }
    if (declaration.kind !== "data") return undefined;
    // `<data type>` describes the resolved value, reached through `.value`; the rest of the state
    // surface has its own types.
    const first = steps.shift();
    if (first === undefined) return undefined;
    if (first !== "value") return DATA_STATE_FIELDS[first];
    return declaration.type === undefined ? undefined : parseTypeExpression(declaration.type);
  }
  return undefined;
}


const DIMENSIONS = new Set(["length", "percentage", "duration"]);

function dimensionOf(type: TypeNode | undefined): "length" | "percentage" | "duration" | undefined {
  return type?.kind === "terminal" && DIMENSIONS.has(type.name) ? type.name as "length" | "percentage" | "duration" : undefined;
}

/** Gives a component scope its declared types; a computed carries its expression's dimension. */
export function declareTypes(scope: Scope, definition: ComponentDefinition): void {
  const resolvingDimensions = new Set<string>();
  scope.typeOfDeclaredPath = (path) => declaredTypeAt(definition, path);
  scope.typeOfPath = (path) => {
    const dimension = dimensionOf(scope.typeOfDeclaredPath?.(path));
    if (dimension !== undefined) return dimension;
    if (path.includes(".") || resolvingDimensions.has(path)) return undefined;
    const computed = definition.declarations?.find((item) => item.kind === "computed" && item.name === path);
    if (computed?.kind !== "computed" || computed.expression === undefined) return undefined;
    resolvingDimensions.add(path);
    try { return dimensionType(computed.expression.ast, scope); }
    finally { resolvingDimensions.delete(path); }
  };
}

/** Gives a local layer (a loop item, a `$with` alias) its types over its parent's. */
export function declareLayerTypes(child: Scope, parent: Scope, types: Readonly<Record<string, TypeNode | undefined>>): void {
  child.typeOfDeclaredPath = (path) => {
    const [root, ...keys] = path.split(".");
    if (!Object.hasOwn(types, root!)) return parent.typeOfDeclaredPath?.(path);
    let type = types[root!];
    for (const key of keys) {
      if (type === undefined) break;
      type = typeAtKey(type, key);
    }
    return type;
  };
  child.typeOfPath = (path) => dimensionOf(child.typeOfDeclaredPath?.(path)) ?? parent.typeOfPath?.(path);
}

/** The declared type of an expression that is a path (`items`, `order.lines.0`), or undefined. */
export function declaredExpressionType(expression: string | Pick<CompiledExpression, "ast">, scope: Scope): TypeNode | undefined {
  let node = typeof expression === "string" ? compileExpression(expression).ast : expression.ast;
  const path: string[] = [];
  while (node.kind === "member" || node.kind === "index") {
    if (node.kind === "member") path.unshift(node.key);
    else if (node.index.kind === "literal" && (typeof node.index.value === "string" || typeof node.index.value === "number")) {
      path.unshift(String(node.index.value));
    } else return undefined;
    node = node.object;
  }
  if (node.kind !== "id") return undefined;
  path.unshift(node.name);
  return scope.typeOfDeclaredPath?.(path.join("."));
}
