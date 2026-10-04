import { typeCheckedDependencies, type CompiledExpression, type WritablePathSegment } from "../expression.js";
import { declarationTypeNode, normalizeType, parseTypeExpression, typeAtKey, type TypeNode } from "../type-system.js";
import type { ComponentDefinition } from "../template.js";
import { quote } from "./shared.js";
import type { Lowering, Scope } from "./vue-lowering.js";

/** A JavaScript predicate for a declared type, used by generated event and handler code. */
export function typeCheck(type: TypeNode, value: string): string {
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

export type StrictTypePredicate = (type: TypeNode, value: string) => string;

/** Handler destinations check their immediate type; nested values keep their authored input. */
export function destinationTypeCheck(type: TypeNode, value: string, strict?: StrictTypePredicate): string {
  switch (type.kind) {
    case "list": return `Array.isArray(${value})`;
    case "record":
    case "object": return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value}))`;
    case "union": return `(${type.members.map((member) => destinationTypeCheck(member, value, strict)).join(" || ")})`;
    case "selected": return `(${type.options.map((option) => destinationTypeCheck(option.type, value, strict)).join(" || ")})`;
    case "constrained": return destinationTypeCheck(type.base, value, strict);
    default:
      if (type.kind === "terminal" && !["string", "boolean", "number", "integer", "null", "absent", "function", "unknown"].includes(type.name)) {
        return strict?.(type, value) ?? typeCheck(type, value);
      }
      return typeCheck(type, value);
  }
}

export function handlerDestinationCheck(
  type: TypeNode | undefined,
  path: readonly WritablePathSegment[],
  index: number,
  value: string,
  scope: Scope,
  lowering: Lowering,
  strict?: StrictTypePredicate,
): string | undefined {
  if (type === undefined) return undefined;
  if (index === path.length) return destinationTypeCheck(type, value, strict);
  const segment = path[index]!;
  if (typeof segment !== "object") {
    return handlerDestinationCheck(typeAtKey(type, segment), path, index + 1, value, scope, lowering, strict);
  }
  if (type.kind === "list" || type.kind === "record") {
    return handlerDestinationCheck(type.kind === "list" ? type.item : type.value,
      path, index + 1, value, scope, lowering, strict);
  }
  if (type.kind === "constrained") {
    return handlerDestinationCheck(type.base, path, index, value, scope, lowering, strict);
  }
  if (type.kind === "union" || type.kind === "selected") {
    const members = type.kind === "union" ? type.members : type.options.map((option) => option.type);
    const checks = members.flatMap((member) => {
      const check = handlerDestinationCheck(member, path, index, value, scope, lowering, strict);
      return check === undefined ? [] : [check];
    });
    return checks.length === 0 ? undefined : `(${checks.join(" || ")})`;
  }
  if (type.kind !== "object") return undefined;
  const key = `String(${lowering.value(segment.expression, scope)})`;
  const checks = type.fields.map((field) => {
    const check = handlerDestinationCheck(field.type, path, index + 1, value, scope, lowering, strict) ?? "true";
    return `(${key} === ${quote(field.name)} && ${check})`;
  });
  if (type.open) checks.push(`!${JSON.stringify(type.fields.map((field) => field.name))}.includes(${key})`);
  return checks.length === 0 ? "false" : `(${checks.join(" || ")})`;
}

/** Declared types constrain expressions at the point each reference is read. */
export function declaredReferenceGuard(plan: CompiledExpression, scope: Scope, definition: ComponentDefinition, strict?: StrictTypePredicate): string | undefined {
  const checks = typeCheckedDependencies(plan).flatMap((path) => {
    const [root, ...steps] = path.split(".");
    const source = scope.code.get(root!);
    if (source === undefined) return [];
    // A declared path may intentionally name an absent field. The runtime checks that value at
    // read time, and generated TypeScript must not reject the component for testing that absence.
    const read = `(${source} as any)${steps.map((step) => `?.[${quote(step)}]`).join("")}`;
    const check = (initial: TypeNode, keys: readonly string[]): string[] => {
      let type: TypeNode | undefined = initial;
      for (const step of keys) {
        type = typeAtKey(type, step);
        if (type === undefined) return [];
      }
      return [`(${read} == null || ${destinationTypeCheck(type, read, strict)})`];
    };
    const prop = definition.contract.props[root!];
    if (prop === undefined) {
      const declaration = definition.declarations?.find((entry) => entry.name === root);
      if (declaration?.kind === "state" || declaration?.kind === "computed") {
        const type = declarationTypeNode(declaration.type, declaration.shape);
        return type === undefined ? [] : check(type, steps);
      }
      if (declaration?.kind !== "data") return [];
      const [surface, ...keys] = steps;
      if (surface === "pending" || surface === "ok") return check({ kind: "terminal", name: "boolean" }, keys);
      if (surface !== "value" || declaration.type === undefined) return [];
      return check(declaration.type === "text" ? { kind: "terminal", name: "string" }
        : parseTypeExpression(declaration.type), keys);
    }
    const select = prop.select;
    if (select === undefined) return check(normalizeType(prop.type), steps);
    const selector = scope.code.get(select.from);
    if (selector === undefined) return [];
    const options = select.options.map((option) => {
      let type = option.type;
      for (const step of steps) {
        const next = typeAtKey(type, step);
        if (next === undefined) return `(${selector} === ${JSON.stringify(option.value)})`;
        type = next;
      }
      return `(${selector} === ${JSON.stringify(option.value)} && ${destinationTypeCheck(type, read, strict)})`;
    });
    return [`(${read} == null || (${options.join(" || ")}))`];
  });
  return checks.length === 0 ? undefined : checks.join(" && ");
}

