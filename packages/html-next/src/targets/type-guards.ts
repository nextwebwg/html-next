import { typeCheckedDependencies, type CompiledExpression, type ExpressionNode, type WritablePathSegment } from "../expression.js";
import { declarationTypeNode, formatType, normalizeType, parseTypedValue, parseTypeExpression, typeAtKey, type TypeNode } from "../type-system.js";
import type { ComponentDefinition, HandlerDeclaration } from "../template.js";
import { quote } from "./shared.js";
import { conformingScalarStates, literalInitial } from "./state-roots.js";
import type { Lowering, Scope } from "./vue-lowering.js";

/** A JavaScript predicate for a declared type, used by generated event and handler code. */
export function typeCheck(type: TypeNode, value: string): string {
  switch (type.kind) {
    case "terminal":
      switch (type.name) {
        case "string": return `typeof ${value} === "string"`;
        case "boolean": return `typeof ${value} === "boolean"`;
        case "number": return `(typeof ${value} === "number" && Number.isFinite(${value}))`;
        case "integer": return `Number.isInteger(${value})`;
        case "null": return `${value} === null`;
        case "absent": return `${value} === undefined`;
        case "event": return `(() => { try { Object.getOwnPropertyDescriptor(Event.prototype, "type")!.get!.call(${value}); return true; } catch { return false; } })()`;
        case "function": return `typeof ${value} === "function"`;
        default: return "true";
      }
    case "keyword":
      return `${value} === ${JSON.stringify(type.value)}`;
    case "separated-list":
      return `(Array.isArray(${value}) && (${value} as unknown[]).every((item: unknown) => typeof item === "string"))`;
    case "union":
      return `(${type.members.map((member) => typeCheck(member, value)).join(" || ")})`;
    case "selected":
      return `(${type.options.map((option) => typeCheck(option.type, value)).join(" || ")})`;
    case "constrained":
      return type.values === undefined ? typeCheck(type.base, value)
        : `(${type.values.map((choice) => `${value} === ${JSON.stringify(choice)}`).join(" || ")})`;
    case "list":
      return `(Array.isArray(${value}) && (${value} as unknown[]).every((item: unknown) => ${typeCheck(type.item, "item")}))`;
    case "record":
      return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value}) && Object.values(${value} as object).every((item: unknown) => ${typeCheck(type.value, "item")}))`;
    case "object": {
      const fields = type.fields.map((field) => {
        const read = `(${value} as Record<string, unknown>)[${quote(field.name)}]`;
        const check = typeCheck(field.type, read);
        return field.optional ? `(${read} === undefined || ${check})` : check;
      });
      const closed = type.open ? [] : [`Object.keys(${value} as object).every((key) => ${JSON.stringify(type.fields.map((field) => field.name))}.includes(key))`];
      return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value})${[...fields, ...closed].map((check) => ` && ${check}`).join("")})`;
    }
  }
}

export type StrictTypePredicate = (type: TypeNode, value: string) => string;

/** Handler destinations check their immediate type; nested values keep their authored input. */
export function destinationTypeCheck(type: TypeNode, value: string, strict?: StrictTypePredicate): string {
  switch (type.kind) {
    case "list": return `Array.isArray(${value})`;
    case "record":
    case "object": return `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value}))`;
    case "union": return `(${type.members.map((member) => destinationTypeCheck(member, value, strict)).join(" || ")})`;
    case "selected": return `(${type.options.map((option) => destinationTypeCheck(option.type, value, strict)).join(" || ")})`;
    case "constrained": return destinationTypeCheck(type.base, value, strict);
    case "separated-list": return strict?.(type, value) ?? typeCheck(type, value);
    default:
      if (type.kind === "terminal" && !["string", "boolean", "number", "integer", "null", "absent", "function", "unknown"].includes(type.name)) {
        return strict?.(type, value) ?? typeCheck(type, value);
      }
      return typeCheck(type, value);
  }
}

export function handlerDestinationCheck(
  type: TypeNode | undefined,
  path: readonly WritablePathSegment[],
  index: number,
  value: string,
  scope: Scope,
  lowering: Lowering,
  strict?: StrictTypePredicate,
): string | undefined {
  if (type === undefined) return undefined;
  if (index === path.length) return destinationTypeCheck(type, value, strict);
  const segment = path[index]!;
  if (typeof segment !== "object") {
    return handlerDestinationCheck(typeAtKey(type, segment), path, index + 1, value, scope, lowering, strict);
  }
  if (type.kind === "list" || type.kind === "record") {
    return handlerDestinationCheck(type.kind === "list" ? type.item : type.value,
      path, index + 1, value, scope, lowering, strict);
  }
  if (type.kind === "constrained") {
    return handlerDestinationCheck(type.base, path, index, value, scope, lowering, strict);
  }
  if (type.kind === "union" || type.kind === "selected") {
    const members = type.kind === "union" ? type.members : type.options.map((option) => option.type);
    const checks = members.flatMap((member) => {
      const check = handlerDestinationCheck(member, path, index, value, scope, lowering, strict);
      return check === undefined ? [] : [check];
    });
    return checks.length === 0 ? undefined : `(${checks.join(" || ")})`;
  }
  if (type.kind !== "object") return undefined;
  const key = `String(${lowering.value(segment.expression, scope)})`;
  const checks = type.fields.map((field) => {
    const check = handlerDestinationCheck(field.type, path, index + 1, value, scope, lowering, strict) ?? "true";
    return `(${key} === ${quote(field.name)} && ${check})`;
  });
  if (type.open) checks.push(`!${JSON.stringify(type.fields.map((field) => field.name))}.includes(${key})`);
  return checks.length === 0 ? "false" : `(${checks.join(" || ")})`;
}

/** Declared types constrain expressions at the point each reference is read. */
export function declaredReferenceGuard(plan: CompiledExpression, scope: Scope, definition: ComponentDefinition, strict?: StrictTypePredicate, lowering?: Lowering): string | undefined {
  const checks = typeCheckedDependencies(plan).flatMap((path) => {
    const [root, ...steps] = path.split(".");
    const source = scope.code.get(root!);
    if (source === undefined) return [];
    // A declared path may intentionally name an absent field. The runtime checks that value at
    // read time, and generated TypeScript must not reject the component for testing that absence.
    const read = `(${source} as any)${steps.map((step) => `?.[${quote(step)}]`).join("")}`;
    const check = (initial: TypeNode, keys: readonly string[]): string[] => {
      let type: TypeNode | undefined = initial;
      for (const step of keys) {
        type = typeAtKey(type, step);
        if (type === undefined) return [];
      }
      const accepted = `(${read} == null || ${destinationTypeCheck(type, read, strict)})`;
      return [lowering?.authoredCheck(accepted, `${plan.source}:${path}`,
        `${definition.source.file}: HR007: Reference ${path} must satisfy ${formatType(type)}.`) ?? accepted];
    };
    const prop = definition.contract.props[root!];
    if (prop === undefined) {
      const declaration = definition.declarations?.find((entry) => entry.name === root);
      if (declaration?.kind === "state" || declaration?.kind === "computed") {
        // A conforming scalar state's own value is checked in full on every write, so reading it cannot fail.
        if (declaration.kind === "state" && steps.length === 0 && conformingScalarStates(definition).has(root!)) return [];
        const type = declarationTypeNode(declaration.type, declaration.shape);
        return type === undefined ? [] : check(type, steps);
      }
      if (declaration?.kind !== "data") return [];
      const [surface, ...keys] = steps;
      if (surface === "pending" || surface === "ok") return check({ kind: "terminal", name: "boolean" }, keys);
      if (surface !== "value" || declaration.type === undefined) return [];
      return check(declaration.type === "text" ? { kind: "terminal", name: "string" }
        : parseTypeExpression(declaration.type), keys);
    }
    const select = prop.select;
    if (select === undefined) return check(normalizeType(prop.type), steps);
    const selector = scope.code.get(select.from);
    if (selector === undefined) return [];
    const options = select.options.map((option) => {
      let type = option.type;
      for (const step of steps) {
        const next = typeAtKey(type, step);
        if (next === undefined) return `(${selector} === ${JSON.stringify(option.value)})`;
        type = next;
      }
      return `(${selector} === ${JSON.stringify(option.value)} && ${destinationTypeCheck(type, read, strict)})`;
    });
    return [`(${read} == null || (${options.join(" || ")}))`];
  });
  return checks.length === 0 ? undefined : checks.join(" && ");
}

type SetStep = Extract<HandlerDeclaration["steps"][number], { kind: "set" }>;

const SCALAR_TYPES = ["string", "number", "integer", "boolean"];

/** A state's declared scalar type name; undefined for any other type, or for a name that is no state. */
function scalarType(definition: ComponentDefinition, name: string): string | undefined {
  const declaration = definition.declarations?.find((entry) => entry.kind === "state" && entry.name === name);
  const node = declaration?.kind === "state" ? declarationTypeNode(declaration.type, declaration.shape) : undefined;
  return node?.kind === "terminal" && SCALAR_TYPES.includes(node.name) ? node.name : undefined;
}

/** `$state + n`, `n + $state` or `$state - n` over a safe integer literal `n`. */
function integerStep(node: ExpressionNode): { readonly state: string; readonly op: "+" | "-"; readonly amount: number } | undefined {
  if (node.kind !== "binary" || (node.op !== "+" && node.op !== "-")) return undefined;
  const [state, amount] = node.left.kind === "id" ? [node.left, node.right] : node.op === "+" ? [node.right, node.left] : [];
  if (state?.kind !== "id" || amount?.kind !== "literal" || amount.dimension !== undefined || !Number.isSafeInteger(amount.value)) return undefined;
  return { state: state.name, op: node.op, amount: amount.value as number };
}

const proofs = new WeakMap<ComponentDefinition, { readonly copyable: ReadonlySet<string>; readonly present: ReadonlySet<string> }>();

/**
 * The scalar states a proven write may read. A copyable state is never null: its initial value is a
 * conforming literal and every write is checked, which refuses null for a scalar type. Absence copies
 * as absence in every target. A present state is also never absent, so arithmetic on it is plain
 * arithmetic: no controller writes it, and every handler write to it is itself proven.
 */
function writeProofs(definition: ComponentDefinition): { readonly copyable: ReadonlySet<string>; readonly present: ReadonlySet<string> } {
  let known = proofs.get(definition);
  if (known !== undefined) return known;
  const copyable = new Set([...conformingScalarStates(definition)].filter((name) => {
    const declaration = definition.declarations!.find((entry) => entry.kind === "state" && entry.name === name);
    return declaration?.kind === "state" && declaration.expression !== undefined && literalInitial(declaration.expression.ast)?.value !== null;
  }));
  const writes = (definition.declarations ?? []).flatMap((entry) => entry.kind === "handler"
    ? entry.steps.filter((step): step is SetStep => step.kind === "set" && step.writablePath.length === 1) : []);
  // The largest set whose writes keep each member present, assuming the others stay present.
  let present: ReadonlySet<string> = definition.controller === undefined ? copyable : new Set();
  for (let size = -1; size !== present.size;) {
    size = present.size;
    const assumed = present;
    present = new Set([...assumed].filter((name) => writes.every((step) => step.writablePath[0] !== name ||
      provenValue(step, definition, assumed, assumed))));
  }
  proofs.set(definition, known = { copyable, present });
  return known;
}

function provenValue(step: SetStep, definition: ComponentDefinition, copyable: ReadonlySet<string>, present: ReadonlySet<string>): boolean {
  if (step.writablePath.length !== 1) return false;
  const declaration = definition.declarations?.find((entry) => entry.kind === "state" && entry.name === step.writablePath[0]);
  const node = declaration?.kind === "state" ? declarationTypeNode(declaration.type, declaration.shape) : undefined;
  if (node === undefined) return false;
  const value = step.value.ast;
  const literal = literalInitial(value);
  if (literal !== undefined) return literal.value !== null && parseTypedValue(literal.value, node, "$", "value").ok;
  const type = scalarType(definition, String(step.writablePath[0]));
  if (value.kind === "unary" && value.op === "not") return type === "boolean";
  if (value.kind === "id") {
    const source = scalarType(definition, value.name);
    return copyable.has(value.name) && (source === type || (source === "integer" && type === "number"));
  }
  // Integer arithmetic gives the same integer under any number semantics the proposal settles on;
  // `number` arithmetic may not, so it stays checked. A safe integer step cannot overflow to Infinity.
  const arithmetic = integerStep(value);
  return arithmetic !== undefined && (type === "integer" || type === "number") &&
    present.has(arithmetic.state) && scalarType(definition, arithmetic.state) === "integer";
}

/**
 * A handler step whose written value the converter proves satisfies its state's declared type, so
 * it writes plainly: a conforming literal, a negation into a boolean state, a copy of a same-typed
 * state, or an always-present integer state plus or minus a safe integer literal. The caller still
 * checks a value that may be an invalid result.
 */
export function provenWrite(step: SetStep, definition: ComponentDefinition): boolean {
  const { copyable, present } = writeProofs(definition);
  return provenValue(step, definition, copyable, present);
}

/** `$state ± n` written to that same state: the step's operator and amount. */
export function selfStep(step: SetStep): { readonly op: "+" | "-"; readonly amount: number } | undefined {
  const arithmetic = integerStep(step.value.ast);
  return arithmetic !== undefined && step.writablePath.length === 1 && arithmetic.state === step.writablePath[0] ? arithmetic : undefined;
}

/** `$state ± n` written to that same state, as `state++` or `state += n`. */
export function increment(step: SetStep, target: string): string | undefined {
  const self = selfStep(step);
  return self === undefined ? undefined : self.amount === 1 ? `${target}${self.op}${self.op}` : `${target} ${self.op}= ${self.amount}`;
}

/** A checked write's predicate and its authored location, as `write`'s trailing arguments. */
export function writeCheck(check: string | undefined, definition: ComponentDefinition, handler: HandlerDeclaration, step: SetStep): string {
  return check === undefined ? "" : `, ${writePredicate(check)}, ${quote(`${step.path} in ${definition.source.file}#${handler.name}`)}`;
}

/** The shared host's named predicates for scalar destinations; other types check inline. */
export const WRITE_PREDICATES: Readonly<Record<string, string>> = {
  'typeof value === "string"': "isString",
  '(typeof value === "number" && Number.isFinite(value))': "isNumber",
  "Number.isInteger(value)": "isInteger",
  'typeof value === "boolean"': "isBoolean",
};

export function writePredicate(check: string): string {
  return WRITE_PREDICATES[check] ?? `(value: any) => ${check}`;
}
