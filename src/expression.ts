/**
 * The HTML Next expression language: a small, pure, typed evaluator with no `eval()`.
 *
 * Value semantics follow the specification (Expressions, "Value semantics"):
 * - a first-class ABSENT value from missing data that propagates through operations and
 *   never throws at runtime (fault tolerance, like the HTML parser);
 * - truthiness is "the empty value of each type is false" (false, absent, null, "", 0, []);
 * - equality is typed (no coercion); arithmetic is numeric only (no string `+`).
 *
 * An *undeclared root identifier* is a compile-time author error, surfaced as UndeclaredName
 * for the caller (the in-browser compiler) to turn into a diagnostic. A *declared but missing*
 * read is data, and yields ABSENT.
 */

/** The absent value: the result of a missing read or an operation on absent/typed-invalid data. */
export const ABSENT = Symbol("absent");
export type Absent = typeof ABSENT;

export type Value =
  | string
  | number
  | boolean
  | null
  | Absent
  | readonly Value[]
  | { readonly [key: string]: Value };

export type Scope = ReadonlyMap<string, Value>;

/** Thrown for an undeclared root identifier — a compile-time author error, not a data gap. */
export class UndeclaredName extends Error {
  constructor(readonly identifier: string) {
    super(`\`${identifier}\` is not declared in scope.`);
    this.name = "UndeclaredName";
  }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type ExpressionNode =
  | { kind: "literal"; value: Value }
  | { kind: "id"; name: string }
  | { kind: "member"; object: ExpressionNode; key: string }
  | { kind: "index"; object: ExpressionNode; index: ExpressionNode }
  | { kind: "unary"; op: "not" | "-"; operand: ExpressionNode }
  | { kind: "binary"; op: string; left: ExpressionNode; right: ExpressionNode }
  | { kind: "call"; fn: string; args: ExpressionNode[] }
  | { kind: "object"; pairs: { key: string; value: ExpressionNode }[] }
  | { kind: "array"; items: ExpressionNode[] };

type Node = ExpressionNode;

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

const FUNCTIONS = new Set(["round", "clamp", "min", "max", "abs", "format"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "eof" };

const OPERATORS = [
  "<=", ">=", "!=", "^=", "$=", "*=", "=", "<", ">",
  "+", "-", "*", "/", "%", "(", ")", "[", "]", "{", "}", ",", ":", ".",
];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
  const isIdPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = "";
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
        } else {
          value += src[i];
          i += 1;
        }
      }
      if (src[i] !== c) throw new SyntaxError("Unterminated string literal.");
      i += 1;
      tokens.push({ t: "str", v: value });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let text = "";
      while (i < src.length && /[0-9.]/.test(src[i]!)) {
        text += src[i];
        i += 1;
      }
      tokens.push({ t: "num", v: Number(text) });
      continue;
    }
    if (isIdStart(c) && !(c === "$" && src[i + 1] === "=")) {
      let text = "";
      while (i < src.length && isIdPart(src[i]!)) {
        text += src[i];
        i += 1;
      }
      tokens.push({ t: "id", v: text });
      continue;
    }
    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
    if (op === undefined) throw new SyntaxError(`Unexpected character \`${c}\`.`);
    tokens.push({ t: "op", v: op });
    i += op.length;
  }
  tokens.push({ t: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent over the specified grammar)
// ---------------------------------------------------------------------------

const KEYWORDS: Record<string, Value> = { true: true, false: false, null: null };

function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const eatOp = (v: string): boolean => {
    const token = peek();
    if (token.t === "op" && token.v === v) {
      pos += 1;
      return true;
    }
    return false;
  };
  const expectOp = (v: string): void => {
    if (!eatOp(v)) throw new SyntaxError(`Expected \`${v}\`.`);
  };
  const isId = (word: string): boolean => {
    const token = peek();
    return token.t === "id" && token.v === word;
  };

  const parseBinary = (next$: () => Node, ops: string[], words = false): Node => {
    let left = next$();
    for (;;) {
      const token = peek();
      const match = words
        ? token.t === "id" && ops.includes(token.v)
        : token.t === "op" && ops.includes(token.v);
      if (!match) break;
      const op = (token as { v: string }).v;
      pos += 1;
      left = { kind: "binary", op, left, right: next$() };
    }
    return left;
  };

  const parsePrimary = (): Node => {
    const token = peek();
    if (token.t === "num") {
      next();
      return { kind: "literal", value: token.v };
    }
    if (token.t === "str") {
      next();
      return { kind: "literal", value: token.v };
    }
    if (token.t === "op" && token.v === "(") {
      next();
      const inner = parseExpr();
      expectOp(")");
      return inner;
    }
    if (token.t === "op" && token.v === "{") return parseObject();
    if (token.t === "op" && token.v === "[") return parseArray();
    if (token.t === "id") {
      next();
      if (token.v in KEYWORDS) return { kind: "literal", value: KEYWORDS[token.v]! };
      if (FUNCTIONS.has(token.v) && peek().t === "op" && (peek() as { v: string }).v === "(") {
        next();
        const args: Node[] = [];
        if (!eatOp(")")) {
          do {
            args.push(parseExpr());
          } while (eatOp(","));
          expectOp(")");
        }
        return { kind: "call", fn: token.v, args };
      }
      return { kind: "id", name: token.v };
    }
    throw new SyntaxError("Unexpected end of expression.");
  };

  const parseAccess = (): Node => {
    let object = parsePrimary();
    for (;;) {
      if (eatOp(".")) {
        const token = next();
        if (token.t !== "id") throw new SyntaxError("Expected a property name after `.`.");
        object = { kind: "member", object, key: token.v };
      } else if (eatOp("[")) {
        const index = parseExpr();
        expectOp("]");
        object = { kind: "index", object, index };
      } else {
        return object;
      }
    }
  };

  const parseUnary = (): Node => {
    if (isId("not")) {
      next();
      return { kind: "unary", op: "not", operand: parseUnary() };
    }
    if (eatOp("-")) return { kind: "unary", op: "-", operand: parseUnary() };
    return parseAccess();
  };

  const parseMul = (): Node => parseBinary(parseUnary, ["*", "/", "%"]);
  const parseAdd = (): Node => parseBinary(parseMul, ["+", "-"]);
  const parseCmp = (): Node => parseBinary(parseAdd, ["<", "<=", ">", ">="]);
  const parseEq = (): Node => parseBinary(parseCmp, ["=", "!=", "^=", "$=", "*="]);
  const parseAnd = (): Node => parseBinary(parseEq, ["and"], true);
  const parseOr = (): Node => parseBinary(parseAnd, ["or"], true);

  function parseObject(): Node {
    expectOp("{");
    const pairs: { key: string; value: Node }[] = [];
    if (!eatOp("}")) {
      do {
        if (peek().t === "op" && (peek() as { v: string }).v === "}") break; // trailing comma
        const keyToken = next();
        const key =
          keyToken.t === "id" ? keyToken.v : keyToken.t === "str" ? keyToken.v : undefined;
        if (key === undefined) throw new SyntaxError("Object keys must be identifiers or strings.");
        expectOp(":");
        pairs.push({ key, value: parseExpr() });
      } while (eatOp(","));
      expectOp("}");
    }
    return { kind: "object", pairs };
  }

  function parseArray(): Node {
    expectOp("[");
    const items: Node[] = [];
    if (!eatOp("]")) {
      do {
        if (peek().t === "op" && (peek() as { v: string }).v === "]") break; // trailing comma
        items.push(parseExpr());
      } while (eatOp(","));
      expectOp("]");
    }
    return { kind: "array", items };
  }

  const parseExpr = (): Node => parseOr();

  const result = parseExpr();
  if (peek().t !== "eof") throw new SyntaxError("Unexpected trailing input in expression.");
  return result;
}

// ---------------------------------------------------------------------------
// Evaluation (fault-tolerant: data conditions never throw)
// ---------------------------------------------------------------------------

function isAbsent(value: Value): boolean {
  return value === ABSENT || value === null;
}

/** Truthiness: the empty value of each type is false. */
export function truthy(value: Value): boolean {
  if (value === ABSENT || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (Array.isArray(value)) return value.length > 0;
  return true; // present object
}

function asNumber(value: Value): number | Absent {
  return typeof value === "number" && !Number.isNaN(value) ? value : ABSENT;
}

function equal(a: Value, b: Value): boolean {
  if (isAbsent(a) || isAbsent(b)) return a === b; // absent = absent, null = null, but not cross
  if (typeof a !== typeof b) return false; // typed equality: no coercion
  if (Array.isArray(a) || Array.isArray(b)) return a === b;
  return a === b;
}

function evalNode(node: Node, scope: Scope): Value {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "id": {
      if (!scope.has(node.name)) throw new UndeclaredName(node.name);
      return scope.get(node.name)!;
    }
    case "member": {
      const object = evalNode(node.object, scope);
      if (object === null || object === ABSENT || typeof object !== "object" || Array.isArray(object)) {
        return ABSENT;
      }
      const record = object as { readonly [key: string]: Value };
      return node.key in record ? record[node.key]! : ABSENT;
    }
    case "index": {
      const object = evalNode(node.object, scope);
      const index = evalNode(node.index, scope);
      if (object === null || object === ABSENT || isAbsent(index)) return ABSENT;
      if (Array.isArray(object) && typeof index === "number") {
        return index >= 0 && index < object.length ? object[index]! : ABSENT;
      }
      if (typeof object === "object" && typeof index === "string") {
        const record = object as { readonly [key: string]: Value };
        return index in record ? record[index]! : ABSENT;
      }
      return ABSENT;
    }
    case "unary": {
      const operand = evalNode(node.operand, scope);
      if (node.op === "not") return !truthy(operand);
      const n = asNumber(operand);
      return n === ABSENT ? ABSENT : -n;
    }
    case "binary":
      return evalBinary(node.op, node.left, node.right, scope);
    case "call":
      return evalCall(node.fn, node.args.map((arg) => evalNode(arg, scope)));
    case "object": {
      const result: Record<string, Value> = {};
      for (const pair of node.pairs) result[pair.key] = evalNode(pair.value, scope);
      return result;
    }
    case "array":
      return node.items.map((item) => evalNode(item, scope));
  }
}

function evalBinary(op: string, leftNode: Node, rightNode: Node, scope: Scope): Value {
  // Boolean operators short-circuit and return a boolean (never an operand).
  if (op === "and") return truthy(evalNode(leftNode, scope)) && truthy(evalNode(rightNode, scope));
  if (op === "or") return truthy(evalNode(leftNode, scope)) || truthy(evalNode(rightNode, scope));

  const left = evalNode(leftNode, scope);
  const right = evalNode(rightNode, scope);

  if (op === "=") return equal(left, right);
  if (op === "!=") return !equal(left, right);

  // Substring / affix matching requires two strings; otherwise absent.
  if (op === "^=" || op === "$=" || op === "*=") {
    if (typeof left !== "string" || typeof right !== "string") return ABSENT;
    if (op === "^=") return left.startsWith(right);
    if (op === "$=") return left.endsWith(right);
    return left.includes(right);
  }

  // Ordered comparison and arithmetic are numeric only; a non-number operand is absent.
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

function evalCall(fn: string, args: Value[]): Value {
  if (fn === "format") {
    const [pattern, ...values] = args;
    if (typeof pattern !== "string") return ABSENT;
    let index = 0;
    return pattern.replace(/%s/g, () => index < values.length ? toText(values[index++]!) : "%s");
  }
  const numbers = args.map(asNumber);
  if (numbers.some((n) => n === ABSENT)) return ABSENT;
  const values = numbers as number[];
  switch (fn) {
    case "abs": return values.length === 1 ? Math.abs(values[0]!) : ABSENT;
    case "round": return values.length === 1 ? Math.round(values[0]!) : ABSENT;
    case "min": return values.length >= 1 ? Math.min(...values) : ABSENT;
    case "max": return values.length >= 1 ? Math.max(...values) : ABSENT;
    case "clamp": return values.length === 3
      ? Math.min(Math.max(values[0]!, values[1]!), values[2]!)
      : ABSENT;
    default: return ABSENT;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const cache = new Map<string, Node>();

function compile(src: string): Node {
  let node = cache.get(src);
  if (node === undefined) {
    node = parse(src);
    cache.set(src, node);
  }
  return node;
}

function staticPath(node: ExpressionNode): (string | number)[] | undefined {
  if (node.kind === "id") return [node.name];
  if (node.kind === "member") {
    const object = staticPath(node.object);
    return object === undefined ? undefined : [...object, node.key];
  }
  if (node.kind === "index") {
    const object = staticPath(node.object);
    if (object === undefined || node.index.kind !== "literal") return undefined;
    const key = node.index.value;
    return typeof key === "string" || typeof key === "number"
      ? [...object, key]
      : undefined;
  }
  return undefined;
}

function writablePath(node: ExpressionNode): WritablePathSegment[] | undefined {
  if (node.kind === "id") return [node.name];
  if (node.kind === "member") {
    const object = writablePath(node.object);
    return object === undefined ? undefined : [...object, node.key];
  }
  if (node.kind === "index") {
    const object = writablePath(node.object);
    if (object === undefined) return undefined;
    if (node.index.kind === "literal") {
      const key = node.index.value;
      if (typeof key === "string" || typeof key === "number") return [...object, key];
    }
    return [...object, Object.freeze({ kind: "index", expression: node.index })];
  }
  return undefined;
}

function collectDependencies(node: ExpressionNode, dependencies: Set<string>): void {
  const path = staticPath(node);
  if (path !== undefined) {
    dependencies.add(path.join("."));
    return;
  }

  switch (node.kind) {
    case "literal":
      return;
    case "id":
      dependencies.add(node.name);
      return;
    case "member":
      collectDependencies(node.object, dependencies);
      return;
    case "index":
      collectDependencies(node.object, dependencies);
      collectDependencies(node.index, dependencies);
      return;
    case "unary":
      collectDependencies(node.operand, dependencies);
      return;
    case "binary":
      collectDependencies(node.left, dependencies);
      collectDependencies(node.right, dependencies);
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

/** Compile an expression once for parsers, runtimes, and target generators. */
export function compileExpression(source: string): CompiledExpression {
  const ast = compile(source);
  const dependencies = new Set<string>();
  collectDependencies(ast, dependencies);
  return Object.freeze({
    source,
    ast,
    dependencies: Object.freeze([...dependencies].sort()),
  });
}

/** Return a static writable path only when it is rooted in declared writable state. */
export function getWritablePath(
  source: string,
  writableRoots: ReadonlySet<string>,
): WritablePath | undefined {
  const path = writablePath(compile(source));
  if (path === undefined || !writableRoots.has(String(path[0]))) return undefined;
  return Object.freeze(path);
}

/** Parse-check an expression (syntax only). Throws SyntaxError on malformed input. */
export function checkExpression(src: string): void {
  compileExpression(src);
}

/** Evaluate an expression against a scope. Throws only UndeclaredName (a compile error). */
export function evaluate(src: string, scope: Scope): Value {
  return evalNode(compile(src), scope);
}

/** Evaluate a previously compiled expression without reparsing its source. */
export function evaluateCompiled(expression: CompiledExpression | ExpressionNode, scope: Scope): Value {
  return evalNode("ast" in expression ? expression.ast : expression, scope);
}

/** Escaped-text form (for `$value`): the absent value and null render as empty. */
export function toText(value: Value): string {
  if (isAbsent(value)) return "";
  if (Array.isArray(value)) return value.map(toText).join(" ");
  if (typeof value === "object") return "";
  return String(value);
}

/**
 * Attribute serialization (Bindings): absent/null/false remove the attribute (null return);
 * true is the present-empty attribute; numbers stringify; lists space-join.
 */
export function toAttribute(value: Value): string | null {
  if (isAbsent(value) || value === false) return null;
  if (value === true) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toText).join(" ");
  return null;
}
