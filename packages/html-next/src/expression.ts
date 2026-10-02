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
  | typeof NONCONFORMING
  | readonly Value[]
  | { readonly [key: string]: Value };

/** Expressions only look names up, so any `Map` or reactive scope layer can supply them. */
export interface Scope {
  get(name: string): Value | undefined;
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
  | { kind: "literal"; value: Value; dimension?: "length" | "percentage" | "duration" }
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

type TokenKind = 0 | 1 | 2 | 3 | 4 | 5;

const TOKEN = /\s*(?:(<=|>=|!=|\^=|\$=|\*=)|(\d+(?:\.\d+|\.(?![A-Za-z_$\d]))?|\.\d+)(vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%(?![A-Za-z_$\d.]|\s*(?:\d|\.\d|\$)))?|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|([A-Za-z_$][A-Za-z0-9_$]*)|([=<>+*/%(),.?:{}[\]-])|$)/y;
const ESCAPE = /\\([\s\S])/g;

const PRECEDENCE: Readonly<Record<string, number>> = {
  or: 1, and: 2,
  "=": 3, "!=": 3, "^=": 3, "$=": 3, "*=": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

function precedence(token: string | number): number {
  return PRECEDENCE[token as string] ?? 0;
}

function isFunction(name: string): boolean {
  return name === "round"
    || name === "clamp"
    || name === "min"
    || name === "max"
    || name === "abs"
    || name === "default"
    || name === "concat"
    || name === "join";
}

/** Scans directly into the AST: no token array and no token objects. */
function parse(source: string): ExpressionNode {
  let offset = 0;
  let kind: TokenKind = 0;
  let token: string | number = "";
  let integerToken = false;
  let numericLexeme = "";

  function next(): void {
    const previousKind = kind;
    const previousToken = token;
    const previousIntegerToken = integerToken;
    TOKEN.lastIndex = offset;
    const match = TOKEN.exec(source);
    if (match === null) {
      const character = source.slice(offset).trimStart()[0]!;
      if (character === '"' || character === "'") {
        throw new SyntaxError("Unterminated string literal.");
      }
      throw new SyntaxError(`Unexpected character \`${character}\`.`);
    }
    offset = TOKEN.lastIndex;
    if (previousKind === 4 && previousToken === "." && /^\d+\.\d+/.test(match[2] ?? "")) {
      const digits = /^\d+/.exec(match[2]!)![0];
      offset = match.index + match[0].indexOf(digits) + digits.length;
      kind = 1;
      token = Number(digits);
      integerToken = true;
      numericLexeme = digits;
      return;
    }
    // A dot after a value begins a path segment, even when the segment is an integer.
    if (match[2]?.startsWith(".") && (previousKind === 3 || previousKind === 2
      || previousKind === 1 && previousIntegerToken
      || previousKind === 4 && [")", "]", "}"].includes(String(previousToken)))) {
      offset = match.index + match[0].indexOf(".") + 1;
      kind = 4;
      token = ".";
      return;
    }
    if (match[1] !== undefined || match[6] !== undefined) {
      kind = 4;
      token = match[1] ?? match[6]!;
    } else if (match[2] !== undefined) {
      kind = match[3] === undefined ? 1 : 5;
      token = match[3] === undefined ? Number(match[2]) : `${match[2]}${match[3]}`;
      integerToken = match[3] === undefined && !match[2].includes(".");
      numericLexeme = match[2];
    } else if (match[4] !== undefined) {
      kind = 2;
      token = match[4].slice(1, -1).replace(ESCAPE, "$1");
    } else if (match[5] !== undefined) {
      kind = 3;
      token = match[5]!;
    } else {
      kind = 0;
      token = "";
    }
  }

  function eat(value: string): boolean {
    if (kind !== 4 || token !== value) return false;
    next();
    return true;
  }

  function expect(value: string): void {
    if (!eat(value)) throw new SyntaxError(`Expected \`${value}\`.`);
  }

  function binary(minimum: number): ExpressionNode {
    let left = unary();
    let power = precedence(token);
    while (power >= minimum) {
      const op = token as string;
      next();
      left = { kind: "binary", op, left, right: binary(power + 1) };
      power = precedence(token);
    }
    return left;
  }

  function conditional(): ExpressionNode {
    const test = binary(1);
    if (!eat("?")) return test;
    const consequent = conditional();
    expect(":");
    return { kind: "conditional", test, consequent, alternate: conditional() };
  }

  function unary(): ExpressionNode {
    if (kind === 3 && token === "not") {
      next();
      return { kind: "unary", op: "not", operand: unary() };
    }
    if (eat("-")) return { kind: "unary", op: "-", operand: unary() };

    let object = primary();
    while (kind === 4) {
      if (eat(".")) {
        if ((kind as TokenKind) !== 3 && ((kind as TokenKind) !== 1 || !/^\d+$/.test(numericLexeme))) {
          throw new SyntaxError("Expected a property name after `.`.");
        }
        const numeric = (kind as TokenKind) === 1;
        const key = numeric && Number.isSafeInteger(token) && String(token) === numericLexeme
          ? token : numeric ? numericLexeme : token;
        next();
        object = typeof key === "number"
          ? { kind: "index", object, index: { kind: "literal", value: key } }
          : { kind: "member", object, key };
      } else if (eat("[")) {
        const index = conditional();
        expect("]");
        if (index.kind === "literal" && typeof index.value === "number"
          || index.kind === "unary" && index.op === "-" && index.operand.kind === "literal"
            && typeof index.operand.value === "number") {
          throw new SyntaxError("Use dotted indexes, for example `$items.0.name`.");
        }
        object = { kind: "index", object, index };
      } else {
        break;
      }
    }
    return object;
  }

  function primary(): ExpressionNode {
    const currentKind = kind;
    const currentToken = token;
    if (currentKind === 5) {
      const written = currentToken as string;
      const unit = /(?:vmin|vmax|rem|px|em|vw|vh|ch|ex|cm|mm|in|pt|pc|q|ms|s|%)$/.exec(written)![0];
      const dimension = unit === "%" ? "percentage" : unit === "ms" || unit === "s" ? "duration" : "length";
      next();
      return { kind: "literal", value: written, dimension };
    }
    if (currentKind === 1 || currentKind === 2) {
      next();
      return { kind: "literal", value: currentToken };
    }
    if (currentKind === 4 && currentToken === "(") {
      next();
      const node = conditional();
      expect(")");
      return node;
    }
    if (currentKind === 4 && currentToken === "{") {
      next();
      const pairs: { key: string; value: ExpressionNode }[] = [];
      if (!eat("}")) {
        do {
          if (token === "}") break;
          if (kind !== 3 && kind !== 2) {
            throw new SyntaxError("Object keys must be identifiers or strings.");
          }
          const key = token as string;
          next();
          expect(":");
          pairs.push({ key, value: conditional() });
        } while (eat(","));
        expect("}");
      }
      return { kind: "object", pairs };
    }
    if (currentKind === 4 && currentToken === "[") {
      next();
      const items: ExpressionNode[] = [];
      if (!eat("]")) {
        do {
          if (token === "]") break;
          items.push(conditional());
        } while (eat(","));
        expect("]");
      }
      return { kind: "array", items };
    }
    if (currentKind === 3) {
      const name = currentToken as string;
      next();
      if (name === "true") return { kind: "literal", value: true };
      if (name === "false") return { kind: "literal", value: false };
      if (name === "null") return { kind: "literal", value: null };
      if (token === "(" && isFunction(name)) {
        next();
        const args: ExpressionNode[] = [];
        if (!eat(")")) {
          do args.push(conditional()); while (eat(","));
          expect(")");
        }
        return { kind: "call", fn: name, args };
      }
      return { kind: "id", name: name.startsWith("$") ? name.slice(1) : name };
    }
    throw new SyntaxError("Unexpected end of expression.");
  }

  next();
  const node = conditional();
  if (kind !== 0) throw new SyntaxError("Unexpected trailing input in expression.");
  return node;
}

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
  // A native Error is a present failure even when its message is non-enumerable. The empty-record
  // rule applies to declarative object values, not to platform error objects in <data>.error.
  if (value instanceof Error) return true;
  for (const key in value) if (Object.hasOwn(value, key)) return true;
  return false;
}

function asNumber(value: Value): number | Absent {
  return typeof value === "number" && Number.isFinite(value) ? value : ABSENT;
}

function evalNode(node: ExpressionNode, scope: Scope): Value {
  switch (node.kind) {
    case "literal": return node.value;
    case "id": {
      const value = scope.get(node.name);
      if (value === undefined) throw new UndeclaredName(node.name);
      return value;
    }
    case "member": {
      const object = evalNode(node.object, scope);
      if (object === NONCONFORMING) return NONCONFORMING;
      // A list's or string's `length` is its count, as `cart.items.length` reads in the proposal.
      if (node.key === "length" && (Array.isArray(object) || typeof object === "string")) return object.length;
      if (isAbsent(object) || typeof object !== "object" || Array.isArray(object)) {
        return ABSENT;
      }
      const value = (object as { readonly [key: string]: Value })[node.key];
      return value === undefined ? ABSENT : value;
    }
    case "index": {
      const object = evalNode(node.object, scope);
      const index = evalNode(node.index, scope);
      if (object === NONCONFORMING || index === NONCONFORMING) return NONCONFORMING;
      if (isAbsent(object) || isAbsent(index)) return ABSENT;
      if (Array.isArray(object) && typeof index === "number") {
        const value = object[index];
        return value === undefined ? ABSENT : value;
      }
      if (typeof object === "object" && (typeof index === "string" || typeof index === "number")) {
        const value = (object as { readonly [key: string]: Value })[String(index)];
        return value === undefined ? ABSENT : value;
      }
      return ABSENT;
    }
    case "unary": {
      const operand = evalNode(node.operand, scope);
      if (operand === NONCONFORMING) return NONCONFORMING;
      if (node.op === "not") return !truthy(operand);
      if (dimensionType(node.operand, scope) !== undefined && typeof operand === "string") {
        const quantity = parseQuantity(operand);
        return quantity === undefined ? ABSENT : `${-quantity.value}${quantity.unit}`;
      }
      const number = asNumber(operand);
      return number === ABSENT ? ABSENT : -number;
    }
    case "binary": return evalBinary(node, scope);
    case "conditional": {
      const test = evalNode(node.test, scope);
      return test === NONCONFORMING ? NONCONFORMING : evalNode(truthy(test) ? node.consequent : node.alternate, scope);
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
    if (op === "and" && !truthy(left)) return false;
    if (op === "or" && truthy(left)) return true;
    const right = evalNode(node.right, scope);
    return right === NONCONFORMING ? NONCONFORMING : truthy(right);
  }

  const left = evalNode(node.left, scope);
  const right = evalNode(node.right, scope);
  if (left === NONCONFORMING || right === NONCONFORMING) return NONCONFORMING;
  if (op === "=") return left === right;
  if (op === "!=") return left !== right;
  if (op === "^=" || op === "$=" || op === "*=") {
    if (typeof left !== "string" || typeof right !== "string") return ABSENT;
    if (op === "^=") return left.startsWith(right);
    if (op === "$=") return left.endsWith(right);
    return left.includes(right);
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
  if (fn === "default") {
    if (args.length !== 2) return NONCONFORMING;
    const value = evalNode(args[0]!, scope);
    if (value === NONCONFORMING) return NONCONFORMING;
    return value === ABSENT || value === null ? evalNode(args[1]!, scope) : value;
  }
  if (fn === "concat" || fn === "join") {
    const values: Value[] = [];
    for (const argument of args) values.push(evalNode(argument, scope));
    if (values.includes(NONCONFORMING)) return NONCONFORMING;
    if (fn === "concat") {
      if (values.some((value) => value === ABSENT)) return ABSENT;
      if (values.length === 0 || values.some((value) => typeof value === "object" && value !== null)) return NONCONFORMING;
      return values.map((value) => value === null ? "" : String(value)).join("");
    }
    if (values.some((value) => value === ABSENT)) return ABSENT;
    if (values.length !== 2 || !Array.isArray(values[0]) || typeof values[1] !== "string") return NONCONFORMING;
    const items = values[0];
    if (items.some((value) => value === ABSENT)) return ABSENT;
    if (items.some((value) => typeof value === "object" && value !== null)) return NONCONFORMING;
    if (new Set(items.filter((value) => value !== null).map((value) => typeof value)).size > 1) return NONCONFORMING;
    return items.map((value) => value === null ? "" : String(value)).join(values[1]);
  }

  const isRound = fn === "round";
  if (fn === "abs" && args.length !== 1 || isRound && (args.length < 1 || args.length > 2)
    || (fn === "min" || fn === "max") && args.length === 0 || fn === "clamp" && args.length !== 3) return NONCONFORMING;
  const dimension = dimensionType(args[0]!, scope);
  let unit: string | undefined;
  const numbers: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = evalNode(args[index]!, scope);
    if (value === NONCONFORMING) return NONCONFORMING;
    if (value === ABSENT) return ABSENT;
    if (dimension === undefined) {
      const number = asNumber(value);
      if (number === ABSENT) return NONCONFORMING;
      numbers.push(number);
      continue;
    }
    if (dimensionType(args[index]!, scope) !== dimension || typeof value !== "string") return NONCONFORMING;
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
  const ast = parse(source);
  const dependencies: string[] = [];
  collectDependencies(ast, dependencies);
  dependencies.sort();
  compiled = { source, ast, dependencies };
  cache.set(source, compiled);
  return compiled;
}

/** Return a writable path only when it is rooted in declared writable state. */
export function getWritablePath(
  source: string,
  writableRoots: ReadonlySet<string>,
): WritablePath | undefined {
  const result: WritablePathSegment[] = [];
  if (!appendWritable(compileExpression(source).ast, result)
    || !writableRoots.has(result[0] as string)) return undefined;
  return result;
}

/** Parse-check an expression (syntax only). */
export function checkExpression(source: string): void {
  compileExpression(source);
}

/** Reject calls whose argument count or literal types make them invalid at authoring time. */
export function checkBuiltinCalls(node: ExpressionNode): void {
  type Known = { kind: "number" | "string" | "boolean" | "length" | "percentage" | "duration" | "list" | "object" | "null"; unit?: string | undefined };
  const known = (value: ExpressionNode): Known | undefined => {
    if (value.kind === "literal") {
      if (value.dimension !== undefined) return { kind: value.dimension, unit: parseQuantity(value.value as string)?.unit };
      return { kind: value.value === null ? "null" : typeof value.value === "number" ? "number" : typeof value.value === "boolean" ? "boolean" : "string" };
    }
    if (value.kind === "unary" && value.op === "-") return known(value.operand);
    if (value.kind === "array") return { kind: "list" };
    if (value.kind === "object") return { kind: "object" };
    if (value.kind === "call") {
      if (value.fn === "concat" || value.fn === "join") return { kind: "string" };
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
        const validCount = fn === "abs" ? args.length === 1
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
          const dimensional = (type: Known | undefined): boolean => type !== undefined &&
            (type.kind === "length" || type.kind === "percentage" || type.kind === "duration");
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
      case "binary": visit(value.left); visit(value.right); return;
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
  return result === NONCONFORMING ? ABSENT : result;
}

/** Evaluate a previously compiled expression without reparsing its source. */
export function evaluateCompiled(expression: CompiledExpression | ExpressionNode, scope: Scope): Value {
  return evalNode("ast" in expression ? expression.ast : expression, scope);
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
