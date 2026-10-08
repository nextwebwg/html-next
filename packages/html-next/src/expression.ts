import { isNativeEvent } from "./freeze.js";
import { parseExpression } from "./expression-parser.js";
import { formatValue, formattingType } from "./format.js";
import type { TypeNode } from "./type-system.js";

/** A missing read or an operation on missing/typed-invalid data. */
export const ABSENT = Symbol("absent");
/**
 * The result of evaluating a reference whose value breaks its declared type. Absence means "no
 * value here"; this means "a value that the declaration forbids", which must not reach the DOM or
 * recompute anything. Consumers keep whatever they last had instead.
 */
export const NONCONFORMING = Symbol("nonconforming");
export type Absent = typeof ABSENT;

export type Value =
  | string
  | number
  | boolean
  | null
  | Absent
  | Event
  | typeof NONCONFORMING
  | readonly Value[]
  | { readonly [key: string]: Value };

/** Expressions only look names up, so any `Map` or reactive scope layer can supply them. */
export interface Scope {
  get(name: string): Value | undefined;
  /**
   * A reactive scope evaluates on plain objects: `read` and `readKey` track what they read, and
   * `reveal` turns an object leaving the engine into the proxy that JavaScript reads and writes.
   */
  read?(name: string): Value | undefined;
  readKey?(object: object, key: string | number): Value | undefined;
  reveal?(value: Value): Value;
  typeOfDeclaredPath?: ((path: string) => TypeNode | undefined) | undefined;
  /** Declared type of a reference, when the host has one. */
  typeOfPath?: ((path: string) => "length" | "percentage" | "duration" | undefined) | undefined;
}

export class UndeclaredName extends Error {
  constructor(readonly identifier: string) {
    super(`\`${identifier}\` is not declared in scope.`);
    this.name = "UndeclaredName";
  }
}

export type ExpressionNode =
  | { kind: "literal"; value: Value; dimension?: "length" | "percentage" | "duration"; keyword?: true }
  | { kind: "id"; name: string }
  | { kind: "member"; object: ExpressionNode; key: string }
  | { kind: "index"; object: ExpressionNode; index: ExpressionNode }
  | { kind: "unary"; op: "not" | "-"; operand: ExpressionNode }
  | { kind: "binary"; op: string; left: ExpressionNode; right: ExpressionNode }
  | { kind: "conditional"; test: ExpressionNode; consequent: ExpressionNode; alternate: ExpressionNode }
  | { kind: "call"; fn: string; args: ExpressionNode[] }
  | { kind: "object"; pairs: { key: string; value: ExpressionNode }[] }
  | { kind: "array"; items: ExpressionNode[] };

export interface CompiledExpression {
  readonly source: string;
  readonly ast: ExpressionNode;
  readonly dependencies: readonly string[];
}

export type WritablePathSegment =
  | string
  | number
  | { readonly kind: "index"; readonly expression: ExpressionNode };
export type WritablePath = readonly WritablePathSegment[];


function isAbsent(value: Value): boolean {
  return value === ABSENT || value === NONCONFORMING || value === null;
}

/** Truthiness follows the empty value of each type. */
export function truthy(value: Value): boolean {
  if (value === ABSENT || value === NONCONFORMING || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0 && value === value;
  if (Array.isArray(value)) return value.length > 0;
  for (const key in value) if (Object.hasOwn(value, key)) return true;
  // Only empty objects need a platform brand check. Ordinary records (including records with
  // a `type` field) stay on the inexpensive enumerable-property path.
  return value instanceof Error || isNativeEvent(value);
}

function asNumber(value: Value): number | Absent {
  return typeof value === "number" && Number.isFinite(value) ? value : ABSENT;
}

/** A tracked property read; a missing property is absent, while `null` stays a value. */
function readKey(scope: Scope, object: object, key: string | number): Value {
  const value = scope.readKey === undefined
    ? (object as { readonly [key: string]: Value | undefined })[key]
    : scope.readKey(object, key);
  return value === undefined ? ABSENT : value;
}

/** Truthiness inside the engine, where a list is plain and its length must be read tracked. */
function truthyIn(value: Value, scope: Scope): boolean {
  return Array.isArray(value) ? (readKey(scope, value, "length") as number) > 0 : truthy(value);
}

/** Hand an object leaving the engine back as the value JavaScript reads. */
function reveal(value: Value, scope: Scope): Value {
  return scope.reveal === undefined || value === null || typeof value !== "object" ? value : scope.reveal(value);
}

function evalNode(node: ExpressionNode, scope: Scope): Value {
  switch (node.kind) {
    case "literal": return node.value;
    case "id": {
      const value = scope.read === undefined ? scope.get(node.name) : scope.read(node.name);
      if (value === undefined) throw new UndeclaredName(node.name);
      return value;
    }
    case "member": {
      const object = evalNode(node.object, scope);
      if (object === NONCONFORMING) return NONCONFORMING;
      // A list's or string's `length` is its count, as `cart.items.length` reads in the proposal.
      if (node.key === "length" && typeof object === "string") return object.length;
      if (node.key === "length" && Array.isArray(object)) return readKey(scope, object, "length");
      if (isAbsent(object) || typeof object !== "object" || Array.isArray(object)) {
        return ABSENT;
      }
      return readKey(scope, object as object, node.key);
    }
    case "index": {
      const object = evalNode(node.object, scope);
      const index = evalNode(node.index, scope);
      if (object === NONCONFORMING || index === NONCONFORMING) return NONCONFORMING;
      if (isAbsent(object) || isAbsent(index)) return ABSENT;
      if (Array.isArray(object) && typeof index === "number") return readKey(scope, object, index);
      if (typeof object === "object" && (typeof index === "string" || typeof index === "number")) {
        return readKey(scope, object as object, String(index));
      }
      return ABSENT;
    }
    case "unary": {
      const operand = evalNode(node.operand, scope);
      if (operand === NONCONFORMING) return NONCONFORMING;
      if (node.op === "not") return !truthyIn(operand, scope);
      return negate(operand, dimensionType(node.operand, scope));
    }
    case "binary": return evalBinary(node, scope);
    case "conditional": {
      const test = evalNode(node.test, scope);
      return test === NONCONFORMING ? NONCONFORMING : evalNode(truthyIn(test, scope) ? node.consequent : node.alternate, scope);
    }
    case "call": return evalCall(node, scope);
    case "object": {
      const value: Record<string, Value> = {};
      for (const pair of node.pairs) {
        const item = evalNode(pair.value, scope);
        if (item === NONCONFORMING) return NONCONFORMING;
        value[pair.key] = item;
      }
      return value;
    }
    case "array": {
      const value: Value[] = [];
      for (const item of node.items) {
        const result = evalNode(item, scope);
        if (result === NONCONFORMING) return NONCONFORMING;
        value.push(result);
      }
      return value;
    }
  }
}

function evalBinary(node: Extract<ExpressionNode, { kind: "binary" }>, scope: Scope): Value {
  const { op } = node;
  if (op === "and" || op === "or") {
    const left = evalNode(node.left, scope);
    if (left === NONCONFORMING) return NONCONFORMING;
    if (op === "and" && !truthyIn(left, scope)) return false;
    if (op === "or" && truthyIn(left, scope)) return true;
    const right = evalNode(node.right, scope);
    return right === NONCONFORMING ? NONCONFORMING : truthyIn(right, scope);
  }
  const left = evalNode(node.left, scope);
  const right = evalNode(node.right, scope);
  // Dimensions are looked up only where `binaryValue` reads them: arithmetic on a non-number.
  const dimensional = (op === "+" || op === "-" || op === "*" || op === "/") &&
    (typeof left !== "number" || typeof right !== "number");
  return binaryValue(op, left, right,
    dimensional ? dimensionType(node.left, scope) : undefined, dimensional ? dimensionType(node.right, scope) : undefined);
}

type Dimension = "length" | "percentage" | "duration";

/** Unary minus over an evaluated operand; `dimension` is the operand's declared dimension, if any. */
export function negate(operand: Value, dimension: Dimension | undefined): Value {
  if (operand === NONCONFORMING) return NONCONFORMING;
  if (dimension !== undefined && typeof operand === "string") {
    const quantity = parseQuantity(operand);
    return quantity === undefined ? ABSENT : `${-quantity.value}${quantity.unit}`;
  }
  const number = asNumber(operand);
  return number === ABSENT ? ABSENT : -number;
}

/**
 * A binary operator other than `and`/`or` over evaluated operands. The dimensions are the operands'
 * declared dimension types; they matter only for arithmetic on an operand that is not a number.
 */
export function binaryValue(op: string, left: Value, right: Value, leftDimension?: Dimension, rightDimension?: Dimension): Value {
  if (left === NONCONFORMING || right === NONCONFORMING) return NONCONFORMING;
  if (op === "=") return left === right;
  if (op === "!=") return left !== right;
  if (op === "^=" || op === "$=" || op === "*=") {
    if (typeof left !== "string" || typeof right !== "string") return ABSENT;
    if (op === "^=") return left.startsWith(right);
    if (op === "$=") return left.endsWith(right);
    return left.includes(right);
  }

  if ((op === "+" || op === "-" || op === "*" || op === "/") &&
    (typeof left !== "number" || typeof right !== "number")) {
    if (leftDimension !== undefined || rightDimension !== undefined) {
      if (isAbsent(left) || isAbsent(right)) return ABSENT;
      const leftQuantity = leftDimension !== undefined && typeof left === "string" ? parseQuantity(left) : undefined;
      const rightQuantity = rightDimension !== undefined && typeof right === "string" ? parseQuantity(right) : undefined;
      if (leftDimension !== undefined && leftQuantity?.dimension !== leftDimension ||
        rightDimension !== undefined && rightQuantity?.dimension !== rightDimension) return NONCONFORMING;
      let result: number;
      let unit: string;
      if (op === "+" || op === "-") {
        if (leftQuantity === undefined || rightQuantity === undefined ||
          leftQuantity.dimension !== rightQuantity.dimension || leftQuantity.unit !== rightQuantity.unit) return NONCONFORMING;
        result = op === "+" ? leftQuantity.value + rightQuantity.value : leftQuantity.value - rightQuantity.value;
        unit = leftQuantity.unit;
      } else if (op === "*") {
        const quantity = leftQuantity ?? rightQuantity;
        const factor = leftQuantity === undefined ? asNumber(left) : asNumber(right);
        if (quantity === undefined || leftQuantity !== undefined && rightQuantity !== undefined || factor === ABSENT) return NONCONFORMING;
        result = quantity.value * factor;
        unit = quantity.unit;
      } else {
        const divisor = asNumber(right);
        if (leftQuantity === undefined || rightDimension !== undefined || divisor === ABSENT || divisor === 0) return NONCONFORMING;
        result = leftQuantity.value / divisor;
        unit = leftQuantity.unit;
      }
      return Number.isFinite(result) ? `${result}${unit}` : NONCONFORMING;
    }
  }

  const a = asNumber(left);
  const b = asNumber(right);
  if (a === ABSENT || b === ABSENT) return ABSENT;
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return a / b;
    case "%": return a % b;
    default: return ABSENT;
  }
}

function evalCall(node: Extract<ExpressionNode, { kind: "call" }>, scope: Scope): Value {
  const { args, fn } = node;
  if (fn === "format" || fn === "formatRange" || fn === "formatParts") {
    const values = args.map((argument) => reveal(evalNode(argument, scope), scope));
    return formatCall(fn, values, args.length === 0 ? undefined : expressionFormattingType(args[0]!, scope));
  }
  if (fn === "default") {
    if (args.length !== 2) return NONCONFORMING;
    const value = evalNode(args[0]!, scope);
    if (value === NONCONFORMING) return NONCONFORMING;
    return value === ABSENT || value === null ? evalNode(args[1]!, scope) : value;
  }
  if (fn === "concat" || fn === "join") {
    const values: Value[] = [];
    for (const argument of args) values.push(reveal(evalNode(argument, scope), scope));
    return textCall(fn, values);
  }
  if (!mathArity(fn, args.length)) return NONCONFORMING;
  const dimension = dimensionType(args[0]!, scope);
  return mathCall(fn, args.map((argument) => evalNode(argument, scope)), dimension,
    dimension === undefined ? [] : args.map((argument) => dimensionType(argument, scope)));
}

/** `format`, `formatRange` and `formatParts` over evaluated arguments and the first one's formatting type. */
export function formatCall(fn: string, values: readonly Value[], type: string | undefined): Value {
  if (values.includes(NONCONFORMING)) return NONCONFORMING;
  if (values.includes(ABSENT)) return ABSENT;
  if (values.length < (fn === "formatRange" ? 2 : 1)) return NONCONFORMING;
  const result = formatValue(values[0], type, fn, ...values.slice(1));
  return result === Symbol.for("html-next.invalid-result") ? NONCONFORMING : result === undefined ? ABSENT : result;
}

/** `concat` and `join` over evaluated arguments. */
export function textCall(fn: string, values: readonly Value[]): Value {
  if (values.includes(NONCONFORMING)) return NONCONFORMING;
  if (fn === "concat") {
    if (values.some((value) => value === ABSENT)) return ABSENT;
    if (values.length === 0 || values.some((value) => typeof value === "object" && value !== null)) return NONCONFORMING;
    return values.map((value) => value === null ? "" : String(value)).join("");
  }
  if (values.some((value) => value === ABSENT)) return ABSENT;
  if (values.length !== 2 || !Array.isArray(values[0]) || typeof values[1] !== "string") return NONCONFORMING;
  const items = values[0] as readonly Value[];
  if (items.some((value) => value === ABSENT)) return ABSENT;
  if (items.some((value) => typeof value === "object" && value !== null)) return NONCONFORMING;
  if (new Set(items.filter((value) => value !== null).map((value) => typeof value)).size > 1) return NONCONFORMING;
  return items.map((value) => value === null ? "" : String(value)).join(values[1] as string);
}

/** Whether a math call has an argument count it accepts. */
export function mathArity(fn: string, count: number): boolean {
  return !(fn === "abs" && count !== 1 || fn === "round" && (count < 1 || count > 2) ||
    (fn === "min" || fn === "max") && count === 0 || fn === "clamp" && count !== 3);
}

/**
 * `abs`, `round`, `min`, `max` and `clamp` over evaluated arguments of an accepted count. Arguments
 * are checked in order, so the first absent, nonconforming or mistyped one decides. `dimension` is
 * the first argument's declared dimension and `dimensions` each argument's, read only when it is set.
 */
export function mathCall(fn: string, values: readonly Value[], dimension: Dimension | undefined, dimensions: readonly (Dimension | undefined)[]): Value {
  let unit: string | undefined;
  const numbers: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === NONCONFORMING || value === ABSENT) return value;
    if (dimension === undefined) {
      const number = asNumber(value);
      if (number === ABSENT) return NONCONFORMING;
      numbers.push(number);
      continue;
    }
    if (dimensions[index] !== dimension || typeof value !== "string") return NONCONFORMING;
    const quantity = parseQuantity(value);
    if (quantity === undefined || quantity.dimension !== dimension) return NONCONFORMING;
    if (unit !== undefined && quantity.unit !== unit) return NONCONFORMING;
    unit = quantity.unit;
    numbers.push(quantity.value);
  }
  let result: number;
  switch (fn) {
    case "abs": result = Math.abs(numbers[0]!); break;
    case "round": {
      const step = Math.abs(numbers[1] ?? 1);
      if (step === 0) return NONCONFORMING;
      result = Math.round(numbers[0]! / step) * step;
      break;
    }
    case "min": result = Math.min(...numbers); break;
    case "max": result = Math.max(...numbers); break;
    case "clamp": result = Math.max(numbers[0]!, Math.min(numbers[1]!, numbers[2]!)); break;
    default: return NONCONFORMING;
  }
  return Number.isFinite(result) ? unit === undefined ? result : `${result}${unit}` : NONCONFORMING;
}

const QUANTITY = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%)$/;

function parseQuantity(value: string): { value: number; unit: string; dimension: "length" | "percentage" | "duration" } | undefined {
  const match = QUANTITY.exec(value);
  if (match === null) return undefined;
  const unit = match[2]!;
  const number = Number(match[1]);
  return Number.isFinite(number)
    ? { value: number, unit, dimension: unit === "%" ? "percentage" : unit === "ms" || unit === "s" ? "duration" : "length" }
    : undefined;
}

/** The dimensional type an expression carries into a later math call. */
export function dimensionType(node: ExpressionNode | undefined, scope: Scope): "length" | "percentage" | "duration" | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "literal") return node.dimension;
  if (node.kind === "unary" && node.op === "-") return dimensionType(node.operand, scope);
  if (node.kind === "binary") {
    const left = dimensionType(node.left, scope);
    const right = dimensionType(node.right, scope);
    if (node.op === "+" || node.op === "-") return left !== undefined && left === right ? left : undefined;
    if (node.op === "*") return left === undefined ? right : right === undefined ? left : undefined;
    if (node.op === "/") return right === undefined ? left : undefined;
  }
  if (node.kind === "conditional") {
    const consequent = dimensionType(node.consequent, scope);
    const alternate = dimensionType(node.alternate, scope);
    if (node.consequent.kind === "literal" && node.consequent.value === null) return alternate;
    if (node.alternate.kind === "literal" && node.alternate.value === null) return consequent;
    return consequent !== undefined && consequent === alternate ? consequent : undefined;
  }
  if (node.kind === "call" && (node.fn === "round" || node.fn === "min" || node.fn === "max" ||
    node.fn === "clamp" || node.fn === "abs")) {
    return dimensionType(node.args[node.fn === "clamp" ? 1 : 0]!, scope);
  }
  if (node.kind === "call" && node.fn === "default") {
    return dimensionType(node.args[0]!, scope) ?? dimensionType(node.args[1]!, scope);
  }
  const name = path(node);
  return name === undefined ? undefined : scope.typeOfPath?.(name);
}

const cache = new Map<string, CompiledExpression>();

/** Formatting inference uses declared identities and typed operators, never string contents. */
export function expressionFormattingType(node: ExpressionNode, scope: Scope): string | undefined {
  const collection = (type: TypeNode | undefined): boolean => {
    if (type?.kind === "constrained") return collection(type.base);
    if (type?.kind === "union") return type.members.every((member) =>
      member.kind === "terminal" && ["null", "absent"].includes(member.name) || collection(member));
    if (type?.kind === "selected") return type.options.every((option) => collection(option.type));
    return type?.kind === "list" || type?.kind === "separated-list" || type?.kind === "record";
  };
  const formattingPath = (part: ExpressionNode): string | undefined => {
    if (part.kind === "member") {
      const parent = formattingPath(part.object);
      return parent === undefined ? undefined : `${parent}.${part.key}`;
    }
    if (part.kind === "index") {
      const parent = formattingPath(part.object);
      if (part.index.kind !== "literal" && (parent === undefined || !collection(scope.typeOfDeclaredPath?.(parent)))) return undefined;
      const key = part.index.kind === "literal" ? part.index.value : 0;
      return parent === undefined || typeof key !== "number" && typeof key !== "string" ? undefined : `${parent}.${key}`;
    }
    return path(part);
  };
  const name = formattingPath(node);
  if (name !== undefined) return formattingType(scope.typeOfDeclaredPath?.(name));
  const dimension = dimensionType(node, scope);
  if (dimension !== undefined) return dimension;
  if (node.kind === "literal") return typeof node.value === "number" ? "number" : typeof node.value === "string" ? "string" : undefined;
  if (node.kind === "array" && node.items.every((item) => ["string", "keyword"].includes(expressionFormattingType(item, scope) ?? ""))) return "list";
  if (node.kind === "binary" && ["+", "-", "*", "/", "%"].includes(node.op) || node.kind === "unary" && node.op === "-") return "number";
  if (node.kind === "call" && ["min", "max", "abs", "round", "clamp"].includes(node.fn)) return "number";
  if (node.kind === "call" && ["concat", "join", "format", "formatRange"].includes(node.fn)) return "string";
  if (node.kind === "call" && node.fn === "default" && node.args.length === 2) {
    if (node.args[0]?.kind === "literal" && node.args[0].value === null) return expressionFormattingType(node.args[1]!, scope);
    return expressionFormattingType(node.args[0]!, scope);
  }
  if (node.kind === "conditional") {
    const left = expressionFormattingType(node.consequent, scope);
    const right = expressionFormattingType(node.alternate, scope);
    return left === right ? left : node.consequent.kind === "literal" && node.consequent.value === null ? right
      : node.alternate.kind === "literal" && node.alternate.value === null ? left : undefined;
  }
  return undefined;
}

function path(node: ExpressionNode): string | undefined {
  if (node.kind === "id") return node.name;
  if (node.kind === "member") {
    const parent = path(node.object);
    return parent === undefined ? undefined : `${parent}.${node.key}`;
  }
  if (node.kind === "index" && node.index.kind === "literal") {
    const key = node.index.value;
    if (typeof key !== "string" && typeof key !== "number") return undefined;
    const parent = path(node.object);
    return parent === undefined ? undefined : `${parent}.${key}`;
  }
  return undefined;
}

function collectDependencies(node: ExpressionNode, dependencies: string[]): void {
  const name = path(node);
  if (name !== undefined) {
    if (!dependencies.includes(name)) dependencies.push(name);
    return;
  }
  switch (node.kind) {
    case "literal": return;
    case "id": return;
    case "member": collectDependencies(node.object, dependencies); return;
    case "index":
      collectDependencies(node.object, dependencies);
      collectDependencies(node.index, dependencies);
      return;
    case "unary": collectDependencies(node.operand, dependencies); return;
    case "binary":
      collectDependencies(node.left, dependencies);
      collectDependencies(node.right, dependencies);
      return;
    case "conditional":
      collectDependencies(node.test, dependencies);
      collectDependencies(node.consequent, dependencies);
      collectDependencies(node.alternate, dependencies);
      return;
    case "call":
      for (const argument of node.args) collectDependencies(argument, dependencies);
      return;
    case "object":
      for (const pair of node.pairs) collectDependencies(pair.value, dependencies);
      return;
    case "array":
      for (const item of node.items) collectDependencies(item, dependencies);
  }
}

/** References checked against declared types before evaluating an expression. */
export function typeCheckedDependencies(expression: string | CompiledExpression): readonly string[] {
  const ast = typeof expression === "string" ? compileExpression(expression).ast : expression.ast;
  const dependencies: string[] = [];
  collectDependencies(ast, dependencies);
  return dependencies.sort();
}

function appendWritable(node: ExpressionNode, result: WritablePathSegment[]): boolean {
  if (node.kind === "id") {
    result.push(node.name);
    return true;
  }
  if (node.kind === "member") {
    if (!appendWritable(node.object, result)) return false;
    result.push(node.key);
    return true;
  }
  if (node.kind !== "index" || !appendWritable(node.object, result)) return false;
  const index = node.index;
  const key = index.kind === "literal" ? index.value : undefined;
  result.push(typeof key === "string" || typeof key === "number"
    ? key
    : { kind: "index", expression: index });
  return true;
}

/** Compile an expression once for parsers, runtimes, and target generators. */
export function compileExpression(source: string): CompiledExpression {
  let compiled = cache.get(source);
  if (compiled !== undefined) return compiled;
  const ast = parseExpression(source);
  const dependencies: string[] = [];
  collectDependencies(ast, dependencies);
  dependencies.sort();
  compiled = { source, ast, dependencies };
  cache.set(source, compiled);
  return compiled;
}

/**
 * Compile a path field (`bind:`, `<set name>`): its root names a declaration with or without the
 * `$` marker. Bracketed segments remain expressions; a caller rejects anything but an access chain.
 */
export function compilePath(source: string): CompiledExpression {
  const path = source.trimStart();
  return compileExpression(path.startsWith("$") ? path : `$${path}`);
}

/** An access chain's segments from its root name, or undefined when the node is not one. */
export function writablePathOf(node: ExpressionNode): WritablePath | undefined {
  const result: WritablePathSegment[] = [];
  return appendWritable(node, result) ? result : undefined;
}

/** Return a writable path only when it is rooted in declared writable state. */
export function getWritablePath(
  source: string,
  writableRoots: ReadonlySet<string>,
): WritablePath | undefined {
  const result: WritablePathSegment[] = [];
  if (!appendWritable(compilePath(source).ast, result)
    || result[0] === "$$event" || !writableRoots.has(result[0] as string)) return undefined;
  return result;
}

/** Parse-check an expression (syntax only). */
export function checkExpression(source: string): void {
  compileExpression(source);
}

/** Reject operations whose known literal types make them invalid at authoring time. */
export function checkExpressionSemantics(node: ExpressionNode): void {
  type Known = { kind: "number" | "string" | "boolean" | "length" | "percentage" | "duration" | "list" | "object" | "null"; unit?: string | undefined };
  const dimensional = (type: Known | undefined): boolean => type !== undefined &&
    (type.kind === "length" || type.kind === "percentage" || type.kind === "duration");
  const arithmetic = (op: string, left: Known, right: Known): Known | undefined => {
    if (op === "+" || op === "-") {
      if (left.kind === "number" && right.kind === "number") return { kind: "number" };
      if (dimensional(left) && left.kind === right.kind &&
        (left.unit === undefined || right.unit === undefined || left.unit === right.unit)) {
        return { kind: left.kind, unit: left.unit ?? right.unit };
      }
    }
    if (op === "*") {
      if (left.kind === "number" && right.kind === "number") return { kind: "number" };
      if (dimensional(left) && right.kind === "number") return left;
      if (left.kind === "number" && dimensional(right)) return right;
    }
    if (op === "/") {
      if (left.kind === "number" && right.kind === "number") return { kind: "number" };
      if (dimensional(left) && right.kind === "number") return left;
    }
    if (op === "%" && left.kind === "number" && right.kind === "number") return { kind: "number" };
    return undefined;
  };
  const known = (value: ExpressionNode): Known | undefined => {
    if (value.kind === "literal") {
      if (value.dimension !== undefined) return { kind: value.dimension, unit: parseQuantity(value.value as string)?.unit };
      return { kind: value.value === null ? "null" : typeof value.value === "number" ? "number" : typeof value.value === "boolean" ? "boolean" : "string" };
    }
    if (value.kind === "unary" && value.op === "-") return known(value.operand);
    if (value.kind === "binary" && ["+", "-", "*", "/", "%"].includes(value.op)) {
      const left = known(value.left);
      const right = known(value.right);
      return left === undefined || right === undefined ? undefined : arithmetic(value.op, left, right);
    }
    if (value.kind === "array") return { kind: "list" };
    if (value.kind === "object") return { kind: "object" };
    if (value.kind === "call") {
      if (value.fn === "concat" || value.fn === "join" || value.fn === "format" || value.fn === "formatRange") return { kind: "string" };
      if (value.fn === "formatParts") return { kind: "list" };
      if (value.fn === "default") {
        const first = known(value.args[0]!);
        return first?.kind === "null" ? known(value.args[1]!) : first ?? known(value.args[1]!);
      }
      return known(value.args[value.fn === "clamp" ? 1 : 0]!);
    }
    return undefined;
  };
  const visit = (value: ExpressionNode): void => {
    switch (value.kind) {
      case "call": {
        for (const argument of value.args) visit(argument);
        const { fn, args } = value;
        const formatting = fn === "format" || fn === "formatRange" || fn === "formatParts";
        const validCount = formatting ? args.length >= (fn === "formatRange" ? 2 : 1) && args.length <= (fn === "formatRange" ? 5 : 4)
          : fn === "abs" ? args.length === 1
          : fn === "round" ? args.length === 1 || args.length === 2
          : fn === "min" || fn === "max" || fn === "concat" ? args.length > 0
          : fn === "clamp" ? args.length === 3 : args.length === 2;
        if (!validCount) throw new SyntaxError(`${fn}() has the wrong number of arguments.`);
        const types = args.map(known);
        if (fn === "concat" && types.some((type) => type?.kind === "list" || type?.kind === "object")) {
          throw new SyntaxError("concat() accepts scalar values only.");
        }
        if (fn === "join" && (types[0] !== undefined && types[0].kind !== "list" && types[0].kind !== "null"
          || types[1] !== undefined && types[1].kind !== "string")) {
          throw new SyntaxError("join() requires a list and a string separator.");
        }
        if (fn === "join" && args[0]?.kind === "array") {
          const items = args[0].items.map(known).filter((type): type is Known => type !== undefined && type.kind !== "null");
          if (items.some((type) => type.kind === "list" || type.kind === "object" || type.kind !== items[0]?.kind)) {
            throw new SyntaxError("join() requires one scalar item type.");
          }
        }
        if (fn === "default" && types[0] !== undefined && types[1] !== undefined &&
          types[0].kind !== "null" && types[1].kind !== "null" && types[0].kind !== types[1].kind) {
          throw new SyntaxError("default() requires values of one type.");
        }
        if (["abs", "round", "min", "max", "clamp"].includes(fn)) {
          const typed = types.filter((type): type is Known => type !== undefined);
          if (typed.some((type) => type.kind !== "number" && !dimensional(type))) {
            throw new SyntaxError(`${fn}() requires numeric or dimensional values.`);
          }
          const first = typed[0];
          if (first !== undefined && typed.some((type) => type.kind !== first.kind ||
            dimensional(first) && first.unit !== undefined && type.unit !== undefined && type.unit !== first.unit)) {
            throw new SyntaxError(`${fn}() requires matching types and written units.`);
          }
          if (fn === "round" && args[1] !== undefined && args[1]!.kind === "literal" &&
            (args[1]!.value === 0 || parseQuantity(String(args[1]!.value))?.value === 0)) {
            throw new SyntaxError("round() step must be nonzero.");
          }
        }
        return;
      }
      case "unary": visit(value.operand); return;
      case "binary": {
        visit(value.left);
        visit(value.right);
        if (["+", "-", "*", "/", "%"].includes(value.op)) {
          const left = known(value.left);
          const right = known(value.right);
          if (value.op === "/" && dimensional(left) && value.right.kind === "literal" && value.right.value === 0) {
            throw new SyntaxError("A dimension cannot be divided by zero.");
          }
          if (left !== undefined && right !== undefined && arithmetic(value.op, left, right) === undefined) {
            throw new SyntaxError(`${value.op} has incompatible operand types or written units.`);
          }
        }
        return;
      }
      case "conditional": visit(value.test); visit(value.consequent); visit(value.alternate); return;
      case "member": visit(value.object); return;
      case "index": visit(value.object); visit(value.index); return;
      case "array": for (const item of value.items) visit(item); return;
      case "object": for (const pair of value.pairs) visit(pair.value); return;
      default: return;
    }
  };
  visit(node);
}

/** Whether a bound expression may yield an invalid built-in result that must not be written. */
export function hasBuiltinCall(node: ExpressionNode): boolean {
  switch (node.kind) {
    case "call": return true;
    case "unary": return hasBuiltinCall(node.operand);
    case "binary": return hasBuiltinCall(node.left) || hasBuiltinCall(node.right);
    case "conditional": return hasBuiltinCall(node.test) || hasBuiltinCall(node.consequent) || hasBuiltinCall(node.alternate);
    case "member": return hasBuiltinCall(node.object);
    case "index": return hasBuiltinCall(node.object) || hasBuiltinCall(node.index);
    case "array": return node.items.some(hasBuiltinCall);
    case "object": return node.pairs.some((pair) => hasBuiltinCall(pair.value));
    default: return false;
  }
}

/** Evaluate an expression against a scope. */
export function evaluate(source: string, scope: Scope): Value {
  const result = evalNode(compileExpression(source).ast, scope);
  return result === NONCONFORMING ? ABSENT : reveal(result, scope);
}

/** Evaluate a previously compiled expression without reparsing its source. */
export function evaluateCompiled(expression: CompiledExpression | ExpressionNode, scope: Scope): Value {
  return reveal(evalNode("ast" in expression ? expression.ast : expression, scope), scope);
}

/** Escaped-text form: absence and null render as empty text. */
export function toText(value: Value): string {
  if (isAbsent(value)) return "";
  if (Array.isArray(value)) return value.map(toText).join(" ");
  if (typeof value === "object") return "";
  return String(value);
}

/** Enumerated attributes whose true and false are the strings "true" and "false", not presence. */
export function isEnumeratedBoolean(name: string): boolean {
  return name.startsWith("aria-") || name === "contenteditable" || name === "draggable" || name === "spellcheck";
}

/** Serialize an ordinary bound attribute. */
export function toAttribute(value: Value, name = ""): string | null {
  if (typeof value === "boolean" && isEnumeratedBoolean(name)) return String(value);
  if (isAbsent(value) || value === false) return null;
  if (value === true) return "";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (Array.isArray(value)) return value.map(toText).join(" ");
  return null;
}
