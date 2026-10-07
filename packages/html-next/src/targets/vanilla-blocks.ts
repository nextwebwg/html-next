/**
 * The direct-extend Vanilla planner: components with a controller, declared state, `$if` and keyed
 * `$each` compile to cloned prototypes, compile-time site walks and fused, compare-before-write
 * updates. Every feature the live runtime supports is meant to reach this path; until one does, a
 * component that uses it returns undefined and keeps the general-runtime fallback, so it still
 * builds and behaves exactly as live. Each feature lowers on its own, so widening coverage adds
 * cases here without changing the generated shape of components already on the direct path.
 */

import { declaredExpressionType, declaredTypeAt, declareLayerTypes, declareTypes } from "../declared-types.js";
import {
  dimensionType,
  expressionFormattingType,
  mathArity,
  typeCheckedDependencies,
  type CompiledExpression,
  type ExpressionNode,
  type Scope as TypeScope,
} from "../expression.js";
import { conforms, type CompactType } from "../generated-runtime.js";
import { compileComponentStylesForBuild } from "../component-styles-build.js";
import { isUrlAttribute } from "../sanitize.js";
import { keyedEquality } from "../selection.js";
import { rootArms, type ComponentDefinition, type ElementNode, type TemplateNode } from "../template.js";
import { declarationTypeNode, formatType, type TypeNode } from "../type-system.js";

/** Item data, or anything reached through a controller facade, changed. */
const NESTED = 1 << 30;

/** Elements whose prototypes are not inert, or whose children the runtime manages itself. */
const EXCLUDED = new Set([
  "script", "template", "iframe", "object", "embed", "link", "style", "meta", "base", "noscript",
  "svg", "math",
]);
/** Parents whose option regions the live runtime re-synchronizes. */
const SELECTS = new Set(["select", "datalist", "optgroup"]);

interface Root {
  readonly name: string;
  readonly type: CompactType;
  /** JavaScript source for a fresh initial value. */
  readonly initial: string;
}

/** A lowered expression in the supported subset. */
interface Lowered {
  readonly source: string;
  /** Root bits read directly. */
  readonly bits: number;
  /** Reads data below a root (a member path or a converted container root): needs NESTED. */
  readonly nested: boolean;
  /** Reads the loop item: needs NESTED, which marks item data. */
  readonly item: boolean;
  /** The result is already a boolean, so truthiness needs no conversion. */
  readonly boolean: boolean;
  /** The result may be a list or object, whose conversion reads its contents. */
  readonly deep: boolean;
  /** A truthiness conversion inside reads the contents of a possible container from the item. */
  readonly contents: boolean;
  /** May evaluate to NONCONFORMING, which a binding then does not write. */
  readonly fails: boolean;
  /** Structural identity, so equal expressions in one update share an evaluation. */
  readonly key: string;
}

type BindingKind = "attribute" | "class" | "value" | "text";

interface Binding {
  readonly site: number;
  readonly kind: BindingKind;
  readonly name: string;
  readonly expression: Lowered;
  /** JavaScript source for the converted value the prototype already shows. */
  readonly initial: string;
}

interface Region {
  readonly kind: "if" | "each";
  /** The start anchor's site; the end anchor follows it in the prototype. */
  readonly site: number;
  readonly block: Block;
  readonly test?: Lowered;
  readonly list?: Lowered;
  readonly key?: Lowered;
  readonly alias?: string;
}

interface Block {
  readonly id: number;
  /** The prototype, as the JSON `buildTemplate` reads. */
  readonly spec: unknown;
  /** Child-index paths from the block's base node. */
  readonly sites: number[][];
  readonly bindings: Binding[];
  readonly regions: Region[];
  readonly row: boolean;
}

export interface BlockPlan {
  readonly roots: readonly Root[];
  readonly root: Block;
  readonly blocks: readonly Block[];
}

/** A feature the direct path does not cover yet; the component keeps the general-runtime fallback. */
class NotYetDirect extends Error {}

function notYetDirect(): never {
  throw new NotYetDirect();
}

/** The compact form of a declared type, or undefined for kinds the subset does not check yet. */
export function compactType(node: TypeNode): CompactType | undefined {
  switch (node.kind) {
    case "terminal": {
      const names: Readonly<Record<string, CompactType>> = {
        string: "s", boolean: "b", number: "n", integer: "i", null: "z", absent: "a", unknown: "?",
      };
      return names[node.name];
    }
    case "list": {
      const item = compactType(node.item);
      return item === undefined ? undefined : ["l", item];
    }
    case "record": {
      const value = compactType(node.value);
      return value === undefined ? undefined : ["r", value];
    }
    case "object": {
      const fields: unknown[] = [];
      for (const field of node.fields) {
        const type = compactType(field.type);
        if (type === undefined) return undefined;
        fields.push(field.name, type);
      }
      return node.open ? ["o", fields, 1] : ["o", fields];
    }
    case "union": {
      const members: CompactType[] = [];
      for (const member of node.members) {
        const type = compactType(member);
        if (type === undefined) return undefined;
        members.push(type);
      }
      return ["u", ...members];
    }
    case "constrained": {
      // A reference checks only the base. A null write would also check the constraints, so only
      // bases that reject null lower exactly.
      const base = compactType(node.base);
      return base === undefined || conforms(null, base) ? undefined : base;
    }
    default: return undefined;
  }
}

/** Whether values of `type` may be lists or objects, whose conversion reads their contents. */
function mayContain(type: CompactType): boolean {
  if (typeof type !== "object") return type === 0 || type === "?";
  return type[0] !== "u" || type.some((member, index) => index > 0 && mayContain(member as CompactType));
}

function numberSource(value: number): string {
  if (Number.isNaN(value)) return "Number.NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Source for a literal JSON-like value; objects and arrays are fresh at each evaluation. */
function valueSource(value: unknown): string {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return numberSource(value);
  if (Array.isArray(value)) return `[${value.map(valueSource).join(", ")}]`;
  return `{ ${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${JSON.stringify(key)}: ${valueSource(item)}`).join(", ")} }`;
}

/** The value of a literal initial-state expression; anything else is not direct yet. */
function literalValue(node: ExpressionNode): unknown {
  if (node.kind === "literal") {
    const value = node.value;
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    notYetDirect();
  }
  if (node.kind === "array") return node.items.map(literalValue);
  if (node.kind === "object") {
    const value: Record<string, unknown> = {};
    for (const pair of node.pairs) {
      // ponytail: the interpreter assigns `__proto__` through its setter; leave that to it.
      if (pair.key === "__proto__") notYetDirect();
      value[pair.key] = literalValue(pair.value);
    }
    return value;
  }
  notYetDirect();
}

interface Scope {
  readonly roots: readonly Root[];
  readonly alias: string | undefined;
  /** Declared types at build time, as the live scope answers them (`declareTypes`). */
  readonly types: TypeScope;
}

const ARITHMETIC = new Set(["+", "-", "*", "/"]);

/** Source for a build-time dimension, which the shared helpers test against `undefined`. */
const dimensionSource = (dimension: string | undefined): string => dimension === undefined ? "undefined" : JSON.stringify(dimension);
const MATH = new Set(["abs", "round", "min", "max", "clamp"]);
const FORMAT = new Set(["format", "formatRange", "formatParts"]);

/** Lowered reads with nothing read yet: literals, and the base other results extend. */
function none(key: string, source: string): Lowered {
  return { source, bits: 0, nested: false, item: false, boolean: false, deep: false, contents: false, fails: false, key };
}

function lower(node: ExpressionNode, scope: Scope): Lowered {
  const key = JSON.stringify(node);
  switch (node.kind) {
    case "literal": {
      const value = node.value;
      if (value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") notYetDirect();
      return { ...none(key, valueSource(value)), boolean: typeof value === "boolean" };
    }
    case "id": {
      if (node.name === scope.alias) return { ...none(key, "o"), item: true, deep: true };
      // A row's `loop` record shadows any root of that name; positions are not in this subset yet.
      if (scope.alias !== undefined && node.name === "loop") notYetDirect();
      const index = scope.roots.findIndex((root) => root.name === node.name);
      if (index < 0) notYetDirect();
      const root = scope.roots[index]!;
      // A boolean root is only ever a boolean once its initial value is one (an absent value is null).
      return {
        ...none(key, `v[${index}]`), bits: 1 << index,
        boolean: root.type === "b" && root.initial !== "null", deep: mayContain(root.type),
      };
    }
    case "member": {
      const object = lower(node.object, scope);
      return {
        ...object, key, boolean: false, deep: true,
        source: `${object.fails ? "readFailing" : "readMember"}(${object.source}, ${JSON.stringify(node.key)})`,
        // A read below a root follows that root's data; a read below the item is item data.
        nested: object.nested || !object.item && object.bits !== 0,
      };
    }
    case "index": {
      const object = lower(node.object, scope);
      const index = lower(node.index, scope);
      const both = merge(object, index);
      return {
        ...none(key, `readIndex(${object.source}, ${index.source})`), ...both, deep: true,
        nested: both.nested || !object.item && object.bits !== 0,
      };
    }
    case "unary": {
      if (node.op === "-") {
        const operand = lower(node.operand, scope);
        const dimension = dimensionType(node.operand, scope.types);
        return { ...operand, key, boolean: false, deep: false, source: `negate(${operand.source}, ${dimensionSource(dimension)})` };
      }
      const operand = truthiness(lower(node.operand, scope));
      return operand.fails
        ? { ...operand, source: `notValue(${operand.source})`, boolean: false, deep: false, key }
        : { ...operand, source: `!${operand.source}`, boolean: true, deep: false, key };
    }
    case "binary": {
      const left = lower(node.left, scope);
      const right = lower(node.right, scope);
      const fails = left.fails || right.fails;
      if (node.op === "and" || node.op === "or") {
        const a = truthiness(left);
        const b = truthiness(right);
        return fails
          ? { ...none(key, `logicValue(${node.op === "and"}, ${a.source}, ${b.source})`), ...merge(a, b), fails: true }
          : { ...none(key, `(${a.source} ${node.op === "and" ? "&&" : "||"} ${b.source})`), ...merge(a, b), boolean: true };
      }
      if ((node.op === "=" || node.op === "!=") && !fails) {
        // Identity comparison reads no contents, and both sides share the interpreter's ABSENT.
        return { ...none(key, `(${left.source} ${node.op === "=" ? "===" : "!=="} ${right.source})`), ...merge(left, right), boolean: true };
      }
      const arithmetic = ARITHMETIC.has(node.op);
      const leftDimension = arithmetic ? dimensionType(node.left, scope.types) : undefined;
      const rightDimension = arithmetic ? dimensionType(node.right, scope.types) : undefined;
      const dimensions = leftDimension === undefined && rightDimension === undefined ? ""
        : `, ${dimensionSource(leftDimension)}, ${dimensionSource(rightDimension)}`;
      return {
        ...none(key, `binaryValue(${JSON.stringify(node.op)}, ${left.source}, ${right.source}${dimensions})`),
        ...merge(left, right), fails: fails || dimensions !== "",
      };
    }
    case "conditional": {
      const test = truthiness(lower(node.test, scope));
      const consequent = lower(node.consequent, scope);
      const alternate = lower(node.alternate, scope);
      const both = merge(test, merge(consequent, alternate));
      return {
        ...none(key, test.fails
          ? `chooseValue(${test.source}, ${consequent.source}, ${alternate.source})`
          : `(${test.source} ? ${consequent.source} : ${alternate.source})`),
        ...both, boolean: consequent.boolean && alternate.boolean, deep: consequent.deep || alternate.deep,
      };
    }
    case "call": {
      const args = node.args.map((argument) => lower(argument, scope));
      const reads = args.reduce<Reads>((all, argument) => merge(all, argument), none(key, ""));
      if (node.fn === "default") {
        if (args.length !== 2) return { ...none(key, "NONCONFORMING"), fails: true };
        const [value, fallback] = args as [Lowered, Lowered];
        return {
          ...none(key, `defaultValue(${value.source}, ${fallback.source})`), ...reads,
          boolean: value.boolean && fallback.boolean, deep: value.deep || fallback.deep,
        };
      }
      // Text and formatting read a list's or object's contents, as a converting binding does.
      const values = (): string => `[${args.map(convertible).join(", ")}]`;
      const contents = args.reduce<Reads>((all, argument) => {
        const read = converted(argument);
        return merge(all, { ...read, contents: read.contents || itemContainer(argument) });
      }, none(key, ""));
      if (node.fn === "concat" || node.fn === "join") {
        return { ...none(key, `textCall(${JSON.stringify(node.fn)}, ${values()})`), ...contents, fails: true };
      }
      if (FORMAT.has(node.fn)) {
        const type = node.args.length === 0 ? undefined : expressionFormattingType(node.args[0]!, scope.types);
        return {
          ...none(key, `formatCall(${JSON.stringify(node.fn)}, ${values()}, ${dimensionSource(type)})`), ...contents,
          fails: true, deep: node.fn === "formatParts",
        };
      }
      if (!MATH.has(node.fn) || !mathArity(node.fn, args.length)) return { ...none(key, "NONCONFORMING"), fails: true };
      const dimension = dimensionType(node.args[0]!, scope.types);
      const dimensions = dimension === undefined ? "[]"
        : `[${node.args.map((argument) => dimensionSource(dimensionType(argument, scope.types))).join(", ")}]`;
      return {
        ...none(key, `mathCall(${JSON.stringify(node.fn)}, [${args.map((argument) => argument.source).join(", ")}], ${dimensionSource(dimension)}, ${dimensions})`),
        ...reads, fails: true,
      };
    }
    case "object": {
      const values = node.pairs.map((pair) => lower(pair.value, scope));
      const reads = values.reduce<Reads>((all, value) => merge(all, value), none(key, ""));
      const source = reads.fails
        ? `recordValue(${JSON.stringify(node.pairs.map((pair) => pair.key))}, [${values.map((value) => value.source).join(", ")}])`
        : `{ ${node.pairs.map((pair, index) => `${JSON.stringify(pair.key)}: ${values[index]!.source}`).join(", ")} }`;
      return { ...none(key, source), ...reads, deep: true };
    }
    case "array": {
      const items = node.items.map((item) => lower(item, scope));
      const reads = items.reduce<Reads>((all, item) => merge(all, item), none(key, ""));
      const list = `[${items.map((item) => item.source).join(", ")}]`;
      return { ...none(key, reads.fails ? `listValue(${list})` : list), ...reads, deep: true };
    }
  }
}

type Reads = Pick<Lowered, "bits" | "nested" | "item" | "contents" | "fails">;

function merge(left: Reads, right: Reads): Reads {
  return {
    bits: left.bits | right.bits, nested: left.nested || right.nested, item: left.item || right.item,
    contents: left.contents || right.contents, fails: left.fails || right.fails,
  };
}

/** Whether converting the value may read the contents of a list or object the row's item reached. */
function itemContainer(value: Lowered): boolean {
  return value.item && value.deep;
}

/** Source that converts `value`, flagging the row when an item-reached container is converted. */
function convertible(value: Lowered): string {
  return itemContainer(value) ? `trackContainer(r, ${value.source})` : value.source;
}

/** Applies the interpreter's truthiness; converting a possible container reads its contents. */
function truthiness(value: Lowered): Lowered {
  return value.boolean ? value : {
    ...converted(value), source: `${value.fails ? "truthyValue" : "truthy"}(${convertible(value)})`,
    boolean: !value.fails, deep: false, contents: value.contents || itemContainer(value),
  };
}

/** A conversion of a possible container depends on its contents, so it also follows NESTED. */
function converted(value: Lowered): Lowered {
  return { ...value, nested: value.nested || value.deep && !value.item };
}

function maskOf(value: Lowered): number {
  return value.bits | (value.nested || value.item ? NESTED : 0);
}

/** The mask of an outer-state sweep: what a row reads that is not its own item. */
function outerOf(value: Lowered): number {
  return value.bits | (value.nested ? NESTED : 0);
}

function compileRoots(definition: ComponentDefinition): Root[] {
  const declarations = definition.declarations ?? [];
  if (declarations.length === 0 || declarations.length > 30) notYetDirect();
  return declarations.map((declaration) => {
    if (declaration.kind !== "state") notYetDirect();
    const node = declarationTypeNode(declaration.type, declaration.shape);
    const type = node === undefined ? undefined : compactType(node);
    // A root that may be undefined makes the interpreter fail (HB001) where it is read.
    if (type === undefined || type === 0 || conforms(undefined, type)) notYetDirect();
    const initial = declaration.expression === undefined ? null : literalValue(declaration.expression.ast);
    // Initial values conform, so reads of a root never need the interpreter's reference check.
    if (initial !== null && !conforms(initial, type)) notYetDirect();
    return { name: declaration.name, type, initial: valueSource(initial) };
  });
}

/** A declared path's read (`readPath`): list items by index, `length`, and object keys. */
function pathSource(root: number, steps: readonly string[]): string {
  return steps.length === 0 ? `v[${root}]` : `readDeclared(v[${root}], ${JSON.stringify(steps)})`;
}

class Planner {
  readonly blocks: Block[] = [];
  readonly scope: Scope;

  constructor(readonly roots: readonly Root[], readonly definition: ComponentDefinition) {
    const types: TypeScope = { get: () => undefined };
    declareTypes(types, definition);
    this.scope = { roots, alias: undefined, types };
  }

  /**
   * Lowers an expression the live runtime evaluates with `evalConforming`: a declared path below a
   * root is checked against its own type first, and a failing one warns once and leaves the
   * expression nonconforming. A root's own value is checked on every write, so it always passes.
   */
  checked(plan: CompiledExpression, scope: Scope): Lowered {
    const value = lower(plan.ast, scope);
    let paths: readonly string[] = [];
    try { paths = typeCheckedDependencies(plan); } catch { /* evaluated as written */ }
    const checks: string[] = [];
    let reads: Reads = value;
    for (const path of paths) {
      const declared = declaredTypeAt(this.definition, path);
      if (declared === undefined) continue;
      const [name, ...steps] = path.split(".");
      const index = this.roots.findIndex((root) => root.name === name);
      if (index < 0) notYetDirect();
      if (steps.length === 0) continue;
      const type = compactType(declared);
      if (type === undefined) notYetDirect();
      checks.push(`checkReference(S, ${pathSource(index, steps)}, ${JSON.stringify(type)}, ${JSON.stringify(`expression:${plan.source}:${path}`)}, ${JSON.stringify(`Reference \`${path}\` must satisfy ${formatType(declared)}.`)})`);
      reads = merge(reads, { bits: 1 << index, nested: true, item: false, contents: false, fails: true });
    }
    if (checks.length === 0) return value;
    return { ...value, ...reads, source: `(${checks.join(" && ")} ? ${value.source} : NONCONFORMING)` };
  }

  block(element: ElementNode, row: boolean, scope: Scope, root: boolean): Block {
    const block: Block = { id: this.blocks.length, spec: undefined, sites: [], bindings: [], regions: [], row };
    this.blocks.push(block);
    const spec = this.element(block, element, [], scope, root);
    // The root's own element is the factory's; its children clone from a fragment.
    (block as { spec: unknown }).spec = root ? ["", [], ...spec.slice(2)] : spec;
    return block;
  }

  site(block: Block, path: readonly number[]): number {
    const key = path.join(".");
    const index = block.sites.findIndex((candidate) => candidate.join(".") === key);
    if (index >= 0) return index;
    block.sites.push([...path]);
    return block.sites.length - 1;
  }

  element(block: Block, node: ElementNode, path: readonly number[], scope: Scope, root: boolean): unknown[] {
    if (EXCLUDED.has(node.name) || node.name.includes("-") || node.ref !== undefined || (node.events?.length ?? 0) > 0) notYetDirect();
    const literals = node.attributes.filter((attribute) => attribute.kind === "literal");
    if (literals.some((attribute) => attribute.name === "is")) notYetDirect();
    const literal = (name: string): string | undefined =>
      literals.find((attribute) => attribute.name === name)?.value;
    let content: Lowered | undefined;
    const bound = new Set<string>();
    for (const attribute of node.attributes) {
      if (attribute.kind === "literal") continue;
      if (attribute.expressionPlan === undefined) notYetDirect();
      const expression = this.checked(attribute.expressionPlan, scope);
      if (attribute.kind === "directive") {
        if (attribute.name !== "value") notYetDirect();
        content = expression;
        continue;
      }
      if (attribute.kind !== "attribute" || attribute.twoWay === true || attribute.target === "style") notYetDirect();
      const site = this.site(block, path);
      if (attribute.target === "class") {
        bound.add("class:");
        // The root's invocation may carry the class, so its first evaluation always writes.
        const initial = root ? "undefined" : String((literal("class") ?? "").split(/\s+/).includes(attribute.name));
        block.bindings.push({ site, kind: "class", name: attribute.name, expression, initial });
        continue;
      }
      if (isUrlAttribute(attribute.name) || attribute.name === "data-component") notYetDirect();
      bound.add(attribute.name);
      const value = literal(attribute.name);
      block.bindings.push({
        site, kind: "attribute", name: attribute.name, expression,
        initial: root ? "undefined" : value === undefined ? "null" : JSON.stringify(value),
      });
    }
    // A bound class attribute would overwrite class toggles the update skips as unchanged.
    if (bound.has("class") && bound.has("class:")) notYetDirect();
    const spec: unknown[] = [node.name, literals.flatMap((attribute) => [attribute.name, attribute.value])];
    if (content !== undefined) {
      // `$value` replaces the element's content, so its authored children never render.
      block.bindings.push({ site: this.site(block, path), kind: "value", name: "", expression: content, initial: "undefined" });
      spec.push(0);
      return spec;
    }
    let index = 0;
    for (const child of node.children) {
      const item = this.child(block, node, child, [...path, index], scope);
      spec.push(item);
      // A region is an anchor pair, so the next child sits two nodes on.
      index += item === 1 || item === 2 ? 2 : 1;
    }
    return spec;
  }

  child(block: Block, parent: ElementNode, node: TemplateNode, path: number[], scope: Scope): unknown {
    if (node.kind === "slot") notYetDirect();
    if (node.kind === "text") {
      if (node.segments !== undefined) notYetDirect();
      if (node.expressionPlan === undefined) return node.value;
      const expression = this.checked(node.expressionPlan, scope);
      block.bindings.push({ site: this.site(block, path), kind: "text", name: "", expression, initial: '""' });
      return 0;
    }
    const flow = node.flow;
    if (flow === undefined) return this.element(block, node, path, scope, false);
    if (block.row || SELECTS.has(parent.name)) notYetDirect();
    const { flow: _flow, ...body } = node;
    const site = this.site(block, path);
    if (flow.kind === "if") {
      if (flow.testPlan === undefined) notYetDirect();
      const test = truthiness(this.checked(flow.testPlan, scope));
      // A test re-renders its body whenever its inputs change, as the live runtime does, so it
      // may read only roots it can name exactly.
      if (test.nested || test.item) notYetDirect();
      block.regions.push({ kind: "if", site, block: this.block(body, false, scope, false), test });
      return 1;
    }
    if (flow.kind !== "each" || flow.key === undefined || flow.keyPlan === undefined || flow.listPlan === undefined ||
      flow.index !== undefined || flow.where !== undefined || flow.sort !== undefined || flow.limit !== undefined ||
      flow.item === "loop" || this.roots.some((root) => root.name === flow.item)) notYetDirect();
    const list = this.checked(flow.listPlan, scope);
    const listType = declaredExpressionType(flow.listPlan, scope.types);
    const types: TypeScope = { get: () => undefined };
    declareLayerTypes(types, scope.types, { [flow.item]: listType?.kind === "list" ? listType.item : undefined });
    const rowScope: Scope = { roots: this.roots, alias: flow.item, types };
    const key = lower(flow.keyPlan.ast, rowScope);
    // A key is memoized per item, so it may read only the item, and never a container's contents.
    if (key.bits !== 0 || key.nested || key.contents) notYetDirect();
    if (list.item) notYetDirect();
    block.regions.push({ kind: "each", site, block: this.block(body, true, rowScope, false), list, key, alias: flow.item });
    return 2;
  }
}

/**
 * Plans a component for direct-extend emission, or returns undefined when it uses a feature the
 * subset does not cover yet (the caller keeps the general-runtime fallback).
 */
export function blockPlan(definition: ComponentDefinition): BlockPlan | undefined {
  try {
    if (definition.controller === undefined || Object.keys(definition.contract.props).length > 0 ||
      (definition.slots?.length ?? 0) > 0 || definition.root?.kind === "component" ||
      rootArms(definition.template) !== undefined || definition.template.flow !== undefined) return undefined;
    if (compileComponentStylesForBuild(definition.css, definition).stateNames.length > 0) return undefined;
    const roots = compileRoots(definition);
    const planner = new Planner(roots, definition);
    const root = planner.block(definition.template, false, planner.scope, true);
    return { roots, root, blocks: planner.blocks };
  } catch (error) {
    if (error instanceof NotYetDirect) return undefined;
    throw error;
  }
}

interface Trie {
  site?: number;
  readonly children: Map<number, Trie>;
}

/**
 * Emits `const` walks from `base` to every site with firstChild/nextSibling getters, naming only
 * the nodes later walks start from. Returns each site's expression.
 */
function walk(base: string, sites: readonly (readonly number[])[], lines: string[], prefix: string): string[] {
  const root: Trie = { children: new Map() };
  sites.forEach((path, index) => {
    let node = root;
    for (const step of path) {
      let next = node.children.get(step);
      if (next === undefined) node.children.set(step, next = { children: new Map() });
      node = next;
    }
    node.site = index;
  });
  const expressions: string[] = [];
  let count = 0;
  const visit = (expression: string, node: Trie): void => {
    if (node.site !== undefined) expressions[node.site] = expression;
    const steps = [...node.children.keys()].sort((left, right) => left - right);
    let previous: string | undefined;
    let previousStep = 0;
    steps.forEach((step, index) => {
      const child = node.children.get(step)!;
      const reached = previous === undefined
        ? `${expression}.firstChild${".nextSibling".repeat(step)}`
        : `${previous}${".nextSibling".repeat(step - previousStep)}`;
      const named = child.site !== undefined || child.children.size > 1 || index < steps.length - 1;
      let current = reached;
      if (named) {
        current = `${prefix}${count++}`;
        lines.push(`const ${current} = ${reached};`);
      }
      previous = current;
      previousStep = step;
      visit(current, child);
    });
  };
  visit(base, root);
  return expressions;
}

function guard(mask: number): string {
  return mask === 0 ? "c === -1" : `c & ${mask}`;
}

/** The binding's expression after the conversion its kind applies. */
function finalExpression(binding: Binding): Lowered {
  return binding.kind === "class" ? truthiness(binding.expression) : converted(binding.expression);
}

/** Whether a block's bindings convert a list or object its row's item reached (see `KeyedRow.w`). */
function tracks(block: Block): boolean {
  return block.bindings.some((binding) => binding.expression.contents || itemContainer(binding.expression));
}

/** Emits the direct-extend module for a plan from `blockPlan`. */
export function emitBlocks(
  plan: BlockPlan,
  definition: ComponentDefinition,
  version: string,
  rootLines: readonly string[],
): string {
  const { contract } = definition;
  const blocks = plan.blocks;
  const selectorRoot = (binding: Binding, region: Region): number => {
    if (binding.kind !== "class") return -1;
    const name = keyedEquality(JSON.parse(binding.expression.key), JSON.parse(region.key!.key), region.alias!);
    return plan.roots.findIndex((root) => root.name === name && !mayContain(root.type));
  };
  const selectors = (region: Region): number[] => [...new Set(region.block.bindings
    .map((binding) => selectorRoot(binding, region)).filter((index) => index >= 0))];
  const selected = [...new Set(blocks.flatMap((block) => block.regions
    .flatMap((region) => region.kind === "each" ? selectors(region) : [])))];
  const field = (block: Block, site: number): string =>
    block.sites[site]!.length === 0 ? "r.n" : `r.a${site}`;
  /** Record fields for a block: sites the patch writes, last values, and region state. */
  const fields = (block: Block, sites: readonly string[]): string[] => {
    const written = new Set(block.bindings.map((binding) => binding.site));
    const entries: string[] = [];
    sites.forEach((expression, site) => {
      if (written.has(site) && block.sites[site]!.length > 0) entries.push(`a${site}: ${expression}`);
    });
    if (tracks(block)) entries.push("w: 0");
    block.bindings.forEach((binding, index) => entries.push(`v${index}: ${binding.initial}`));
    block.regions.forEach((region, index) => {
      const start = sites[region.site]!;
      if (region.kind === "if") {
        entries.push(`a${region.site}: ${start}`, `e${index}: ${start}.nextSibling`, `b${index}: undefined`);
      } else {
        const child = region.block.id;
        entries.push(`L${index}: new KeyedList(${start}, ${start}.nextSibling, m${child}, p${child}, (o) => ${region.key!.source}, ${JSON.stringify(region.alias)})`);
      }
    });
    return entries;
  };
  /** The update body: guard groups in first-binding order, then regions. */
  const patch = (block: Block): string[] => {
    const lines: string[] = [];
    // One group per mask, except that writes to one element's attributes and classes keep their
    // authored order (it decides the order attributes and class tokens are created in).
    const groups: Array<{ readonly mask: number; readonly bindings: Binding[] }> = [];
    const ordered = (binding: Binding): boolean => binding.kind === "attribute" || binding.kind === "class";
    for (const binding of block.bindings) {
      const mask = maskOf(finalExpression(binding));
      const at = groups.findLastIndex((group) => group.mask === mask);
      const later = ordered(binding) && groups.slice(at + 1).some((group) =>
        group.bindings.some((other) => other.site === binding.site && ordered(other)));
      if (at < 0 || later) groups.push({ mask, bindings: [binding] });
      else groups[at]!.bindings.push(binding);
    }
    // Rows showing a container are flagged afresh whenever their item bindings all re-run.
    const reset = tracks(block);
    if (reset && groups[0]!.mask !== NESTED) lines.push(`  if (${guard(NESTED)}) r.w = 0;`);
    let temporary = 0;
    for (const { mask, bindings: group } of groups) {
      lines.push(`  if (${guard(mask)}) {`);
      if (reset && mask === NESTED && group === groups[0]!.bindings) lines.push("    r.w = 0;");
      const shared = new Map<string, string>();
      for (const binding of group) {
        let value = shared.get(binding.expression.key);
        if (value === undefined) {
          value = `x${temporary++}`;
          shared.set(binding.expression.key, value);
          // Every binding sharing an expression converts it, so an item-reached container is flagged here.
          lines.push(`    const ${value} = ${convertible(binding.expression)};`);
        }
        const index = block.bindings.indexOf(binding);
        const last = `r.v${index}`;
        const site = field(block, binding.site);
        const output = `s${index}`;
        // A nonconforming result leaves what the binding last wrote, as the live runtime does.
        const fails = finalExpression(binding).fails;
        if (fails) lines.push(`    if (${value} !== NONCONFORMING) {`);
        const start = lines.length;
        switch (binding.kind) {
          case "attribute":
            lines.push(`    const ${output} = toAttribute(${value}, ${JSON.stringify(binding.name)});`,
              `    if (${output} !== ${last}) writeAttribute(${site}, ${JSON.stringify(binding.name)}, ${last} = ${output});`);
            break;
          case "value":
            lines.push(`    const ${output} = toText(${value});`, `    if (${output} !== ${last}) writeText(${site}, ${last} = ${output});`);
            break;
          case "text":
            lines.push(`    const ${output} = toText(${value});`, `    if (${output} !== ${last}) ${site}.data = ${last} = ${output};`);
            break;
          case "class":
            lines.push(`    const ${output} = ${binding.expression.boolean ? value : `truthy(${value})`};`,
              `    if (${output} !== ${last}) ${site}.classList.toggle(${JSON.stringify(binding.name)}, ${last} = ${output});`);
            break;
        }
        if (fails) {
          for (let line = start; line < lines.length; line += 1) lines[line] = `  ${lines[line]}`;
          lines.push("    }");
        }
      }
      lines.push("  }");
    }
    block.regions.forEach((region, index) => {
      const child = region.block.id;
      if (region.kind === "if") {
        const test = region.test!;
        // A nonconforming test leaves the region as it is, and its body keeps updating.
        lines.push(test.fails
          ? `  let t${index};\n  if (${guard(maskOf(test))} && (t${index} = ${test.source}) !== NONCONFORMING) {`
          : `  if (${guard(maskOf(test))}) {`,
          `    r.b${index} = undefined;`,
          `    clearRegion(r.a${region.site}, r.e${index});`,
          `    if (${test.fails ? `t${index}` : test.source}) r.e${index}.before((r.b${index} = m${child}(d)).n);`,
          `  } else if (r.b${index} !== undefined) p${child}(r.b${index}, c, d);`,
        );
        return;
      }
      const list = region.list!;
      // A nonconforming list leaves the rows as they are.
      lines.push(list.fails
        ? `  if (${guard(maskOf(list) | NESTED)}) { const l = ${list.source}; if (l !== NONCONFORMING) r.L${index}.update(l, d, c); }`
        : `  if (${guard(maskOf(list) | NESTED)}) r.L${index}.update(${list.source}, d, c);`);
      const outer = region.block.bindings.reduce((mask, binding) => mask |
        (selectorRoot(binding, region) < 0 ? outerOf(finalExpression(binding)) : 0), 0);
      if (outer !== 0) lines.push(`  if (c !== -1 && c & ${outer}) r.L${index}.each(c);`);
      for (const root of selectors(region)) {
        lines.push(`  if (c !== -1 && c & ${1 << root}${outer === 0 ? "" : ` && !(c & ${outer})`}) visitSelected(r.L${index}.m, s${root}, v[${root}], p${child}, c);`);
      }
    });
    return lines;
  };

  const body: string[] = [];
  for (const block of blocks.slice(1)) {
    const lines: string[] = [];
    const sites = walk("n", block.sites, lines, "t");
    const entries = fields(block, sites);
    const reads = block.bindings.some((binding) => finalExpression(binding).item);
    if (block.row) {
      body.push(
        `  const m${block.id} = (o) => {`,
        `    const n = (P${block.id} ??= buildTemplate(T${block.id})).cloneNode(true);`,
        ...lines.map((line) => `    ${line}`),
        `    const r = { k: undefined, i: o, n, x: 0, y: 0${entries.map((entry) => `, ${entry}`).join("")} };`,
        `    p${block.id}(r, -1);`,
        "    return r;",
        "  };",
        `  const p${block.id} = (r, c) => {`,
        ...(reads ? ["    const o = r.i;"] : []),
        ...patch(block).map((line) => `  ${line}`),
        "  };",
      );
    } else {
      body.push(
        `  const m${block.id} = (d) => {`,
        `    const n = (P${block.id} ??= buildTemplate(T${block.id})).cloneNode(true);`,
        ...lines.map((line) => `    ${line}`),
        `    const r = { n${entries.map((entry) => `, ${entry}`).join("")} };`,
        `    p${block.id}(r, -1, d);`,
        "    return r;",
        "  };",
        `  const p${block.id} = (r, c, d) => {`,
        ...patch(block).map((line) => `  ${line}`),
        "  };",
      );
    }
  }
  const root = plan.root;
  const rootChildren = (root.spec as unknown[]).length > 2;
  const rootWalk: string[] = [];
  const rootSites = walk("element", root.sites, rootWalk, "t");
  const rootEntries = fields(root, rootSites);
  if (root.bindings.some((binding) => root.sites[binding.site]!.length === 0)) rootEntries.unshift("n: element");
  body.push(
    "  const p0 = (r, c, d) => {",
    ...patch(root).map((line) => `  ${line}`),
    ...selected.map((root) => `    s${root} = v[${root}];`),
    "  };",
    ...rootWalk.map((line) => `  ${line}`),
    `  const R = { ${rootEntries.join(", ")} };`,
    "  attachGeneratedController(element, S, v, (c, d) => p0(R, c, d), C);",
    "  return element;",
    "}",
  );
  const factory = [
    `export function create${contract.name}(options = {}) {`,
    "  const { attributes = {} } = options;",
    `  const element = document.createElement(${JSON.stringify(definition.template.name)});`,
    "  for (const [name, value] of Object.entries(attributes)) {",
    "    if (value === null || value === undefined || value === false) continue;",
    "    element.setAttribute(name, value === true ? \"\" : String(value));",
    "  }",
    ...rootLines,
    `  element.setAttribute("data-component", ${JSON.stringify(contract.tag)});`,
    ...(rootChildren ? ["  element.append((P0 ??= buildTemplate(T0)).cloneNode(true));"] : []),
    `  const v = [${plan.roots.map((item) => item.initial).join(", ")}];`,
    ...(selected.length === 0 ? [] : [`  let ${selected.map((root) => `s${root} = v[${root}]`).join(", ")};`]),
    ...body,
  ];
  const source = factory.join("\n");
  const helpers = ["attachGeneratedController", "binaryValue", "buildTemplate", "checkReference", "chooseValue", "clearRegion",
    "defaultValue", "formatCall", "KeyedList", "listValue", "logicValue", "mathCall", "negate", "NONCONFORMING", "notValue",
    "readDeclared", "readFailing", "readIndex", "readMember", "recordValue", "textCall", "toAttribute", "toText",
    "trackContainer", "truthy", "truthyValue", "visitSelected", "writeAttribute", "writeText"]
    .filter((name) => name === "attachGeneratedController" || new RegExp(`\\b${name}\\b`).test(source));
  const specs = blocks.flatMap((block) => block.id === 0 && !rootChildren ? [] : [`const T${block.id} = ${JSON.stringify(block.spec)};`]);
  const prototypes = blocks.filter((block) => block.id !== 0 || rootChildren).map((block) => `P${block.id}`);
  return [
    `// Generated by HTML Next ${version} for Vanilla DOM. Do not edit.`,
    `import { ${helpers.join(", ")} } from "@nextwebwg/html-next/generated-runtime";`,
    `import * as controller from ${JSON.stringify(definition.controller)};`,
    `import "../styles/${contract.tag}.css";`,
    "",
    ...specs,
    ...(prototypes.length === 0 ? [] : [`let ${prototypes.join(", ")};`]),
    `const S = { n: ${JSON.stringify(plan.roots.map((item) => item.name))}, t: ${JSON.stringify(plan.roots.map((item) => item.type))}, f: import.meta.url, g: ${JSON.stringify(contract.tag)} };`,
    // Only the default export is read, and only on first connect, so bundlers need no namespace object.
    "const C = (host) => controller.default(host);",
    "",
    source,
    "",
  ].join("\n");
}

/** @internal The lowered source of an expression (roots are `v[i]`, the item `o`), or undefined. */
export function lowerExpression(
  node: ExpressionNode,
  roots: readonly { readonly name: string; readonly type: CompactType }[],
  alias?: string,
): string | undefined {
  try {
    return lower(node, { roots: roots.map((root) => ({ ...root, initial: "undefined" })), alias, types: { get: () => undefined } }).source;
  } catch (error) {
    if (error instanceof NotYetDirect) return undefined;
    throw error;
  }
}
