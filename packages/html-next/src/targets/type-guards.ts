import type { WritablePathSegment } from "../expression.js";
import { typeAtKey, type TypeNode } from "../type-system.js";
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

/** Handler destinations check their immediate type; nested values keep their authored input. */
export function destinationTypeCheck(type: TypeNode, value: string): string {
  switch (type.kind) {
    case "list": return `Array.isArray(${value})`;
    case "record":
    case "object": return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value}))`;
    case "union": return `(${type.members.map((member) => destinationTypeCheck(member, value)).join(" || ")})`;
    case "selected": return `(${type.options.map((option) => destinationTypeCheck(option.type, value)).join(" || ")})`;
    case "constrained": return destinationTypeCheck(type.base, value);
    default: return typeCheck(type, value);
  }
}

export function handlerDestinationCheck(
  type: TypeNode | undefined,
  path: readonly WritablePathSegment[],
  index: number,
  value: string,
  scope: Scope,
  lowering: Lowering,
): string | undefined {
  if (type === undefined) return undefined;
  if (index === path.length) return destinationTypeCheck(type, value);
  const segment = path[index]!;
  if (typeof segment !== "object") {
    return handlerDestinationCheck(typeAtKey(type, segment), path, index + 1, value, scope, lowering);
  }
  if (type.kind === "list" || type.kind === "record") {
    return handlerDestinationCheck(type.kind === "list" ? type.item : type.value,
      path, index + 1, value, scope, lowering);
  }
  if (type.kind === "constrained") {
    return handlerDestinationCheck(type.base, path, index, value, scope, lowering);
  }
  if (type.kind === "union" || type.kind === "selected") {
    const members = type.kind === "union" ? type.members : type.options.map((option) => option.type);
    const checks = members.flatMap((member) => {
      const check = handlerDestinationCheck(member, path, index, value, scope, lowering);
      return check === undefined ? [] : [check];
    });
    return checks.length === 0 ? undefined : `(${checks.join(" || ")})`;
  }
  if (type.kind !== "object") return undefined;
  const key = `String(${lowering.value(segment.expression, scope)})`;
  const checks = type.fields.map((field) => {
    const check = handlerDestinationCheck(field.type, path, index + 1, value, scope, lowering) ?? "true";
    return `(${key} === ${quote(field.name)} && ${check})`;
  });
  if (type.open) checks.push(`!${JSON.stringify(type.fields.map((field) => field.name))}.includes(${key})`);
  return checks.length === 0 ? "false" : `(${checks.join(" || ")})`;
}
