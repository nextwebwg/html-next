/** The complete HTML Next value-type grammar and its canonical runtime representation. */

import { deepFreeze, isNativeEvent } from "./freeze.js";
import {
  checkAbsent, checkBoolean, checkConstrained, checkEvent, checkFormat, checkFunction, checkInteger, checkKeyword, checkList,
  checkNull, checkNumber, checkObject, checkRecord, checkSelectedType, checkSeparated, checkString, checkTrusted, checkUnion,
  checkUnknown, typedText, type TextForm, type TypeCheck,
} from "./type-checks.js";
import {
  colorFormat, colorHexFormat, dateFormat, datetimeFormat, datetimeLocalFormat, durationFormat, emailFormat, keywordFormat,
  lengthFormat, monthFormat, percentageFormat, timeFormat, urlFormat, weekFormat,
} from "./formats.js";
import type { ValueBounds } from "./value-constraints.js";

export { browserTrusted, childPath, typedText, type TextForm, type TypeCheck } from "./type-checks.js";

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
// HTML's valid-email-address production permits a single-label domain such as a@b.
export { HTML_EMAIL_PATTERN } from "./formats.js";

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

const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  keyword: keywordFormat, url: urlFormat, email: emailFormat, date: dateFormat, month: monthFormat, week: weekFormat,
  time: timeFormat, "datetime-local": datetimeLocalFormat, datetime: datetimeFormat, color: colorFormat,
  "color-hex": colorHexFormat, length: lengthFormat, percentage: percentageFormat, duration: durationFormat,
};

function terminalCheck(name: TerminalTypeName): TypeCheck {
  switch (name) {
    case "string": return checkString;
    case "boolean": return checkBoolean;
    case "number": return checkNumber;
    case "integer": return checkInteger;
    case "null": return checkNull;
    case "absent": return checkAbsent;
    case "trusted-html":
    case "trusted-script": return checkTrusted(name);
    case "function": return checkFunction;
    case "event": return checkEvent;
    case "unknown": return checkUnknown;
    default: return checkFormat(name, FORMATS[name]!);
  }
}

const terminalChecks = new Map<string, TypeCheck>();
const nodeChecks = new WeakMap<TypeNode, TypeCheck>();

/** A declared type's check, built once per type. */
export function typeCheck(type: TypeInput): TypeCheck {
  if (typeof type === "string") {
    let check = terminalChecks.get(type);
    if (check === undefined) terminalChecks.set(type, check = terminalCheck((normalizeType(type) as TerminalType).name));
    return check;
  }
  const node = normalizeType(type);
  let check = nodeChecks.get(node);
  if (check === undefined) nodeChecks.set(node, check = buildCheck(node));
  return check;
}

function buildCheck(node: TypeNode): TypeCheck {
  switch (node.kind) {
    case "terminal": return typeCheck(node.name as TypeInput & string);
    case "separated-list": return checkSeparated(typeCheck(node.item), node.separator === "space");
    case "keyword": return checkKeyword(node.value);
    case "union": return checkUnion(node.members.map(typeCheck), formatType(node));
    case "selected": return checkSelectedType(node.from);
    case "constrained": return checkConstrained(typeCheck(node.base), node.base.kind === "terminal" ? node.base.name : "", node);
    case "list": return checkList(typeCheck(node.item));
    case "record": return checkRecord(typeCheck(node.value));
    case "object": return checkObject(node.fields.map((field) => [field.name, typeCheck(field.type), field.optional] as const), node.open);
  }
}

/** Parse and canonicalize a value at a typed boundary without implicit JS coercion. */
export function parseTypedValue(value: unknown, type: TypeInput, path = "$", source: "html" | "value" = "html"): TypedResult {
  return typeCheck(type)(value, path, source);
}

export function textForm(type: TypeInput): TextForm {
  const node = normalizeType(type);
  switch (node.kind) {
    case "list":
    case "record":
    case "object": return 1;
    case "union": return 2;
    case "separated-list": return node.separator === "space" ? " " : ", ";
    default: return 0;
  }
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
  return typedText(parsed.value, textForm(node));
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
