/** The complete HTML Next value-type grammar and its canonical runtime representation. */

export type TerminalTypeName =
  | "string"
  | "boolean"
  | "number"
  | "integer"
  | "null"
  | "absent"
  | "email"
  | "url"
  | "date"
  | "time"
  | "datetime-local"
  | "month"
  | "week"
  | "color"
  | "token"
  | "ident"
  | "url-value"
  | "token-list"
  | "trusted-html"
  | "trusted-script";

export interface TerminalType {
  readonly kind: "terminal";
  readonly name: TerminalTypeName;
}

export interface KeywordType {
  readonly kind: "keyword";
  readonly value: string;
}

export interface UnionType {
  readonly kind: "union";
  readonly members: readonly TypeNode[];
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
  | UnionType
  | ListType
  | RecordType
  | ObjectType;

export type TypeInput =
  | TypeNode
  | "string"
  | "boolean"
  | "number"
  | { readonly enum: readonly string[] };

export type TypeIssueReason = "typeMismatch" | "badInput" | "schemaMismatch" | "untrustedValue";

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

const TERMINALS = new Set<TerminalTypeName>([
  "string", "boolean", "number", "integer", "null", "absent", "email", "url",
  "date", "time", "datetime-local", "month", "week", "color", "token", "ident",
  "url-value", "token-list", "trusted-html", "trusted-script",
]);

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
    const result = this.#union();
    this.#space();
    if (this.#index !== this.source.length) this.#error("Unexpected type syntax");
    return result;
  }

  #union(): TypeNode {
    const members = [this.#postfix()];
    while (this.#take("|")) members.push(this.#postfix());
    return members.length === 1 ? members[0]! : union(members);
  }

  #postfix(): TypeNode {
    let type = this.#primary();
    while (this.#take("?")) {
      type = union([
        type,
        { kind: "terminal", name: "null" },
        { kind: "terminal", name: "absent" },
      ]);
    }
    return type;
  }

  #primary(): TypeNode {
    if (this.#take("(")) {
      const type = this.#union();
      this.#expect(")");
      return type;
    }
    const quoted = this.#quoted();
    if (quoted !== undefined) return { kind: "keyword", value: quoted };

    const name = this.#identifier();
    if (name === undefined) this.#error("Expected a type, keyword, or group");
    if (name === "list" || name === "record") {
      this.#expect("(");
      const nested = this.#union();
      this.#expect(")");
      return name === "list" ? { kind: "list", item: nested } : { kind: "record", value: nested };
    }
    if (name === "object") return this.#object();
    if (TERMINALS.has(name as TerminalTypeName)) {
      return { kind: "terminal", name: name as TerminalTypeName };
    }
    return { kind: "keyword", value: name };
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
        const type = this.#union();
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
  return unique.size === 1 ? [...unique.values()][0]! : { kind: "union", members: [...unique.values()] };
}

/** Parse an HTML Next type expression into an immutable semantic node. */
export function parseTypeExpression(source: string): TypeNode {
  if (source.trim() === "") throw new TypeSyntaxError("A type expression cannot be empty", 0);
  return deepFreeze(new Parser(source).parse());
}

export function isTypeNode(value: unknown): value is TypeNode {
  return typeof value === "object" && value !== null && "kind" in value &&
    ["terminal", "keyword", "union", "list", "record", "object"].includes(
      String((value as { kind?: unknown }).kind),
    );
}

export function normalizeType(type: TypeInput): TypeNode {
  if (isTypeNode(type)) return type;
  if (typeof type === "string") return { kind: "terminal", name: type };
  return union(type.enum.map((value) => ({ kind: "keyword", value })));
}

/** The canonical source spelling used by serializers, diagnostics, and generated docs. */
export function formatType(type: TypeInput): string {
  const node = isTypeNode(type) ? type : normalizeType(type);
  switch (node.kind) {
    case "terminal": return node.name;
    case "keyword": return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(node.value)
      ? node.value
      : JSON.stringify(node.value);
    case "union": return node.members.map((member) => formatType(member)).join(" | ");
    case "list": return `list(${formatType(node.item)})`;
    case "record": return `record(${formatType(node.value)})`;
    case "object": return `object({ ${[
      ...node.fields.map((field) => `${field.name}${field.optional ? "?" : ""}: ${formatType(field.type)}`),
      ...(node.open ? ["..."] : []),
    ].join(", ")} })`;
  }
}

export function typeScriptType(type: TypeInput): string {
  const node = normalizeType(type);
  switch (node.kind) {
    case "terminal": {
      const values: Readonly<Record<TerminalTypeName, string>> = {
        string: "string", boolean: "boolean", number: "number", integer: "number",
        null: "null", absent: "undefined", email: "string", url: "string", date: "string",
        time: "string", "datetime-local": "string", month: "string", week: "string",
        color: "string", token: "string", ident: "string", "url-value": "string",
        "token-list": "readonly string[]", "trusted-html": "TrustedHTML",
        "trusted-script": "TrustedScript",
      };
      return values[node.name];
    }
    case "keyword": return JSON.stringify(node.value);
    case "union": return node.members.map(typeScriptType).join(" | ");
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

function childPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function structuredInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return Symbol.for("html-next.bad-json"); }
}

function validEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false;
  const match = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Za-z0-9.-]+)$/.exec(value);
  if (match === null || match[1]!.length > 64) return false;
  return match[2]!.split(".").every((label) =>
    label !== "" && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"),
  );
}

function validDate(value: string): boolean {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
}

function validWeek(value: string): boolean {
  const match = /^(\d{4,})-W(\d{2})$/.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return false;
  if (week < 53) return true;
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  return jan1 === 4 || (jan1 === 3 && new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29);
}

function browserTrusted(value: unknown, type: "trusted-html" | "trusted-script"): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { kind?: unknown }).kind === type && "value" in value) return true;
  const expected = type === "trusted-html" ? "TrustedHTML" : "TrustedScript";
  return (value as { constructor?: { name?: string } }).constructor?.name === expected ||
    Object.prototype.toString.call(value) === `[object ${expected}]`;
}

function parseTerminal(value: unknown, name: TerminalTypeName, path: string): TypedResult {
  switch (name) {
    case "string":
      return typeof value === "string" ? { ok: true, value } : issue("typeMismatch", "Must be a string.", path);
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "" || value === "true") return { ok: true, value: true };
      if (value === "false") return { ok: true, value: false };
      return issue("typeMismatch", "Must be true or false.", path);
    case "number":
    case "integer": {
      const parsed = typeof value === "number" ? value :
        typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed)) return issue("badInput", `Must be ${name === "integer" ? "an integer" : "a finite number"}.`, path);
      if (name === "integer" && !Number.isInteger(parsed)) return issue("typeMismatch", "Must be an integer.", path);
      return { ok: true, value: parsed };
    }
    case "null": return value === null ? { ok: true, value: null } : issue("typeMismatch", "Must be null.", path);
    case "absent": return value === undefined ? { ok: true, value: undefined } : issue("typeMismatch", "Must be absent.", path);
    case "email":
      return typeof value === "string" && validEmail(value)
        ? { ok: true, value }
        : issue("typeMismatch", "Must be a valid email address.", path);
    case "url": {
      if (typeof value !== "string") return issue("typeMismatch", "Must be a URL.", path);
      try {
        const parsed = new URL(value);
        return parsed.protocol !== "" ? { ok: true, value: parsed.href } : issue("typeMismatch", "Must be an absolute URL.", path);
      } catch { return issue("typeMismatch", "Must be a valid absolute URL.", path); }
    }
    case "date": return typeof value === "string" && validDate(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be a valid date (YYYY-MM-DD).", path);
    case "time": return typeof value === "string" && validTime(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be a valid time.", path);
    case "datetime-local": {
      if (typeof value !== "string") return issue("typeMismatch", "Must be a local date and time.", path);
      const parts = value.split("T");
      return parts.length === 2 && validDate(parts[0]!) && validTime(parts[1]!)
        ? { ok: true, value }
        : issue("typeMismatch", "Must be a valid local date and time.", path);
    }
    case "month": return typeof value === "string" && /^(?!0000)\d{4,}-(?:0[1-9]|1[0-2])$/.test(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be a valid month.", path);
    case "week": return typeof value === "string" && validWeek(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be a valid ISO week.", path);
    case "color": return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
      ? { ok: true, value: value.toLowerCase() } : issue("typeMismatch", "Must be a six-digit sRGB color.", path);
    case "token": return typeof value === "string" && value !== "" && !/[\t\n\f\r ]/.test(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be one non-empty HTML token.", path);
    case "ident": return typeof value === "string" && /^-?(?:-?[A-Za-z_]|[^\0-\x7f])(?:[A-Za-z0-9_-]|[^\0-\x7f])*$/.test(value) && !/^--$/.test(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be an identifier.", path);
    case "url-value": return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(value)
      ? { ok: true, value } : issue("typeMismatch", "Must be a URL value.", path);
    case "token-list": {
      const tokens = Array.isArray(value) ? value : typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : undefined;
      return tokens !== undefined && tokens.every((token) => typeof token === "string" && token !== "" && !/\s/.test(token))
        ? { ok: true, value: tokens }
        : issue("typeMismatch", "Must be a space-separated token list.", path);
    }
    case "trusted-html":
    case "trusted-script": return browserTrusted(value, name)
      ? { ok: true, value }
      : issue("untrustedValue", `Must be a ${name === "trusted-html" ? "TrustedHTML" : "TrustedScript"} value.`, path);
  }
}

function parseNode(value: unknown, node: TypeNode, path: string): TypedResult {
  switch (node.kind) {
    case "terminal": return parseTerminal(value, node.name, path);
    case "keyword": return value === node.value
      ? { ok: true, value }
      : issue("typeMismatch", `Must be ${JSON.stringify(node.value)}.`, path);
    case "union": {
      for (const member of node.members) {
        const result = parseNode(value, member, path);
        if (result.ok) return result;
      }
      return issue("typeMismatch", `Must match ${formatType(node)}.`, path);
    }
    case "list": {
      const input = structuredInput(value);
      if (!Array.isArray(input)) return issue("typeMismatch", "Must be a list.", path);
      const output: unknown[] = [];
      const issues: TypeIssue[] = [];
      input.forEach((item, index) => {
        const result = parseNode(item, node.item, childPath(path, index));
        if (result.ok) output.push(result.value);
        else issues.push(...result.issues);
      });
      return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
    }
    case "record": {
      const input = structuredInput(value);
      if (!plainObject(input)) return issue("typeMismatch", "Must be a string-keyed record.", path);
      const output: Record<string, unknown> = {};
      const issues: TypeIssue[] = [];
      for (const [key, item] of Object.entries(input)) {
        const result = parseNode(item, node.value, childPath(path, key));
        if (result.ok) output[key] = result.value;
        else issues.push(...result.issues);
      }
      return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
    }
    case "object": {
      const input = structuredInput(value);
      if (!plainObject(input)) return issue("typeMismatch", "Must be an object.", path);
      const output: Record<string, unknown> = {};
      const issues: TypeIssue[] = [];
      const fields = new Map(node.fields.map((field) => [field.name, field]));
      for (const field of node.fields) {
        if (!(field.name in input)) {
          if (!field.optional) issues.push({ reason: "schemaMismatch", message: "Required field is absent.", path: childPath(path, field.name) });
          continue;
        }
        const result = parseNode(input[field.name], field.type, childPath(path, field.name));
        if (result.ok) output[field.name] = result.value;
        else issues.push(...result.issues);
      }
      for (const [key, item] of Object.entries(input)) {
        if (fields.has(key)) continue;
        if (node.open) output[key] = item;
        else issues.push({ reason: "schemaMismatch", message: "Field is not declared by this closed object type.", path: childPath(path, key) });
      }
      return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
    }
  }
}

/** Parse and canonicalize a value at a typed boundary without implicit JS coercion. */
export function parseTypedValue(value: unknown, type: TypeInput, path = "$" ): TypedResult {
  return parseNode(value, normalizeType(type), path);
}

/** Serialize a value using its declared type, never JavaScript's object stringification. */
export function serializeTypedValue(value: unknown, type: TypeInput): string {
  const parsed = parseTypedValue(value, type);
  if (!parsed.ok) throw new TypeError(parsed.issues.map((item) => `${item.path}: ${item.message}`).join("; "));
  const node = normalizeType(type);
  if (node.kind === "list" || node.kind === "record" || node.kind === "object" ||
      (node.kind === "union" && typeof parsed.value === "object" && parsed.value !== null)) {
    return JSON.stringify(parsed.value);
  }
  if (node.kind === "terminal" && node.name === "token-list") return (parsed.value as string[]).join(" ");
  if (parsed.value === null) return "null";
  if (parsed.value === undefined) return "";
  return String(parsed.value);
}

/** Explicitly brand an already-approved Trusted Types-compatible value for non-browser hosts. */
export function trustedContent(
  kind: "trusted-html" | "trusted-script",
  value: unknown,
): TrustedContentValue {
  return Object.freeze({ kind, value });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
