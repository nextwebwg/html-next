/** A missing read or an operation on missing/typed-invalid data. */
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

/** Expressions only look names up, so any `Map` or reactive scope layer can supply them. */
export interface Scope {
  get(name: string): Value | undefined;
}

export class UndeclaredName extends Error {
  constructor(readonly identifier: string) {
    super(`\`${identifier}\` is not declared in scope.`);
    this.name = "UndeclaredName";
  }
}

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

type TokenKind = 0 | 1 | 2 | 3 | 4;

const TOKEN = /\s*(?:(<=|>=|!=|\^=|\$=|\*=)|(\d+(?:\.\d*)?|\.\d+)|("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|([A-Za-z_$][A-Za-z0-9_$]*)|([=<>+*/%(),.:{}[\]-])|$)/y;
const ESCAPE = /\\([\s\S])/g;
const FORMAT_TOKEN = /%s/g;
const atoms = new Map<string, string>();

function atom(value: string): string {
  const stored = atoms.get(value);
  if (stored !== undefined) return stored;
  atoms.set(value, value);
  return value;
}

function precedence(token: string | number): number {
  switch (token) {
    case "or": return 1;
    case "and": return 2;
    case "=":
    case "!=":
    case "^=":
    case "$=":
    case "*=": return 3;
    case "<":
    case "<=":
    case ">":
    case ">=": return 4;
    case "+":
    case "-": return 5;
    case "*":
    case "/":
    case "%": return 6;
    default: return 0;
  }
}

function isFunction(name: string): boolean {
  return name === "round"
    || name === "clamp"
    || name === "min"
    || name === "max"
    || name === "abs"
    || name === "format";
}

/** Scans directly into the AST: no token array and no token objects. */
function parse(source: string): ExpressionNode {
  let offset = 0;
  let kind: TokenKind = 0;
  let token: string | number = "";

  function next(): void {
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
    if (match[1] !== undefined || match[5] !== undefined) {
      kind = 4;
      token = match[1] ?? match[5]!;
    } else if (match[2] !== undefined) {
      kind = 1;
      token = Number(match[2]);
    } else if (match[3] !== undefined) {
      kind = 2;
      token = match[3].slice(1, -1).replace(ESCAPE, "$1");
    } else if (match[4] !== undefined) {
      kind = 3;
      token = atom(match[4]);
    } else {
      kind = 0;
      token = "";
    }
  }

  function eat(value: string): boolean {
    if (token !== value) return false;
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
      const op = String(token);
      next();
      left = { kind: "binary", op, left, right: binary(power + 1) };
      power = precedence(token);
    }
    return left;
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
        if ((kind as TokenKind) !== 3) {
          throw new SyntaxError("Expected a property name after `.`.");
        }
        const key = String(token);
        next();
        object = { kind: "member", object, key };
      } else if (eat("[")) {
        const index = binary(1);
        expect("]");
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
    if (currentKind === 1 || currentKind === 2) {
      next();
      return { kind: "literal", value: currentToken };
    }
    if (currentKind === 4 && currentToken === "(") {
      next();
      const node = binary(1);
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
          const key = String(token);
          next();
          expect(":");
          pairs.push({ key, value: binary(1) });
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
          items.push(binary(1));
        } while (eat(","));
        expect("]");
      }
      return { kind: "array", items };
    }
    if (currentKind === 3) {
      const name = String(currentToken);
      next();
      if (name === "true") return { kind: "literal", value: true };
      if (name === "false") return { kind: "literal", value: false };
      if (name === "null") return { kind: "literal", value: null };
      if (token === "(" && isFunction(name)) {
        next();
        const args: ExpressionNode[] = [];
        if (!eat(")")) {
          do args.push(binary(1)); while (eat(","));
          expect(")");
        }
        return { kind: "call", fn: name, args };
      }
      return { kind: "id", name };
    }
    throw new SyntaxError("Unexpected end of expression.");
  }

  next();
  const node = binary(1);
  if (kind !== 0) throw new SyntaxError("Unexpected trailing input in expression.");
  return node;
}

function isAbsent(value: Value): boolean {
  return value === ABSENT || value === null;
}

/** Truthiness follows the empty value of each type. */
export function truthy(value: Value): boolean {
  if (value === ABSENT || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0 && value === value;
  if (Array.isArray(value)) return value.length > 0;
  for (const key in value) if (Object.hasOwn(value, key)) return true;
  return false;
}

function asNumber(value: Value): number | Absent {
  return typeof value === "number" && value === value ? value : ABSENT;
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
      if (object === null || object === ABSENT || typeof object !== "object" || Array.isArray(object)) {
        return ABSENT;
      }
      const value = (object as { readonly [key: string]: Value })[node.key];
      return value === undefined ? ABSENT : value;
    }
    case "index": {
      const object = evalNode(node.object, scope);
      const index = evalNode(node.index, scope);
      if (object === null || object === ABSENT || isAbsent(index)) return ABSENT;
      if (Array.isArray(object) && typeof index === "number") {
        const value = object[index];
        return value === undefined ? ABSENT : value;
      }
      if (typeof object === "object" && typeof index === "string") {
        const value = (object as { readonly [key: string]: Value })[index];
        return value === undefined ? ABSENT : value;
      }
      return ABSENT;
    }
    case "unary": {
      const operand = evalNode(node.operand, scope);
      if (node.op === "not") return !truthy(operand);
      const number = asNumber(operand);
      return number === ABSENT ? ABSENT : -number;
    }
    case "binary": return evalBinary(node, scope);
    case "call": return evalCall(node, scope);
    case "object": {
      const value: Record<string, Value> = {};
      for (const pair of node.pairs) value[pair.key] = evalNode(pair.value, scope);
      return value;
    }
    case "array": {
      const value: Value[] = [];
      for (const item of node.items) value.push(evalNode(item, scope));
      return value;
    }
  }
}

function evalBinary(node: Extract<ExpressionNode, { kind: "binary" }>, scope: Scope): Value {
  const { op } = node;
  if (op === "and") return truthy(evalNode(node.left, scope)) && truthy(evalNode(node.right, scope));
  if (op === "or") return truthy(evalNode(node.left, scope)) || truthy(evalNode(node.right, scope));

  const left = evalNode(node.left, scope);
  const right = evalNode(node.right, scope);
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
  const values: Value[] = [];
  for (const argument of args) values.push(evalNode(argument, scope));
  if (fn === "format") {
    const pattern = values[0];
    if (typeof pattern !== "string") return ABSENT;
    let index = 1;
    return pattern.replace(FORMAT_TOKEN, () => index < values.length ? toText(values[index++]!) : "%s");
  }

  for (let index = 0; index < values.length; index += 1) {
    const number = asNumber(values[index]!);
    if (number === ABSENT) return ABSENT;
    values[index] = number;
  }
  const numbers = values as number[];
  switch (fn) {
    case "abs": return numbers.length === 1 ? Math.abs(numbers[0]!) : ABSENT;
    case "round": return numbers.length === 1 ? Math.round(numbers[0]!) : ABSENT;
    case "min": return numbers.length > 0 ? Math.min(...numbers) : ABSENT;
    case "max": return numbers.length > 0 ? Math.max(...numbers) : ABSENT;
    case "clamp": return numbers.length === 3
      ? Math.min(Math.max(numbers[0]!, numbers[1]!), numbers[2]!)
      : ABSENT;
    default: return ABSENT;
  }
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
    || !writableRoots.has(String(result[0]))) return undefined;
  return result;
}

/** Parse-check an expression (syntax only). */
export function checkExpression(source: string): void {
  compileExpression(source);
}

/** Evaluate an expression against a scope. */
export function evaluate(source: string, scope: Scope): Value {
  return evalNode(compileExpression(source).ast, scope);
}

/** Evaluate a previously compiled expression without reparsing its source. */
export function evaluateCompiled(expression: CompiledExpression | ExpressionNode, scope: Scope): Value {
  return evalNode("ast" in expression ? expression.ast : expression, scope);
}

/** Escaped-text form: absence and null render as empty text. */
export function toText(value: Value): string {
  if (isAbsent(value)) return "";
  if (Array.isArray(value)) {
    let text = "";
    let separator = "";
    for (const item of value) {
      text += separator + toText(item);
      separator = " ";
    }
    return text;
  }
  if (typeof value === "object") return "";
  return String(value);
}

/** Serialize an ordinary bound attribute. */
export function toAttribute(value: Value): string | null {
  if (isAbsent(value) || value === false) return null;
  if (value === true) return "";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (Array.isArray(value)) return value.map(toText).join(" ");
  return null;
}
