import type { TypeIssue } from "./type-system.js";

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

function childPath(path: string, key: string | number): string {
  return typeof key === "number" || /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path}${typeof key === "number" ? `[${key}]` : `.${key}`}`
    : `${path}[${JSON.stringify(key)}]`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function pointer(root: JsonSchema, reference: string): JsonSchema | undefined {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of reference.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "boolean" || (current !== null && typeof current === "object")
    ? current as JsonSchema
    : undefined;
}

function issue(path: string, message: string): TypeIssue {
  return { reason: "schemaMismatch", path, message };
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  references: Set<string>,
): TypeIssue[] {
  if (schema === true) return [];
  if (schema === false) return [issue(path, "The schema rejects every value.")];

  const reference = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (reference !== undefined) {
    if (references.has(reference)) return [];
    const target = pointer(root, reference);
    if (target === undefined) return [issue(path, `Schema reference \`${reference}\` cannot be resolved.`)];
    return validateNode(value, target, root, path, new Set([...references, reference]));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    return [issue(path, "Value is not one of the schema's allowed values.")];
  }
  if ("const" in schema && !sameValue(value, schema.const)) {
    return [issue(path, "Value does not equal the schema's required constant.")];
  }

  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [issue(path, `Expected ${types.join(" or ")}.`)];
  }

  const allOf = Array.isArray(schema.allOf) ? schema.allOf as JsonSchema[] : [];
  const errors = allOf.flatMap((part) => validateNode(value, part, root, path, references));
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf as JsonSchema[] : [];
  if (anyOf.length > 0 && !anyOf.some((part) => validateNode(value, part, root, path, references).length === 0)) {
    errors.push(issue(path, "Value does not satisfy any allowed schema branch."));
  }
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf as JsonSchema[] : [];
  if (oneOf.length > 0 && oneOf.filter(
    (part) => validateNode(value, part, root, path, references).length === 0,
  ).length !== 1) errors.push(issue(path, "Value must satisfy exactly one schema branch."));
  if (typeof schema.not === "boolean" || (schema.not !== null && typeof schema.not === "object")) {
    if (validateNode(value, schema.not as JsonSchema, root, path, references).length === 0) {
      errors.push(issue(path, "Value satisfies a schema branch that is forbidden."));
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
      errors.push(issue(path, `Use at least ${schema.minLength} characters.`));
    }
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) {
      errors.push(issue(path, `Use no more than ${schema.maxLength} characters.`));
    }
    if (typeof schema.pattern === "string") {
      try { if (!new RegExp(schema.pattern, "u").test(value)) errors.push(issue(path, "Value does not match the schema pattern.")); }
      catch { errors.push(issue(path, "The schema pattern is invalid.")); }
    }
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
      errors.push(issue(path, "Value is not an email address."));
    }
    if ((schema.format === "uri" || schema.format === "url")) {
      try { new URL(value); } catch { errors.push(issue(path, "Value is not an absolute URL.")); }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(issue(path, `Value must be at least ${schema.minimum}.`));
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(issue(path, `Value must be at most ${schema.maximum}.`));
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(issue(path, `Value must be greater than ${schema.exclusiveMinimum}.`));
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(issue(path, `Value must be less than ${schema.exclusiveMaximum}.`));
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) errors.push(issue(path, `Value must be a multiple of ${schema.multipleOf}.`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(issue(path, `Use at least ${schema.minItems} items.`));
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(issue(path, `Use no more than ${schema.maxItems} items.`));
    if (schema.uniqueItems === true && value.some((item, index) => value.slice(0, index).some((prior) => sameValue(prior, item)))) {
      errors.push(issue(path, "Array items must be unique."));
    }
    if (typeof schema.items === "boolean" || (schema.items !== null && typeof schema.items === "object")) {
      value.forEach((item, index) => errors.push(
        ...validateNode(item, schema.items as JsonSchema, root, childPath(path, index), references),
      ));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [];
    for (const name of required) if (!(name in record)) errors.push(issue(childPath(path, name), "Required field is absent."));
    const properties = schema.properties !== null && typeof schema.properties === "object"
      ? schema.properties as Record<string, JsonSchema>
      : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (name in record) errors.push(...validateNode(record[name], propertySchema, root, childPath(path, name), references));
    }
    for (const [name, item] of Object.entries(record)) {
      if (name in properties) continue;
      if (schema.additionalProperties === false) errors.push(issue(childPath(path, name), "Field is not allowed by the schema."));
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        errors.push(...validateNode(item, schema.additionalProperties as JsonSchema, root, childPath(path, name), references));
      }
    }
  }
  return errors;
}

/** Validates the deterministic JSON Schema subset documented by HTML Next. */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): readonly TypeIssue[] {
  return Object.freeze(validateNode(value, schema, schema, path, new Set()));
}
