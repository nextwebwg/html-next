/**
 * Lowers HTML Next expressions to the JavaScript a Vue author would write.
 *
 * HTML Next's value rules (truthiness, text, attribute serialization, absent-safe access) agree with
 * JavaScript and Vue for booleans, strings, and numbers, so a value whose type is known is written
 * plainly: `disabled`, `{{ label }}`, `` `${uid}-input` ``. Where they differ (a list is true only when
 * it has items and is written space-separated; an object is true only when it has keys), the known
 * type chooses the inline form. Only a value whose type cannot be known falls back to a small named
 * function in the component, emitted when used.
 */
import { hasBuiltinCall, isEnumeratedBoolean, type ExpressionNode } from "../expression.js";
import type { TypeNode } from "../type-system.js";
import { quote } from "./shared.js";

/** How each root name is read, and its static type, in one scope. */
export interface Scope {
  readonly code: ReadonlyMap<string, string>;
  readonly types: ReadonlyMap<string, Static>;
}

/** A value's static type, whether it may be absent, and whether that absence may be `null`. */
export interface Static {
  readonly type: TypeNode;
  readonly nullable: boolean;
  readonly null?: boolean;
}

export const UNKNOWN: Static = { type: { kind: "terminal", name: "unknown" }, nullable: true, null: true };

const terminal = (name: "string" | "number" | "boolean"): Static => ({ type: { kind: "terminal", name }, nullable: false });

export type Category = "boolean" | "string" | "number" | "scalar" | "list" | "object" | "unknown";

/** A type with its null and absent members removed, and whether any were present. */
export function present(type: TypeNode): Static {
  if (type.kind === "terminal" && (type.name === "null" || type.name === "absent")) return UNKNOWN;
  if (type.kind !== "union") return { type, nullable: false };
  const members = type.members.filter((member) => !(member.kind === "terminal" && (member.name === "null" || member.name === "absent")));
  const nullable = members.length !== type.members.length;
  if (members.length === 0) return UNKNOWN;
  const hasNull = type.members.some((member) => member.kind === "terminal" && member.name === "null");
  return { type: members.length === 1 ? members[0]! : { kind: "union", members }, nullable, null: hasNull };
}

export function category(type: TypeNode): Category {
  switch (type.kind) {
    case "terminal":
      if (["string", "keyword", "url", "email", "date", "month", "week", "time", "datetime-local", "datetime", "color", "color-hex", "length", "percentage", "duration"].includes(type.name)) return "string";
      if (type.name === "boolean") return "boolean";
      if (type.name === "number" || type.name === "integer") return "number";
      return "unknown";
    case "keyword": return "string";
    case "separated-list": return "list";
    case "list": return "list";
    case "record":
    case "object": return "object";
    case "union": {
      const members = new Set(type.members.map(category));
      if (members.size === 1) return [...members][0]!;
      return [...members].every((member) => member === "string" || member === "number" || member === "boolean" || member === "scalar")
        ? "scalar"
        : "unknown";
    }
    case "selected": {
      const members = new Set(type.options.map((option) => category(option.type)));
      return members.size === 1 ? [...members][0]! : "scalar";
    }
    case "constrained": return category(type.base);
  }
}

const hasBoolean = (type: TypeNode): boolean =>
  type.kind === "union" ? type.members.some(hasBoolean) : category(type) === "boolean";

const isScalar = (value: Static): boolean => ["boolean", "string", "number", "scalar"].includes(category(value.type));

/** The static type of an expression. */
export function typeOf(node: ExpressionNode, scope: Scope): Static {
  switch (node.kind) {
    case "literal":
      if (node.dimension !== undefined) return { type: { kind: "terminal", name: node.dimension }, nullable: false };
      if (typeof node.value === "string") return terminal("string");
      if (typeof node.value === "number") return terminal("number");
      if (typeof node.value === "boolean") return terminal("boolean");
      return UNKNOWN;
    case "id":
      return scope.types.get(node.name) ?? UNKNOWN;
    case "member":
    case "index": {
      const object = typeOf(node.object, scope);
      const type = object.type;
      const key = node.kind === "member" ? node.key
        : node.index.kind === "literal" && (typeof node.index.value === "string" || typeof node.index.value === "number")
          ? String(node.index.value) : undefined;
      let result: Static = UNKNOWN;
      if (node.kind === "member" && node.key === "length" && (type.kind === "list" || category(type) === "string")) {
        result = terminal("number");
      } else if (key !== undefined && type.kind === "object") {
        const field = type.fields.find((candidate) => candidate.name === key);
        if (field !== undefined) {
          const value = present(field.type);
          result = { type: value.type, nullable: value.nullable || field.optional, null: value.null ?? false };
        }
      } else if (type.kind === "record") {
        result = { ...present(type.value), nullable: true };
      } else if (node.kind === "index" && type.kind === "list") {
        result = { ...present(type.item), nullable: true };
      }
      return object.nullable ? { ...result, nullable: true } : result;
    }
    case "unary": {
      if (node.op === "not") return terminal("boolean");
      const operand = typeOf(node.operand, scope);
      if (operand.type.kind === "terminal" && ["length", "percentage", "duration"].includes(operand.type.name)) {
        return { ...operand, nullable: true };
      }
      return { ...terminal("number"), nullable: true };
    }
    case "binary":
      return ["+", "-", "*", "/", "%"].includes(node.op) ? { ...terminal("number"), nullable: true } : terminal("boolean");
    case "conditional": {
      const consequent = typeOf(node.consequent, scope);
      const alternate = typeOf(node.alternate, scope);
      if (node.consequent.kind === "literal" && node.consequent.value === null) {
        return { ...alternate, nullable: true, null: true };
      }
      if (node.alternate.kind === "literal" && node.alternate.value === null) {
        return { ...consequent, nullable: true, null: true };
      }
      return {
        type: JSON.stringify(consequent.type) === JSON.stringify(alternate.type)
          ? consequent.type
          : { kind: "union", members: [consequent.type, alternate.type] },
        nullable: consequent.nullable || alternate.nullable,
        null: consequent.null === true || alternate.null === true,
      };
    }
    case "call": {
      if (node.fn === "concat" || node.fn === "join") return { ...terminal("string"), nullable: true };
      if (node.fn === "default") {
        if (node.args[0] === undefined) return UNKNOWN;
        const selected = node.args[0].kind === "literal" && node.args[0].value === null ? node.args[1] : node.args[0];
        return selected === undefined ? UNKNOWN : { ...typeOf(selected, scope), nullable: true };
      }
      const argument = node.args[node.fn === "clamp" ? 1 : 0];
      if (argument !== undefined) {
        const type = typeOf(argument, scope).type;
        if (type.kind === "terminal" && (type.name === "length" || type.name === "percentage" || type.name === "duration")) {
          return { type, nullable: true };
        }
      }
      return { ...terminal("number"), nullable: true };
    }
    case "object":
      return {
        type: {
          kind: "object",
          open: false,
          fields: node.pairs.map((pair) => {
            const value = typeOf(pair.value, scope);
            return { name: pair.key, type: value.type, optional: value.nullable };
          }),
        },
        nullable: false,
      };
    case "array": {
      const items = node.items.map((item) => typeOf(item, scope));
      const first = items[0];
      const same = first !== undefined && items.every((item) => category(item.type) === category(first.type));
      return { type: { kind: "list", item: same && first !== undefined ? first.type : UNKNOWN.type }, nullable: false };
    }
  }
}

/** A TypeScript type for a value, with unknown parts as `any` so a template reads them freely. */
export function typeScript(value: Static): string {
  const source = (type: TypeNode): string => {
    switch (type.kind) {
      case "terminal":
        return ["string", "keyword", "url", "email", "date", "month", "week", "time", "datetime-local", "datetime", "color", "color-hex", "length", "percentage", "duration"].includes(type.name) ? "string"
          : type.name === "boolean" ? "boolean"
          : type.name === "number" || type.name === "integer" ? "number"
          : type.name === "null" ? "null"
          : type.name === "absent" ? "undefined"
          : "any";
      case "keyword": return JSON.stringify(type.value);
      case "separated-list": return "string[]";
      case "union": return type.members.map(source).join(" | ");
      case "selected": return [...new Set(type.options.map((option) => source(option.type)))].join(" | ");
      case "constrained": return type.values === undefined ? source(type.base)
        : type.values.map((value) => JSON.stringify(value)).join(" | ");
      case "list": return type.item.kind === "union" ? `(${source(type.item)})[]` : `${source(type.item)}[]`;
      case "record": return `Record<string, ${source(type.value)}>`;
      case "object": {
        const fields = type.fields.map((field) =>
          `${/^[A-Za-z_$][\w$]*$/.test(field.name) ? field.name : quote(field.name)}${field.optional ? "?" : ""}: ${source(field.type)}`);
        if (type.open) fields.push("[name: string]: any");
        return `{ ${fields.join("; ")} }`;
      }
    }
  };
  const type = source(value.type);
  return value.nullable && type !== "any" ? `${type} | null` : type;
}

/** Fallback functions for values whose type is unknown: HTML Next's value rules, written plainly. */
const FALLBACKS: Readonly<Record<string, string>> = {
  truthy: `function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Error) return true;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}`,
  text: `function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  return value === null || value === undefined || typeof value === "object" ? "" : String(value);
}`,
  attribute: `function attribute(value: unknown): any {
  if (value === null || value === undefined || value === false || (typeof value === "object" && !Array.isArray(value))) return undefined;
  return value === true ? "" : text(value);
}`,
  list: `function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}`,
  number: `function number(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}`,
  concat: `function concat(...values: unknown[]): string | symbol | undefined {
  if (values.some(value => value === Symbol.for("html-next.invalid-result"))) return Symbol.for("html-next.invalid-result");
  if (values.some(value => value === undefined)) return undefined;
  if (values.length === 0 || values.some(value => typeof value === "object" && value !== null)) return Symbol.for("html-next.invalid-result");
  return values.map(value => value === null ? "" : String(value)).join("");
}`,
  join: `function join(...values: unknown[]): string | symbol | undefined {
  if (values.some(value => value === Symbol.for("html-next.invalid-result"))) return Symbol.for("html-next.invalid-result");
  if (values.some(value => value === undefined)) return undefined;
  if (values.length !== 2) return Symbol.for("html-next.invalid-result");
  const [items, separator] = values;
  if (!Array.isArray(items) || typeof separator !== "string") return Symbol.for("html-next.invalid-result");
  if (items.some(value => value === Symbol.for("html-next.invalid-result"))) return Symbol.for("html-next.invalid-result");
  if (items.some(value => value === undefined)) return undefined;
  if (items.some(value => typeof value === "object" && value !== null)) return Symbol.for("html-next.invalid-result");
  if (new Set(items.filter(value => value !== null).map(value => typeof value)).size > 1) return Symbol.for("html-next.invalid-result");
  return items.map(value => value === null ? "" : String(value)).join(separator);
}`,
  math: `function math(fn: string, kinds: readonly string[], values: readonly unknown[]): number | string | symbol | undefined {
  if (values.includes(Symbol.for("html-next.invalid-result"))) return Symbol.for("html-next.invalid-result");
  if (values.some(value => value === undefined || value === null)) return undefined;
  if ((fn === "abs" || fn === "negate") && values.length !== 1 || fn === "round" && (values.length < 1 || values.length > 2) ||
      (fn === "min" || fn === "max") && values.length === 0 || fn === "clamp" && values.length !== 3) return Symbol.for("html-next.invalid-result");
  const kind = kinds[0];
  const dimensional = kind === "length" || kind === "percentage" || kind === "duration";
  if (!dimensional && kind !== "number") return Symbol.for("html-next.invalid-result");
  let unit: string | undefined;
  const numbers: number[] = [];
  for (let index = 0; index < values.length; index++) {
    if (kinds[index] !== kind) return Symbol.for("html-next.invalid-result");
    const value = values[index];
    if (!dimensional) {
      if (typeof value !== "number" || !Number.isFinite(value)) return Symbol.for("html-next.invalid-result");
      numbers.push(value);
      continue;
    }
    if (typeof value !== "string") return Symbol.for("html-next.invalid-result");
    const match = /^(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%)$/.exec(value);
    if (match === null || unit !== undefined && match[2] !== unit) return Symbol.for("html-next.invalid-result");
    unit = match[2];
    if ((unit === "%" ? "percentage" : unit === "ms" || unit === "s" ? "duration" : "length") !== kind) return Symbol.for("html-next.invalid-result");
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return Symbol.for("html-next.invalid-result");
    numbers.push(number);
  }
  let result: number;
  switch (fn) {
    case "abs": result = Math.abs(numbers[0]!); break;
    case "negate": result = -numbers[0]!; break;
    case "round": {
      const step = Math.abs(numbers[1] ?? 1);
      if (step === 0) return Symbol.for("html-next.invalid-result");
      result = Math.round(numbers[0]! / step) * step;
      break;
    }
    case "min": result = Math.min(...numbers); break;
    case "max": result = Math.max(...numbers); break;
    case "clamp": result = Math.max(numbers[0]!, Math.min(numbers[1]!, numbers[2]!)); break;
    default: return Symbol.for("html-next.invalid-result");
  }
  return !Number.isFinite(result) ? Symbol.for("html-next.invalid-result") : unit === undefined ? result : String(result) + unit;
}`,
  sortBy: `function sortBy(items: any[], keys: readonly string[]): any[] {
  const field = (item: any, path: string): unknown => item !== null && typeof item === "object" && !Array.isArray(item)
    ? path.split(".").reduce((value, key) => value?.[key], item)
    : item;
  return items.slice().sort((a, b) => {
    for (const key of keys) {
      const descending = key.startsWith("-");
      const path = descending ? key.slice(1) : key;
      const x = field(a, path), y = field(b, path);
      const order = typeof x === "number" && typeof y === "number" ? x - y : text(x).localeCompare(text(y));
      if (order !== 0) return descending ? -order : order;
    }
    return 0;
  });
}`,
  eachRows: `function eachRows<T>(items: readonly T[]): { item: T; index: number; loop: { index: number; first: boolean; last: boolean; count: number } }[] {
  return items.map((item, index) => ({ item, index, loop: { index, first: index === 0, last: index === items.length - 1, count: items.length } }));
}`,
  uniqueKeys: `function uniqueKeys<T>(items: readonly T[], keyOf: (item: T, index: number, loop: { index: number; first: boolean; last: boolean; count: number }) => unknown): readonly T[] {
  const seen = new Set<unknown>();
  for (let index = 0; index < items.length; index += 1) {
    const key = keyOf(items[index]!, index, { index, first: index === 0, last: index === items.length - 1, count: items.length });
    if (seen.has(key)) {
      const message = \`A keyed list produced duplicate key \\\`\${text(key)}\\\`.\`;
      throw Object.assign(new Error(\`HR004: \${message}\`), {
        name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR004", message }),
      });
    }
    seen.add(key);
  }
  return items;
}`,
};

const FALLBACK_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = { attribute: ["text"], sortBy: ["text"], uniqueKeys: ["text"] };

/** Vue's boolean attributes: it removes them for false and writes them empty for true. */
const BOOLEAN_ATTRIBUTES = new Set(("allowfullscreen,async,autofocus,autoplay,checked,controls,default,defer,disabled,"
  + "formnovalidate,hidden,inert,ismap,itemscope,loop,multiple,muted,nomodule,novalidate,open,playsinline,readonly,"
  + "required,reversed,selected").split(","));

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/;

/** Emits expressions for one component, recording which fallback functions it needs. */
export class Lowering {
  readonly #used = new Set<string>();

  #use(name: string): string {
    this.#used.add(name);
    for (const dependency of FALLBACK_DEPENDENCIES[name] ?? []) this.#used.add(dependency);
    return name;
  }

  /** The fallback functions the emitted code calls. */
  fallbacks(): string[] {
    return Object.keys(FALLBACKS).filter((name) => this.#used.has(name)).map((name) => FALLBACKS[name]!);
  }

  /** The expression's value. */
  value(node: ExpressionNode, scope: Scope): string {
    switch (node.kind) {
      case "literal":
        return node.value === undefined ? "undefined" : JSON.stringify(node.value);
      case "id":
        return scope.code.get(node.name) ?? "undefined";
      case "member": {
        const object = this.#operand(node.object, scope);
        const objectType = typeOf(node.object, scope);
        const access = objectType.nullable ? "?." : ".";
        // A closed shape still permits an absent read; the result is undefined at runtime.
        if (objectType.type.kind === "object" && !objectType.type.fields.some((field) => field.name === node.key)) {
          return `(${object} as Record<string, any>${objectType.nullable ? " | null | undefined" : ""})${objectType.nullable ? "?." : ""}[${quote(node.key)}]`;
        }
        return /^[A-Za-z_$][\w$]*$/.test(node.key) ? `${object}${access}${node.key}` : `${object}${access === "?." ? "?." : ""}[${quote(node.key)}]`;
      }
      case "index": {
        const object = this.#operand(node.object, scope);
        const index = this.value(node.index, scope);
        // A computed key may not be one of an object literal's declared names. JavaScript then
        // reads an absent property, while TypeScript rejects the indexing expression.
        if (typeOf(node.object, scope).type.kind === "object") {
          return `(${object} as Record<string, any>${typeOf(node.object, scope).nullable ? " | null | undefined" : ""})${typeOf(node.object, scope).nullable ? "?." : ""}[${index}]`;
        }
        return `${object}${typeOf(node.object, scope).nullable ? "?." : ""}[${index}]`;
      }
      case "unary": {
        if (node.op === "not") return this.#not(node.operand, scope);
        if (node.operand.kind === "literal" && typeof node.operand.value === "number") return `-${node.operand.value}`;
        const type = typeOf(node.operand, scope).type;
        if (type.kind === "terminal" && ["length", "percentage", "duration"].includes(type.name)) {
          return `(${this.#use("math")}("negate", [${quote(type.name)}], [${this.value(node.operand, scope)}]) as string | undefined)`;
        }
        const operand = this.#numeric(node.operand, scope);
        if (operand !== undefined) return `-${operand}`;
        const number = this.#use("number");
        return `(${number}(${this.value(node.operand, scope)}) === undefined ? undefined : -${number}(${this.value(node.operand, scope)})!)`;
      }
      case "binary":
        return this.#binary(node, scope);
      case "conditional":
        if (hasBuiltinCall(node.test)) {
          const test = this.condition(node.test, scope);
          return `(() => { const condition: any = ${test}; if (condition === Symbol.for("html-next.invalid-result")) return condition; return condition ? ${this.value(node.consequent, scope)} : ${this.value(node.alternate, scope)}; })()`;
        }
        return `${this.condition(node.test, scope)} ? ${this.value(node.consequent, scope)} : ${this.value(node.alternate, scope)}`;
      case "call":
        return this.#call(node, scope);
      case "object":
        return `{ ${node.pairs.map((pair) => `${/^[A-Za-z_$][\w$]*$/.test(pair.key) ? pair.key : quote(pair.key)}: ${this.value(pair.value, scope)}`).join(", ")} }`;
      case "array":
        return `[${node.items.map((item) => this.value(item, scope)).join(", ")}]`;
    }
  }

  /** The expression as a condition, where JavaScript truthiness is enough. */
  condition(node: ExpressionNode, scope: Scope): string {
    if (node.kind === "binary" && (node.op === "and" || node.op === "or")) {
      if (hasBuiltinCall(node.left) || hasBuiltinCall(node.right)) {
        const left = this.condition(node.left, scope);
        const right = this.condition(node.right, scope);
        const shortCircuit = node.op === "and" ? "!left" : "left";
        const shortValue = node.op === "and" ? "false" : "true";
        return `(() => { const left: any = ${left}; if (left === Symbol.for("html-next.invalid-result")) return left; if (${shortCircuit}) return ${shortValue}; const right: any = ${right}; return right; })()`;
      }
      const join = node.op === "and" ? "&&" : "||";
      const side = (side: ExpressionNode): string => {
        const code = this.condition(side, scope);
        // `a || b && c` reads ambiguously; parenthesize a nested operator of the other kind.
        return side.kind === "binary" && (side.op === "and" || side.op === "or") && side.op !== node.op ? `(${code})` : code;
      };
      return `${side(node.left)} ${join} ${side(node.right)}`;
    }
    if (node.kind === "unary" && node.op === "not") return this.#not(node.operand, scope);
    const code = this.value(node, scope);
    if (node.kind === "literal" && (typeof node.value === "string" || typeof node.value === "number")) return `Boolean(${code})`;
    const type = typeOf(node, scope);
    // A closed object with a required field always has keys, so only its absence makes it false.
    const filled = type.type.kind === "object" && type.type.fields.some((field) => !field.optional);
    if (filled) return code;
    switch (category(type.type)) {
      case "boolean": case "string": case "number": case "scalar": return code;
      case "list": return type.nullable ? `${this.#wrap(node, code)}?.length` : `${this.#wrap(node, code)}.length`;
      default: return `${this.#use("truthy")}(${code})`;
    }
  }

  /** The expression as displayed text. */
  text(node: ExpressionNode, scope: Scope): string {
    const code = this.value(node, scope);
    const type = typeOf(node, scope);
    const item = type.type.kind === "list" ? present(type.type.item) : undefined;
    if (isScalar(type)) return code;
    if (item !== undefined && isScalar(item)) return `${this.#wrap(node, code)}${type.nullable ? "?." : "."}join(" ")`;
    return `${this.#use("text")}(${code})`;
  }

  /** The expression bound to an attribute of a native element. */
  attribute(node: ExpressionNode, scope: Scope, name: string): string {
    const code = this.value(node, scope);
    const type = typeOf(node, scope);
    const kind = category(type.type);
    if (kind === "boolean" && !BOOLEAN_ATTRIBUTES.has(name) && !isEnumeratedBoolean(name)) {
      return `${this.#wrap(node, this.condition(node, scope))} ? "" : undefined`;
    }
    // Vue removes an attribute bound to null, but its attribute types accept only undefined.
    const plain = type.null === true ? `${this.#wrap(node, code)} ?? undefined` : code;
    if (kind === "boolean" || kind === "string" || kind === "number") return plain;
    // A string-or-number union serializes as Vue writes it; one with a boolean member needs the rule.
    if (kind === "scalar" && !hasBoolean(type.type)) return plain;
    const item = type.type.kind === "list" ? present(type.type.item) : undefined;
    if (item !== undefined && isScalar(item)) return `${this.#wrap(node, code)}${type.nullable ? "?." : "."}join(" ")`;
    if (isEnumeratedBoolean(name)) return `typeof (${code}) === "boolean" ? String(${code}) : ${this.#use("attribute")}(${code})`;
    return `${this.#use("attribute")}(${code})`;
  }

  /** The list a `$each` iterates, filtered, sorted, and limited as declared. */
  list(
    node: ExpressionNode,
    scope: Scope,
    item: string,
    options: { where?: ExpressionNode; itemScope: Scope; sort: readonly string[]; limit?: ExpressionNode },
  ): string {
    const type = typeOf(node, scope);
    // Vue iterates null and undefined as nothing; anything but a list must also iterate as nothing.
    let code = type.type.kind === "list" ? this.value(node, scope) : `${this.#use("list")}(${this.value(node, scope)})`;
    if (options.where === undefined && options.sort.length === 0 && options.limit === undefined) return code;
    if (type.type.kind === "list" && type.nullable) code = `(${code} ?? [])`;
    if (options.where !== undefined) code = `${code}.filter((${item}) => ${this.condition(options.where, options.itemScope)})`;
    if (options.sort.length > 0) code = `${this.#use("sortBy")}(${code}, ${JSON.stringify(options.sort)})`;
    if (options.limit !== undefined) code = `${code}.slice(0, ${this.value(options.limit, scope)})`;
    return code;
  }

  /** Bind an already-shaped list and its loop metadata once for Vue's iteration. */
  eachRows(code: string): string {
    return `${this.#use("eachRows")}(${code})`;
  }

  uniqueKeys(items: string, keyOf: string): string {
    return `${this.#use("uniqueKeys")}(${items}, ${keyOf})`;
  }

  #not(node: ExpressionNode, scope: Scope): string {
    if (hasBuiltinCall(node)) {
      const value = this.condition(node, scope);
      return `(() => { const operand: any = ${value}; return operand === Symbol.for("html-next.invalid-result") ? operand : !operand; })()`;
    }
    if (node.kind === "binary" && node.op === "=") return `${this.#operand(node.left, scope)} !== ${this.#operand(node.right, scope)}`;
    if (node.kind === "binary" && node.op === "!=") return `${this.#operand(node.left, scope)} === ${this.#operand(node.right, scope)}`;
    const code = this.condition(node, scope);
    return IDENTIFIER_PATH.test(code) || /^[\w$]+\(.*\)$/.test(code) ? `!${code}` : `!(${code})`;
  }

  #binary(node: Extract<ExpressionNode, { kind: "binary" }>, scope: Scope): string {
    if (node.op === "and" || node.op === "or") {
      const code = this.condition(node, scope);
      const both = category(typeOf(node.left, scope).type) === "boolean" && category(typeOf(node.right, scope).type) === "boolean";
      return both ? code : `Boolean(${code})`;
    }
    const left = this.#operand(node.left, scope);
    const right = this.#operand(node.right, scope);
    if (hasBuiltinCall(node.left) || hasBuiltinCall(node.right)) {
      const body = this.#binaryOperands(node, scope, "left", "right");
      return `(() => { const left: any = ${left}; if (left === Symbol.for("html-next.invalid-result")) return left; const right: any = ${right}; if (right === Symbol.for("html-next.invalid-result")) return right; return ${body}; })()`;
    }
    return this.#binaryOperands(node, scope, left, right);
  }

  #binaryOperands(node: Extract<ExpressionNode, { kind: "binary" }>, scope: Scope, left: string, right: string): string {
    const { op } = node;
    if (op === "=" || op === "!=") {
      const leftCategory = category(typeOf(node.left, scope).type);
      const rightCategory = category(typeOf(node.right, scope).type);
      const compared = leftCategory !== rightCategory && leftCategory !== "unknown" && rightCategory !== "unknown"
        ? `(${left} as unknown)` : left;
      return `${compared} ${op === "=" ? "===" : "!=="} ${right}`;
    }
    if (op === "^=" || op === "$=" || op === "*=") {
      const method = op === "^=" ? "startsWith" : op === "$=" ? "endsWith" : "includes";
      const strings = category(typeOf(node.left, scope).type) === "string" && category(typeOf(node.right, scope).type) === "string";
      if (strings && !typeOf(node.right, scope).nullable) return `${left}${typeOf(node.left, scope).nullable ? "?." : "."}${method}(${right})`;
      return `(typeof ${left} === "string" && typeof ${right} === "string" ? ${left}.${method}(${right}) : undefined)`;
    }
    const x = this.#numeric(node.left, scope);
    const y = this.#numeric(node.right, scope);
    if (x !== undefined && y !== undefined) return `${left} ${op} ${right}`;
    const number = this.#use("number");
    return `(${number}(${left}) === undefined || ${number}(${right}) === undefined ? undefined : ${number}(${left})! ${op} ${number}(${right})!)`;
  }

  #call(node: Extract<ExpressionNode, { kind: "call" }>, scope: Scope): string {
    const values = node.args.map((argument) => this.value(argument, scope)).join(", ");
    if (node.fn === "default") {
      return node.args.length === 2 ? `(${this.value(node.args[0]!, scope)} ?? ${this.value(node.args[1]!, scope)})` : "undefined";
    }
    if (node.fn === "concat" || node.fn === "join") {
      return `${this.#use(node.fn)}(${values})`;
    }
    const kinds = node.args.map((argument) => {
      const type = typeOf(argument, scope).type;
      if (type.kind !== "terminal") return "invalid";
      return type.name === "integer" ? "number" : type.name;
    });
    if (kinds.length > 0 && kinds.every((kind) => kind === "number") &&
      node.args.every((argument) => !typeOf(argument, scope).nullable)) {
      const args = node.args.map((argument) => this.value(argument, scope));
      if (node.fn === "abs" && args.length === 1) return `Math.abs(${args[0]})`;
      if (node.fn === "round" && args.length === 1) return `Math.round(${args[0]})`;
      if (node.fn === "min" && args.length > 0) return `Math.min(${args.join(", ")})`;
      if (node.fn === "max" && args.length > 0) return `Math.max(${args.join(", ")})`;
      if (node.fn === "clamp" && args.length === 3) return `Math.max(${args[0]}, Math.min(${args[1]}, ${args[2]}))`;
    }
    const resultType = typeOf(node, scope).type;
    const result = resultType.kind === "terminal" && ["length", "percentage", "duration"].includes(resultType.name) ? "string" : "number";
    return `(${this.#use("math")}(${quote(node.fn)}, [${kinds.map(quote).join(", ")}], [${values}]) as ${result} | symbol | undefined)`;
  }

  /** A known, present number, or undefined when HTML Next's arithmetic would yield absence. */
  #numeric(node: ExpressionNode, scope: Scope): string | undefined {
    const type = typeOf(node, scope);
    if (category(type.type) !== "number" || type.nullable) return undefined;
    return this.#operand(node, scope);
  }

  #operand(node: ExpressionNode, scope: Scope): string {
    return this.#wrap(node, this.value(node, scope));
  }

  #wrap(node: ExpressionNode, code: string): string {
    return node.kind === "binary" || node.kind === "conditional" || (node.kind === "unary" && node.op === "-") || /[?:] /.test(code) ? `(${code})` : code;
  }
}
