/** The complete HTML Next value-type grammar and its canonical runtime representation. */

import { deepFreeze, isNativeEvent } from "./freeze.js";
import { compileExpression } from "./expression.js";
import { parseHtmlLiteral } from "./structured-input.js";
import { CSS_COLOR_KEYWORDS } from "./css-color-keywords.js";
import { boundFailures, type ValueBounds } from "./value-constraints.js";

export type TerminalTypeName =
  | "string"
  | "keyword"
  | "boolean"
  | "number"
  | "integer"
  | "url"
  | "email"
  | "date"
  | "month"
  | "week"
  | "time"
  | "datetime-local"
  | "datetime"
  | "color"
  | "color-hex"
  | "length"
  | "percentage"
  | "duration"
  | "null"
  | "absent"
  | "trusted-html"
  | "trusted-script"
  | "function"
  | "unknown"
  | "event";

export interface TerminalType {
  readonly kind: "terminal";
  readonly name: TerminalTypeName;
}

export interface KeywordType {
  readonly kind: "keyword";
  readonly value: string;
}

export interface SeparatedListType {
  readonly kind: "separated-list";
  readonly item: TerminalType;
  readonly separator: "space" | "comma";
}

export interface UnionType {
  readonly kind: "union";
  readonly members: readonly TypeNode[];
}

/** A prop's effective type, chosen by another prop's already parsed value. */
export interface SelectedType {
  readonly kind: "selected";
  readonly from: string;
  readonly options: readonly { readonly value: string | number | boolean; readonly type: TypeNode }[];
}

/** A scalar type with authored value constraints on a nested field. */
export interface ConstrainedType extends ValueBounds {
  readonly kind: "constrained";
  readonly base: TypeNode;
  readonly values?: readonly (string | number | boolean)[];
}

export interface ListType {
  readonly kind: "list";
  readonly item: TypeNode;
}

export interface RecordType {
  readonly kind: "record";
  readonly value: TypeNode;
}

export interface ObjectField {
  readonly name: string;
  readonly type: TypeNode;
  readonly optional: boolean;
}

export interface ObjectType {
  readonly kind: "object";
  readonly fields: readonly ObjectField[];
  readonly open: boolean;
}

export type TypeNode =
  | TerminalType
  | KeywordType
  | SeparatedListType
  | UnionType
  | SelectedType
  | ConstrainedType
  | ListType
  | RecordType
  | ObjectType;

export type TypeInput =
  | TypeNode
  | "string"
  | "boolean"
  | "number";

export type TypeIssueReason = "typeMismatch" | "badInput" | "untrustedValue" |
  "rangeUnderflow" | "rangeOverflow" | "tooShort" | "tooLong" | "patternMismatch";

export interface TypeIssue {
  readonly reason: TypeIssueReason;
  readonly message: string;
  readonly path: string;
}

export type TypedResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly TypeIssue[] };

export interface TrustedContentValue {
  readonly kind: "trusted-html" | "trusted-script";
  readonly value: unknown;
}

const UNKNOWN: TypeNode = { kind: "terminal", name: "unknown" };

const TERMINALS = new Set<TerminalTypeName>([
  "string", "keyword", "boolean", "number", "integer", "url", "email", "date", "month",
  "week", "time", "datetime-local", "datetime", "color", "color-hex", "length",
  "percentage", "duration", "null", "absent",
  "trusted-html", "trusted-script", "function", "unknown", "event",
]);

const PUBLIC_TERMINALS = new Set([
  "string", "keyword", "boolean", "integer", "number", "url", "email", "date",
  "month", "week", "time", "datetime-local", "datetime", "color", "color-hex",
  "length", "percentage", "duration", "unknown", "event",
]);
const CSS_NAMED_COLOR_SET = new Set<string>(CSS_COLOR_KEYWORDS);
// HTML's valid-email-address production permits a single-label domain such as a@b.
export const HTML_EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/?=^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Names the grammar reads as a type, so a keyword spelling one must be written quoted. */
const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([...TERMINALS, "list", "record", "object"]);

export class TypeSyntaxError extends SyntaxError {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at character ${position + 1}.`);
    this.name = "TypeSyntaxError";
  }
}

class Parser {
  #index = 0;

  constructor(readonly source: string) {}

  parse(): TypeNode {
    const result = this.#primary();
    this.#space();
    if (this.#index !== this.source.length) this.#error("Unexpected type syntax");
    return result;
  }

  #primary(): TypeNode {
    const name = this.#identifier();
    if (name === undefined) this.#error("Expected a type name");
    if (PUBLIC_TERMINALS.has(name)) {
      const item = { kind: "terminal", name: name as TerminalTypeName } as const;
      if (name === "keyword" && this.#take("+")) return { kind: "separated-list", item, separator: "space" };
      if (name === "keyword" && this.#take("#")) return { kind: "separated-list", item, separator: "comma" };
      return item;
    }
    if (name === "list") {
      this.#expect("(");
      const item = this.#primary();
      this.#expect(")");
      return { kind: "list", item };
    }
    if (name === "object") return this.#peek("(") ? this.#object() : { kind: "record", value: UNKNOWN };
    this.#error(`Unknown type \`${name}\``);
  }

  #object(): ObjectType {
    this.#expect("(");
    this.#expect("{");
    const fields: ObjectField[] = [];
    let open = false;
    while (!this.#take("}")) {
      this.#space();
      if (this.source.startsWith("...", this.#index)) {
        this.#index += 3;
        open = true;
      } else {
        const name = this.#quoted() ?? this.#identifier();
        if (name === undefined) this.#error("Expected an object field or `...`");
        const optional = this.#take("?");
        this.#expect(":");
        const type = this.#primary();
        if (fields.some((field) => field.name === name)) this.#error(`Duplicate object field \`${name}\``);
        fields.push({ name, type, optional });
      }
      if (this.#take("}")) break;
      this.#expect(",");
      if (open) {
        this.#space();
        if (!this.source.startsWith("}", this.#index)) this.#error("The open marker must be last");
      }
    }
    this.#expect(")");
    return { kind: "object", fields, open };
  }

  #identifier(): string | undefined {
    this.#space();
    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.source.slice(this.#index));
    if (match === null) return undefined;
    this.#index += match[0].length;
    return match[0];
  }

  #quoted(): string | undefined {
    this.#space();
    const quote = this.source[this.#index];
    if (quote !== "\"" && quote !== "'") return undefined;
    this.#index += 1;
    let result = "";
    while (this.#index < this.source.length) {
      const character = this.source[this.#index++]!;
      if (character === quote) return result;
      if (character !== "\\") {
        result += character;
        continue;
      }
      if (this.#index >= this.source.length) this.#error("Unterminated escape");
      const escaped = this.source[this.#index++]!;
      const escapes: Readonly<Record<string, string>> = {
        "n": "\n", "r": "\r", "t": "\t", "\\": "\\", "\"": "\"", "'": "'",
      };
      result += escapes[escaped] ?? escaped;
    }
    this.#error("Unterminated quoted keyword");
  }

  #peek(token: string): boolean {
    this.#space();
    return this.source.startsWith(token, this.#index);
  }

  #take(token: string): boolean {
    this.#space();
    if (!this.source.startsWith(token, this.#index)) return false;
    this.#index += token.length;
    return true;
  }

  #expect(token: string): void {
    if (!this.#take(token)) this.#error(`Expected \`${token}\``);
  }

  #space(): void {
    while (/\s/.test(this.source[this.#index] ?? "")) this.#index += 1;
  }

  #error(message: string): never {
    throw new TypeSyntaxError(message, this.#index);
  }
}

function union(members: readonly TypeNode[]): TypeNode {
  const flat = members.flatMap((member) => member.kind === "union" ? member.members : [member]);
  const unique = new Map(flat.map((member) => [formatType(member), member]));
  const values = Array.from(unique.values());
  return values.length === 1 ? values[0]! : { kind: "union", members: values };
}

/** Parse an HTML Next type expression into an immutable semantic node. */
export function parseTypeExpression(source: string): TypeNode {
  if (source.trim() === "") throw new TypeSyntaxError("A type expression cannot be empty", 0);
  return deepFreeze(new Parser(source).parse());
}

/** A declaration may have nested fields in addition to its written base type. */
export function declarationTypeNode(type: string | undefined, shape?: TypeNode): TypeNode | undefined {
  return shape ?? (type === undefined ? undefined : parseTypeExpression(type));
}

export function isTypeNode(value: unknown): value is TypeNode {
  return typeof value === "object" && value !== null && "kind" in value &&
    ["terminal", "keyword", "separated-list", "union", "selected", "constrained", "list", "record", "object"].includes(
      String((value as { kind?: unknown }).kind),
    );
}

export function normalizeType(type: TypeInput): TypeNode {
  if (isTypeNode(type)) return type;
  if (typeof type === "string") return { kind: "terminal", name: type };
  throw new TypeError("Invalid type input.");
}

/** The canonical source spelling used by serializers, diagnostics, and generated docs. */
export function formatType(type: TypeInput): string {
  const node = isTypeNode(type) ? type : normalizeType(type);
  switch (node.kind) {
    case "terminal": return node.name;
    case "separated-list": return `${node.item.name}${node.separator === "space" ? "+" : "#"}`;
    // A keyword spelled like a type name has to stay quoted, or reading the result back would
    // widen the literal `'unknown'` into the type that accepts anything.
    case "keyword": return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(node.value) && !RESERVED_TYPE_NAMES.has(node.value)
      ? node.value
      : JSON.stringify(node.value);
    case "union": return node.members.map((member) => formatType(member)).join(" | ");
    case "selected": return `selected by ${node.from}`;
    case "constrained": return `${formatType(node.base)}${node.values === undefined ? "" : ` with values ${node.values.map(String).join(", ")}`}`;
    case "list": return `list(${formatType(node.item)})`;
    case "record": return `record(${formatType(node.value)})`;
    case "object": return `object({ ${[
      ...node.fields.map((field) => `${field.name}${field.optional ? "?" : ""}: ${formatType(field.type)}`),
      ...(node.open ? ["..."] : []),
    ].join(", ")} })`;
  }
}

/**
 * The declared type of the value one step into `node`, or undefined when the declaration says
 * nothing about it. Used to resolve the type a reference like `foo.bar.blah` must satisfy.
 */
export function typeAtKey(node: TypeNode, key: string | number): TypeNode | undefined {
  switch (node.kind) {
    case "list":
      return typeof key === "number" || /^\d+$/.test(String(key)) ? node.item : undefined;
    case "record":
      return node.value;
    case "object": {
      const field = node.fields.find((candidate) => candidate.name === String(key));
      if (field !== undefined) return field.type;
      // A closed shape says the field does not exist; an open one says nothing about it.
      return node.open ? undefined : ABSENT_TYPE;
    }
    case "union": {
      // Any member that describes this key describes the reference.
      const described = node.members.map((member) => typeAtKey(member, key)).filter((type) => type !== undefined);
      if (described.length === 0) return undefined;
      return described.length === 1 ? described[0]! : union(described as TypeNode[]);
    }
    case "selected": {
      const described = node.options.map((option) => typeAtKey(option.type, key)).filter((type) => type !== undefined);
      if (described.length === 0) return undefined;
      return union(described as TypeNode[]);
    }
    case "constrained": return typeAtKey(node.base, key);
    default:
      return undefined;
  }
}

const ABSENT_TYPE: TypeNode = { kind: "terminal", name: "absent" };

export function typeScriptType(type: TypeInput): string {
  const node = normalizeType(type);
  switch (node.kind) {
    case "terminal": {
      const values: Readonly<Record<TerminalTypeName, string>> = {
        string: "string", keyword: "string", boolean: "boolean", number: "number", integer: "number",
        url: "string", email: "string", date: "string", month: "string", week: "string",
        time: "string", "datetime-local": "string", datetime: "string", color: "string",
        "color-hex": "string", length: "string", percentage: "string", duration: "string",
        null: "null", absent: "undefined", "trusted-html": "TrustedHTML",
        "trusted-script": "TrustedScript", "function": "(...args: readonly unknown[]) => unknown",
        unknown: "unknown", event: "Event",
      };
      return values[node.name];
    }
    case "separated-list": return "readonly string[]";
    case "keyword": return JSON.stringify(node.value);
    case "union": return node.members.map(typeScriptType).join(" | ");
    case "selected": return [...new Set(node.options.map((option) => typeScriptType(option.type)))].join(" | ");
    case "constrained": return node.values === undefined ? typeScriptType(node.base)
      : node.values.map((value) => JSON.stringify(value)).join(" | ");
    case "list": return `readonly (${typeScriptType(node.item)})[]`;
    case "record": return `Readonly<Record<string, ${typeScriptType(node.value)}>>`;
    case "object": {
      const fields = node.fields.map((field) =>
        `${typescriptKey(field.name)}${field.optional ? "?" : ""}: ${typeScriptType(field.type)}`,
      );
      if (node.open) fields.push("[name: string]: unknown");
      return `{ readonly ${fields.join("; readonly ")} }`;
    }
  }
}

function typescriptKey(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

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

function browserTrusted(value: unknown, type: "trusted-html" | "trusted-script"): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { kind?: unknown }).kind === type && "value" in value) return true;
  const expected = type === "trusted-html" ? "TrustedHTML" : "TrustedScript";
  return (value as { constructor?: { name?: string } }).constructor?.name === expected ||
    Object.prototype.toString.call(value) === `[object ${expected}]`;
}

function validDate(value: string): boolean {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const date = new Date(0);
  date.setUTCFullYear(year, Number(match[2]) - 1, Number(match[3]));
  return date.getUTCFullYear() === year && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
}

function validFunctionalColor(value: string): boolean {
  const match = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/i.exec(value);
  if (match === null) return false;
  const body = match[2]!.trim();
  const parts = body.replaceAll(",", " ").replaceAll("/", " ").split(/\s+/);
  const colorSpace = match[1]!.toLowerCase() === "color";
  if (colorSpace && !/^(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)$/.test(parts.shift() ?? "")) return false;
  if (parts.length < 3 || parts.length > 4) return false;
  if (parts.length === 4 && !body.includes("/") && !body.includes(",")) return false;
  return parts.every((part) => part === "none" || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|rad|grad|turn)?$/.test(part));
}

// Prop parsing also runs in Node during builds and SSR. The color subset stays the same in
// both environments rather than accepting browser-only CSS forms during hydration.
function validFormat(value: string, name: TerminalTypeName): boolean {
  switch (name) {
    case "keyword": return /^[A-Za-z0-9_-]+$/.test(value);
    case "url": {
      try { return new URL(value).protocol !== ""; } catch { return false; }
    }
    case "email": return HTML_EMAIL_PATTERN.test(value);
    case "date": return validDate(value);
    case "month": return /^(?!0000)\d{4,}-(?:0[1-9]|1[0-2])$/.test(value);
    case "week": {
      const match = /^(\d{4,})-W(\d{2})$/.exec(value);
      if (match === null || match[1] === "0000") return false;
      const year = Number(match[1]);
      const week = Number(match[2]);
      const jan1 = new Date(0);
      jan1.setUTCFullYear(year, 0, 1);
      const jan1Day = jan1.getUTCDay();
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return week >= 1 && (week < 53 || (week === 53 && (jan1Day === 4 || (jan1Day === 3 && leap))));
    }
    case "time": return validTime(value);
    case "datetime-local": {
      const match = /^(\d{4,}-\d{2}-\d{2})[T ](.+)$/.exec(value);
      return match !== null && validDate(match[1]!) && validTime(match[2]!);
    }
    case "datetime": {
      const match = /^(\d{4,}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.exec(value);
      return match !== null && validDate(match[1]!) && validTime(match[2]!);
    }
    case "color-hex": return /^#[\da-fA-F]{3}(?:[\da-fA-F]{1}|[\da-fA-F]{3}(?:[\da-fA-F]{2})?)?$/.test(value);
    case "color": return validFormat(value, "color-hex") || CSS_NAMED_COLOR_SET.has(value.toLowerCase()) ||
      validFunctionalColor(value);
    case "length": return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc|q)$/.test(value) || value === "0";
    case "percentage": return /^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value);
    case "duration": return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/.test(value);
    default: return false;
  }
}

function parseTerminal(value: unknown, name: TerminalTypeName, path: string, source: "html" | "value"): TypedResult {
  switch (name) {
    case "string":
      return typeof value === "string" ? { ok: true, value } : issue("typeMismatch", "Must be a string.", path);
    case "keyword":
    case "url":
    case "email":
    case "date":
    case "month":
    case "week":
    case "time":
    case "datetime-local":
    case "datetime":
    case "color":
    case "color-hex":
    case "length":
    case "percentage":
    case "duration":
      return typeof value === "string" && validFormat(value, name)
        ? { ok: true, value } : issue("typeMismatch", `Must be a valid ${name} value.`, path);
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (source === "value") return issue("typeMismatch", "Must be true or false.", path);
      if (value === "" || value === "true") return { ok: true, value: true };
      if (value === "false") return { ok: true, value: false };
      return issue("typeMismatch", "Must be true or false.", path);
    case "number":
    case "integer": {
      const parsed = typeof value === "number" ? value :
        source === "value" ? Number.NaN :
        typeof value === "string" && (name === "integer" ? /^-?\d+$/.test(value)
          : /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
          ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed)) return issue("badInput", `Must be ${name === "integer" ? "an integer" : "a finite number"}.`, path);
      if (name === "integer" && !Number.isInteger(parsed)) return issue("typeMismatch", "Must be an integer.", path);
      return { ok: true, value: parsed };
    }
    case "null": return value === null ? { ok: true, value: null } : issue("typeMismatch", "Must be null.", path);
    case "absent": return value === undefined ? { ok: true, value: undefined } : issue("typeMismatch", "Must be absent.", path);
    case "trusted-html":
    case "trusted-script": return browserTrusted(value, name)
      ? { ok: true, value }
      : issue("untrustedValue", `Must be a ${name === "trusted-html" ? "TrustedHTML" : "TrustedScript"} value.`, path);
    case "function": return typeof value === "function"
      ? { ok: true, value }
      : issue("typeMismatch", "Must be a function supplied through a property.", path);
    case "event": return isNativeEvent(value)
      ? { ok: true, value }
      : issue("typeMismatch", "Must be a native Event value.", path);
    case "unknown": return { ok: true, value };
  }
}

function parseNode(value: unknown, node: TypeNode, path: string, source: "html" | "value"): TypedResult {
  switch (node.kind) {
    case "terminal": return parseTerminal(value, node.name, path, source);
    case "separated-list": {
      const input = typeof value === "string" ? value.split(node.separator === "space" ? /\s+/ : /\s*,\s*/)
        : value;
      if (!Array.isArray(input) || input.length === 0 || input.some((item) => item === "")) {
        return issue("typeMismatch", "Must be a nonempty separated list.", path);
      }
      const issues = input.flatMap((item, index) => {
        const result = parseNode(item, node.item, childPath(path, index), "value");
        return result.ok ? [] : result.issues;
      });
      return issues.length === 0 ? { ok: true, value: input } : { ok: false, issues };
    }
    case "keyword": return value === node.value
      ? { ok: true, value }
      : issue("typeMismatch", `Must be ${JSON.stringify(node.value)}.`, path);
    case "union": {
      for (const member of node.members) {
        const result = parseNode(value, member, path, source);
        if (result.ok) return result;
      }
      return issue("typeMismatch", `Must match ${formatType(node)}.`, path);
    }
    case "selected": return issue("typeMismatch", `Type depends on the \`${node.from}\` declaration.`, path);
    case "constrained": {
      const parsed = parseNode(value, node.base, path, source);
      if (!parsed.ok) return parsed;
      if (node.values !== undefined && !node.values.some((choice) => choice === parsed.value)) {
        return issue("typeMismatch", `Must be one of ${node.values.map(String).join(", ")}.`, path);
      }
      const base = node.base.kind === "terminal" ? node.base.name : "";
      const failures = boundFailures(parsed.value, base, node);
      return failures.length === 0 ? parsed : { ok: false, issues: failures.map((failure) => ({ ...failure, path })) };
    }
    case "list": {
      const input = source === "html" ? structuredInput(value) : value;
      if (!Array.isArray(input)) return issue("typeMismatch", "Must be a list.", path);
      const output: unknown[] = [];
      const issues: TypeIssue[] = [];
      input.forEach((item, index) => {
        const result = parseNode(item, node.item, childPath(path, index), "value");
        if (result.ok) output.push(result.value);
        else issues.push(...result.issues);
      });
      return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
    }
    case "record": {
      const input = source === "html" ? structuredInput(value) : value;
      if (!plainObject(input)) return issue("typeMismatch", "Must be a string-keyed record.", path);
      const output: Record<string, unknown> = {};
      const issues: TypeIssue[] = [];
      for (const [key, item] of Object.entries(input)) {
        const result = parseNode(item, node.value, childPath(path, key), "value");
        if (result.ok) output[key] = result.value;
        else issues.push(...result.issues);
      }
      return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
    }
    case "object": {
      const input = source === "html" ? structuredInput(value) : value;
      if (!plainObject(input)) return issue("typeMismatch", "Must be an object.", path);
      const output: Record<string, unknown> = {};
      const issues: TypeIssue[] = [];
      const fields = new Map(node.fields.map((field) => [field.name, field]));
      for (const field of node.fields) {
        if (!(field.name in input)) {
          if (!field.optional) issues.push({ reason: "typeMismatch", message: "Required field is absent.", path: childPath(path, field.name) });
          continue;
        }
        const result = parseNode(input[field.name], field.type, childPath(path, field.name), "value");
        if (result.ok) output[field.name] = result.value;
        else issues.push(...result.issues);
      }
      for (const [key, item] of Object.entries(input)) {
        if (fields.has(key)) continue;
        if (node.open) output[key] = item;
        else issues.push({ reason: "typeMismatch", message: "Field is not declared by this closed object type.", path: childPath(path, key) });
      }
      return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
    }
  }
}

/** Parse and canonicalize a value at a typed boundary without implicit JS coercion. */
export function parseTypedValue(value: unknown, type: TypeInput, path = "$", source: "html" | "value" = "html"): TypedResult {
  return parseNode(value, normalizeType(type), path, source);
}

/** Serialize a value using its declared type, never JavaScript's object stringification. */
export function serializeTypedValue(value: unknown, type: TypeInput): string {
  const parsed = parseTypedValue(value, type);
  if (!parsed.ok) throw new TypeError(parsed.issues.map((item) => `${item.path}: ${item.message}`).join("; "));
  const node = normalizeType(type);
  if (isNativeEvent(parsed.value)) throw new TypeError("Native event values cannot be serialized.");
  if (node.kind === "terminal" && (node.name === "function" || node.name === "unknown")) {
    throw new TypeError(`The ${node.name} type is property-only and cannot be serialized.`);
  }
  if (node.kind === "list" || node.kind === "record" || node.kind === "object" ||
      (node.kind === "union" && typeof parsed.value === "object" && parsed.value !== null)) {
    return JSON.stringify(parsed.value, (_key, item: unknown) => {
      if (isNativeEvent(item)) throw new TypeError("Native event values cannot be serialized.");
      return item;
    });
  }
  if (node.kind === "separated-list") return (parsed.value as string[]).join(node.separator === "space" ? " " : ", ");
  if (parsed.value === null) return "null";
  if (parsed.value === undefined) return "";
  return String(parsed.value);
}

/**
 * Whether a prop type can be written as an HTML attribute. Props are attributes on the component
 * invocation, so every declared type with a text form qualifies: scalar types and enums as
 * their text, and collection and structured shapes as literal text parsed against the declared shape.
 * `event`, `function`, `unknown`, and trusted content have no text form and cannot be props.
 */
export function isAttributeType(type: TypeInput): boolean {
  const node = normalizeType(type);
  if (node.kind === "terminal") {
    return !["event", "function", "unknown", "trusted-html", "trusted-script"].includes(node.name);
  }
  if (node.kind === "keyword") return true;
  if (node.kind === "separated-list") return true;
  if (node.kind === "union") return node.members.every(isAttributeType);
  if (node.kind === "selected") return node.options.every((option) => isAttributeType(option.type));
  if (node.kind === "constrained") return isAttributeType(node.base);
  if (node.kind === "list") return isAttributeType(node.item);
  if (node.kind === "record") return isAttributeType(node.value);
  return node.fields.every((field) => isAttributeType(field.type));
}

/** Explicitly brand an already-approved Trusted Types-compatible value for non-browser hosts. */
export function trustedContent(
  kind: "trusted-html" | "trusted-script",
  value: unknown,
): TrustedContentValue {
  return Object.freeze({ kind, value });
}
