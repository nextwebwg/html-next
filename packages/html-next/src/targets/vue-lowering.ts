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
import { isEnumeratedBoolean, type ExpressionNode } from "../expression.js";
import type { TypeNode } from "../type-system.js";
import { quote } from "./shared.js";

/** How each root name is read, and its static type, in one scope. */
export interface Scope {
  readonly code: ReadonlyMap<string, string>;
  readonly types: ReadonlyMap<string, Static>;
}

/** A value's static type and whether it may be absent. */
export interface Static {
  readonly type: TypeNode;
  readonly nullable: boolean;
}

export const UNKNOWN: Static = { type: { kind: "terminal", name: "unknown" }, nullable: true };

const terminal = (name: "string" | "number" | "boolean"): Static => ({ type: { kind: "terminal", name }, nullable: false });

export type Category = "boolean" | "string" | "number" | "scalar" | "list" | "object" | "unknown";

/** A type with its null and absent members removed, and whether any were present. */
export function present(type: TypeNode): Static {
  if (type.kind === "terminal" && (type.name === "null" || type.name === "absent")) return UNKNOWN;
  if (type.kind !== "union") return { type, nullable: false };
  const members = type.members.filter((member) => !(member.kind === "terminal" && (member.name === "null" || member.name === "absent")));
  const nullable = members.length !== type.members.length;
  if (members.length === 0) return UNKNOWN;
  return { type: members.length === 1 ? members[0]! : { kind: "union", members }, nullable };
}

export function category(type: TypeNode): Category {
  switch (type.kind) {
    case "terminal":
      if (type.name === "string") return "string";
      if (type.name === "boolean") return "boolean";
      if (type.name === "number" || type.name === "integer") return "number";
      return "unknown";
    case "keyword": return "string";
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
  }
}

const hasBoolean = (type: TypeNode): boolean =>
  type.kind === "union" ? type.members.some(hasBoolean) : category(type) === "boolean";

const isScalar = (value: Static): boolean => ["boolean", "string", "number", "scalar"].includes(category(value.type));

/** The static type of an expression. */
export function typeOf(node: ExpressionNode, scope: Scope): Static {
  switch (node.kind) {
    case "literal":
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
      let result: Static = UNKNOWN;
      if (node.kind === "member" && type.kind === "object") {
        const field = type.fields.find((candidate) => candidate.name === node.key);
        if (field !== undefined) {
          const value = present(field.type);
          result = { type: value.type, nullable: value.nullable || field.optional };
        }
      } else if (type.kind === "record") {
        result = { ...present(type.value), nullable: true };
      } else if (node.kind === "index" && type.kind === "list") {
        result = { ...present(type.item), nullable: true };
      }
      return object.nullable ? { ...result, nullable: true } : result;
    }
    case "unary":
      return node.op === "not" ? terminal("boolean") : { ...terminal("number"), nullable: true };
    case "binary":
      return ["+", "-", "*", "/", "%"].includes(node.op) ? { ...terminal("number"), nullable: true } : terminal("boolean");
    case "call":
      return node.fn === "format" ? terminal("string") : { ...terminal("number"), nullable: true };
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
        return type.name === "string" ? "string"
          : type.name === "boolean" ? "boolean"
          : type.name === "number" || type.name === "integer" ? "number"
          : "any";
      case "keyword": return JSON.stringify(type.value);
      case "union": return type.members.map(source).join(" | ");
      case "list": return type.item.kind === "union" ? `(${source(type.item)})[]` : `${source(type.item)}[]`;
      case "record": return `Record<string, ${source(type.value)}>`;
      case "object": return `{ ${type.fields.map((field) => `${/^[A-Za-z_$][\w$]*$/.test(field.name) ? field.name : quote(field.name)}: ${source(field.type)}`).join("; ")} }`;
    }
  };
  const type = source(value.type);
  return value.nullable && type !== "any" ? `${type} | null` : type;
}

/** Fallback functions for values whose type is unknown: HTML Next's value rules, written plainly. */
const FALLBACKS: Readonly<Record<string, string>> = {
  truthy: `function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
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
  format: `function format(pattern: unknown, ...values: unknown[]): string | undefined {
  let index = 0;
  return typeof pattern === "string" ? pattern.replace(/%s/g, () => index < values.length ? text(values[index++]) : "%s") : undefined;
}`,
  sortBy: `function sortBy(items: any[], keys: readonly string[]): any[] {
  const field = (item: any, path: string): unknown => path.split(".").reduce((value, key) => value?.[key], item);
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
};

const FALLBACK_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = { attribute: ["text"], format: ["text"], sortBy: ["text"] };

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
        const access = typeOf(node.object, scope).nullable ? "?." : ".";
        return /^[A-Za-z_$][\w$]*$/.test(node.key) ? `${object}${access}${node.key}` : `${object}${access === "?." ? "?." : ""}[${quote(node.key)}]`;
      }
      case "index":
        return `${this.#operand(node.object, scope)}${typeOf(node.object, scope).nullable ? "?." : ""}[${this.value(node.index, scope)}]`;
      case "unary": {
        if (node.op === "not") return this.#not(node.operand, scope);
        if (node.operand.kind === "literal" && typeof node.operand.value === "number") return `-${node.operand.value}`;
        const operand = this.#numeric(node.operand, scope);
        if (operand !== undefined) return `-${operand}`;
        const number = this.#use("number");
        return `(${number}(${this.value(node.operand, scope)}) === undefined ? undefined : -${number}(${this.value(node.operand, scope)})!)`;
      }
      case "binary":
        return this.#binary(node, scope);
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
    const type = typeOf(node, scope);
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
    if (kind === "boolean" || kind === "string" || kind === "number") return code;
    // A string-or-number union serializes as Vue writes it; one with a boolean member needs the rule.
    if (kind === "scalar" && !hasBoolean(type.type)) return code;
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

  #not(node: ExpressionNode, scope: Scope): string {
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
    if (node.op === "=") return `${left} === ${right}`;
    if (node.op === "!=") return `${left} !== ${right}`;
    if (node.op === "^=" || node.op === "$=" || node.op === "*=") {
      const method = node.op === "^=" ? "startsWith" : node.op === "$=" ? "endsWith" : "includes";
      const strings = category(typeOf(node.left, scope).type) === "string" && category(typeOf(node.right, scope).type) === "string";
      if (strings && !typeOf(node.right, scope).nullable) return `${left}${typeOf(node.left, scope).nullable ? "?." : "."}${method}(${right})`;
      return `(typeof ${left} === "string" && typeof ${right} === "string" ? ${left}.${method}(${right}) : undefined)`;
    }
    const x = this.#numeric(node.left, scope);
    const y = this.#numeric(node.right, scope);
    if (x !== undefined && y !== undefined) return `${x} ${node.op} ${y}`;
    const number = this.#use("number");
    return `(${number}(${left}) === undefined || ${number}(${right}) === undefined ? undefined : ${number}(${left})! ${node.op} ${number}(${right})!)`;
  }

  #call(node: Extract<ExpressionNode, { kind: "call" }>, scope: Scope): string {
    if (node.fn === "format") {
      const [pattern, ...args] = node.args;
      if (pattern?.kind === "literal" && typeof pattern.value === "string") {
        let index = 0;
        const parts = pattern.value.split("%s");
        return `\`${parts.map((part, position) => {
          const escaped = part.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${");
          if (position === parts.length - 1) return escaped;
          const argument = args[index++];
          return `${escaped}${argument === undefined ? "%s" : `\${${this.#interpolated(argument, scope)}}`}`;
        }).join("")}\``;
      }
      return `${this.#use("format")}(${node.args.map((argument) => this.value(argument, scope)).join(", ")})`;
    }
    const numbers = node.args.map((argument) => this.#numeric(argument, scope));
    if (numbers.every((value): value is string => value !== undefined)) {
      if (node.fn === "clamp" && numbers.length === 3) return `Math.min(Math.max(${numbers[0]}, ${numbers[1]}), ${numbers[2]})`;
      return `Math.${node.fn}(${numbers.join(", ")})`;
    }
    const number = this.#use("number");
    const args = node.args.map((argument) => `${number}(${this.value(argument, scope)})`);
    const call = node.fn === "clamp" ? `Math.min(Math.max(values[0]!, values[1]!), values[2]!)` : `Math.${node.fn}(...values)`;
    return `((values: (number | undefined)[]) => values.includes(undefined) ? undefined : ${call.replace(/values\[(\d)\]!/g, "(values as number[])[$1]!").replace("...values", "...(values as number[])")})([${args.join(", ")}])`;
  }

  /** A value inside a template literal: HTML Next text, which writes absence as "". */
  #interpolated(node: ExpressionNode, scope: Scope): string {
    const type = typeOf(node, scope);
    const text = this.text(node, scope);
    return isScalar(type) && type.nullable ? `${this.#wrap(node, text)} ?? ""` : text;
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
    return node.kind === "binary" || (node.kind === "unary" && node.op === "-") || /[?:] /.test(code) ? `(${code})` : code;
  }
}
