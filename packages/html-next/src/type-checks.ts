/**
 * Each value type's check at a typed boundary, as its own export: generated components bundle only
 * the checks their declared types use, and `typeCheck` (type-system.ts) builds any type's from them.
 */

import { isNativeEvent } from "./freeze.js";
import { compileExpression } from "./expression.js";
import { parseHtmlLiteral } from "./structured-input.js";
import { boundFailures, type ValueBounds } from "./value-constraints.js";
import type { ConstrainedType, TypedResult, TypeIssue, TypeIssueReason } from "./type-system.js";

function issue(reason: TypeIssueReason, message: string, path: string): TypedResult {
  return { ok: false, issues: [{ reason, message, path }] };
}

/** Canonical structured-value path spelling shared by every typed and schema diagnostic. */
export function childPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const readStructuredExpression = (source: string) => compileExpression(source).ast;
function structuredInput(value: unknown): unknown {
  return parseHtmlLiteral(value, readStructuredExpression);
}

export function browserTrusted(value: unknown, type: "trusted-html" | "trusted-script"): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { kind?: unknown }).kind === type && "value" in value) return true;
  const expected = type === "trusted-html" ? "TrustedHTML" : "TrustedScript";
  return (value as { constructor?: { name?: string } }).constructor?.name === expected ||
    Object.prototype.toString.call(value) === `[object ${expected}]`;
}

/** One type's check: parses a value from HTML text or a property into its canonical form, or reports its issues. */
export type TypeCheck = (value: unknown, path: string, source: "html" | "value") => TypedResult;

const accepted = (value: unknown): TypedResult => ({ ok: true, value });

export const checkString: TypeCheck = (value, path) =>
  typeof value === "string" ? accepted(value) : issue("typeMismatch", "Must be a string.", path);

/** A string format: keyword, url, email, the date and time forms, colors, length, percentage or duration. */
export const checkFormat = (name: string, format: (value: string) => boolean): TypeCheck => (value, path) =>
  typeof value === "string" && format(value) ? accepted(value) : issue("typeMismatch", `Must be a valid ${name} value.`, path);

export const checkBoolean: TypeCheck = (value, path, source) => {
  if (typeof value === "boolean") return accepted(value);
  if (source === "html" && (value === "" || value === "true")) return accepted(true);
  if (source === "html" && value === "false") return accepted(false);
  return issue("typeMismatch", "Must be true or false.", path);
};

const numeric = (integer: boolean): TypeCheck => (value, path, source) => {
  const parsed = typeof value === "number" ? value :
    source === "value" ? Number.NaN :
    typeof value === "string" && (integer ? /^-?\d+$/.test(value)
      : /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
      ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return issue("badInput", `Must be ${integer ? "an integer" : "a finite number"}.`, path);
  if (integer && !Number.isInteger(parsed)) return issue("typeMismatch", "Must be an integer.", path);
  return accepted(parsed);
};
export const checkNumber: TypeCheck = /* @__PURE__ */ numeric(false);
export const checkInteger: TypeCheck = /* @__PURE__ */ numeric(true);

export const checkNull: TypeCheck = (value, path) => value === null ? accepted(null) : issue("typeMismatch", "Must be null.", path);
export const checkAbsent: TypeCheck = (value, path) => value === undefined ? accepted(undefined) : issue("typeMismatch", "Must be absent.", path);
export const checkTrusted = (name: "trusted-html" | "trusted-script"): TypeCheck => (value, path) => browserTrusted(value, name)
  ? accepted(value)
  : issue("untrustedValue", `Must be a ${name === "trusted-html" ? "TrustedHTML" : "TrustedScript"} value.`, path);
export const checkFunction: TypeCheck = (value, path) => typeof value === "function"
  ? accepted(value)
  : issue("typeMismatch", "Must be a function supplied through a property.", path);
export const checkEvent: TypeCheck = (value, path) => isNativeEvent(value)
  ? accepted(value)
  : issue("typeMismatch", "Must be a native Event value.", path);
export const checkUnknown: TypeCheck = (value) => accepted(value);

export const checkSeparated = (item: TypeCheck, space: boolean): TypeCheck => (value, path) => {
  const input = typeof value === "string" ? value.split(space ? /\s+/ : /\s*,\s*/) : value;
  if (!Array.isArray(input) || input.length === 0 || input.some((entry) => entry === "")) {
    return issue("typeMismatch", "Must be a nonempty separated list.", path);
  }
  const issues = input.flatMap((entry, index) => {
    const result = item(entry, childPath(path, index), "value");
    return result.ok ? [] : result.issues;
  });
  return issues.length === 0 ? accepted(input) : { ok: false, issues };
};

export const checkKeyword = (keyword: string): TypeCheck => (value, path) => value === keyword
  ? accepted(value)
  : issue("typeMismatch", `Must be ${JSON.stringify(keyword)}.`, path);

/** A union: its first member that accepts the value; `label` is the union's `formatType`. */
export const checkUnion = (members: readonly TypeCheck[], label: string): TypeCheck => (value, path, source) => {
  for (const member of members) {
    const result = member(value, path, source);
    if (result.ok) return result;
  }
  return issue("typeMismatch", `Must match ${label}.`, path);
};

export const checkSelectedType = (from: string): TypeCheck => (_value, path) =>
  issue("typeMismatch", `Type depends on the \`${from}\` declaration.`, path);

/** A scalar with authored values and bounds; `name` is its base's terminal name, which bounds compare by. */
export const checkConstrained = (
  base: TypeCheck, name: string, constraint: Pick<ConstrainedType, "values"> & ValueBounds,
): TypeCheck => (value, path, source) => {
  const parsed = base(value, path, source);
  if (!parsed.ok) return parsed;
  if (constraint.values !== undefined && !constraint.values.some((choice) => choice === parsed.value)) {
    return issue("typeMismatch", `Must be one of ${constraint.values.map(String).join(", ")}.`, path);
  }
  const failures = boundFailures(parsed.value, name, constraint);
  return failures.length === 0 ? parsed : { ok: false, issues: failures.map((failure) => ({ ...failure, path })) };
};

export const checkList = (item: TypeCheck): TypeCheck => (value, path, source) => {
  const input = source === "html" ? structuredInput(value) : value;
  if (!Array.isArray(input)) return issue("typeMismatch", "Must be a list.", path);
  const output: unknown[] = [];
  const issues: TypeIssue[] = [];
  input.forEach((entry, index) => {
    const result = item(entry, childPath(path, index), "value");
    if (result.ok) output.push(result.value);
    else issues.push(...result.issues);
  });
  return issues.length === 0 ? accepted(output) : { ok: false, issues };
};

export const checkRecord = (item: TypeCheck): TypeCheck => (value, path, source) => {
  const input = source === "html" ? structuredInput(value) : value;
  if (!plainObject(input)) return issue("typeMismatch", "Must be a string-keyed record.", path);
  const output: Record<string, unknown> = {};
  const issues: TypeIssue[] = [];
  for (const [key, entry] of Object.entries(input)) {
    const result = item(entry, childPath(path, key), "value");
    if (result.ok) output[key] = result.value;
    else issues.push(...result.issues);
  }
  return issues.length === 0 ? accepted(output) : { ok: false, issues };
};

/** An object: each field as `[name, check, optional]`, in declaration order. */
export const checkObject = (
  fields: readonly (readonly [name: string, check: TypeCheck, optional: boolean])[], open: boolean,
): TypeCheck => (value, path, source) => {
  const input = source === "html" ? structuredInput(value) : value;
  if (!plainObject(input)) return issue("typeMismatch", "Must be an object.", path);
  const output: Record<string, unknown> = {};
  const issues: TypeIssue[] = [];
  const names = new Set(fields.map(([name]) => name));
  for (const [name, check, optional] of fields) {
    if (!(name in input)) {
      if (!optional) issues.push({ reason: "typeMismatch", message: "Required field is absent.", path: childPath(path, name) });
      continue;
    }
    const result = check(input[name], childPath(path, name), "value");
    if (result.ok) output[name] = result.value;
    else issues.push(...result.issues);
  }
  for (const [key, entry] of Object.entries(input)) {
    if (names.has(key)) continue;
    if (open) output[key] = entry;
    else issues.push({ reason: "typeMismatch", message: "Field is not declared by this closed object type.", path: childPath(path, key) });
  }
  return issues.length === 0 ? accepted(output) : { ok: false, issues };
};

/** How a type writes a value it accepts as text: as a string, as JSON, as JSON when an object, or joined by a separator. */
export type TextForm = 0 | 1 | 2 | " " | ", ";

/** The text of a canonical value its type accepted, in the type's `TextForm`. */
export function typedText(value: unknown, form: TextForm): string {
  if (form === 1 || form === 2 && typeof value === "object" && value !== null) {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (isNativeEvent(item)) throw new TypeError("Native event values cannot be serialized.");
      return item;
    });
  }
  if (typeof form === "string") return (value as string[]).join(form);
  if (value === null) return "null";
  if (value === undefined) return "";
  return String(value);
}

