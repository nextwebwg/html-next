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
  compileExpression,
  dimensionType,
  expressionFormattingType,
  mathArity,
  typeCheckedDependencies,
  type CompiledExpression,
  type ExpressionNode,
  type Scope as TypeScope,
} from "../expression.js";
import type { CompactType } from "../generated-runtime.js";
import { compileComponentStylesForBuild } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import { foreignContent } from "parse5";

import { isUrlAttribute } from "../sanitize.js";
import { keyedEquality } from "../selection.js";
import { iteratedRefNames, rootArms, type ComponentDefinition, type ElementNode, type Flow, type TemplateNode } from "../template.js";
import type { WritablePath } from "../expression.js";
import { declarationTypeNode, formatType, normalizeType, parseTypedValue, typeAtKey, type TypeNode } from "../type-system.js";
import { kebabCase } from "../names.js";
import { runtimeProps } from "./shared.js";

/** Item data, or anything reached through a controller facade, changed. */
const NESTED = 1 << 30;
/** Roots from index 29 on share this bit; which of them changed is in the written map (`d`). */
const OVERFLOW = 1 << 29;

/** A root's change bit. */
const rootBit = (index: number): number => index < 29 ? 1 << index : OVERFLOW;

/** Elements whose children the live runtime manages itself (scoped slot and `$match` carriers). */
const EXCLUDED = new Set(["template"]);

/** A bound attribute's name on an SVG element, case-adjusted as the HTML parser adjusts it. */
function svgAttributeName(name: string): string {
  const token = { attrs: [{ name, value: "" }] };
  foreignContent.adjustTokenSVGAttrs(token as Parameters<typeof foreignContent.adjustTokenSVGAttrs>[0]);
  return token.attrs[0]!.name;
}

interface Root {
  readonly name: string;
  readonly type: CompactType;
  /** JavaScript source for a fresh initial value (`null` when an initializer computes it). */
  readonly initial: string;
  /** An initial-value expression the factory evaluates in declaration order, as live does. */
  readonly init?: CompiledExpression | undefined;
  /**
   * The value may not satisfy the declared type (an initializer, a nonconforming literal, a
   * computed), so expressions check the root itself where they read it, as `evalConforming` does.
   */
  readonly checked?: boolean;
  /** An untyped or `unknown` root may hold undefined, which its read fails with (HB001). */
  readonly undefinable?: boolean;
  /** A computed's expression; computeds follow the writable state roots. */
  readonly computed?: CompiledExpression | undefined;
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
  /** Reads the row's index or `loop` record. */
  readonly positional?: boolean;
  /** Roots from index 29 on that it reads, whose changes share the overflow bit. */
  readonly overflow?: readonly number[];
  /** Structural identity, so equal expressions in one update share an evaluation. */
  readonly key: string;
}

type BindingKind = "attribute" | "url" | "class" | "style" | "property" | "value" | "text" | "mixed" | "control" | "html" | "range" | "hoststate";

interface Binding {
  readonly site: number;
  readonly kind: BindingKind;
  readonly name: string;
  readonly expression: Lowered;
  /** JavaScript source for the converted value the prototype already shows. */
  readonly initial: string;
  /**
   * The name of the reads array of a binding that writes whenever what it read changed, as a live
   * effect re-runs, rather than when its converted output differs: property writes, and the class
   * attribute with the class toggles it overwrites.
   */
  readonly exact?: string | undefined;
  /** Mixed text: literal strings and lowered segments, joined in order. */
  readonly parts?: readonly (string | Lowered)[];
  /** A `<select>`'s bound value, re-applied once its options exist and whenever their regions change. */
  readonly select?: boolean;
  /** The select binding's value as `applySelection` evaluates it, without recording reads. */
  readonly apply?: Lowered;
  /** A two-way binding's destination: a function resolving its path, written by the control's listener. */
  readonly path?: string;
}

interface Region {
  readonly kind: "if" | "each" | "with" | "match";
  /** The start anchor's site; the end anchor follows it in the prototype. */
  readonly site: number;
  /** The body (`$if`, `$with`, `$each` rows); a `$match` has one per arm instead. */
  readonly block: Block;
  readonly arms?: readonly Block[];
  /**
   * What decides the body: an `$if` test, a `$with` value, or a `$match` selection (an arm index,
   * -1 for none, or NONCONFORMING), with the match value in `m` when it has one.
   */
  readonly test?: Lowered;
  /** The reads array of a decision that reads below a root or an item: it rebuilds only when they change. */
  readonly recorded?: string | undefined;
  readonly list?: Lowered;
  /** Keyed rows' key, or undefined for rows that follow positions. */
  readonly key?: Lowered | undefined;
  readonly alias?: string;
  /** Rows read their index or `loop`. */
  readonly positional?: boolean;
  /** `$match`: the matched expression, bound to its alias in the arms. */
  readonly matched?: Lowered | undefined;
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
  /** The prototype is built in the SVG namespace (its base element sits inside `<svg>`). */
  readonly svg: boolean;
  /** `on:` listeners: the site, the event, its handler's function name and the modifiers. */
  readonly events: { readonly site: number; readonly name: string; readonly handler: string; readonly modifiers: readonly string[] }[];
  /** `<select>` sites whose value bindings re-apply after their option regions change. */
  readonly selects: number[];
  /** `$ref` names recorded for a site; iterated ones (inside rows) collect into a list. */
  readonly refs: { readonly site: number; readonly name: string; readonly iterated: boolean }[];
  /** A row, or a `$with` or `$match` body: its record holds the item or alias value in `i`. */
  readonly alias: boolean;
  /** A row that reads its position: its record keeps its index and the row count. */
  positional?: boolean;
  readonly level: number;
  readonly parent: Block | undefined;
  /** A read below walks up through this block's record, which then links its parent's (`u`). */
  needsParent?: boolean;
}

/** Whether a block, or a region below it, listens: removing it must stop those listeners. */
function disposable(block: Block): boolean {
  return block.events.length > 0 ||
    block.regions.some((region) => [region.block, ...region.arms ?? []].some(disposable));
}

export interface BlockPlan {
  readonly roots: readonly Root[];
  readonly root: Block;
  readonly blocks: readonly Block[];
  /** Initializer statements, in declaration order. */
  readonly initializers: readonly string[];
  readonly handlers: readonly HandlerPlan[];
  /** Each computed root's index and lowered expression. */
  readonly computeds: readonly { readonly index: number; readonly source: string }[];
  /** How many roots are `<state>`, and how many the controller's host shows; props' roots follow them. */
  readonly states: number;
  readonly shown: number;
}

/** A feature the direct path does not cover yet; the component keeps the general-runtime fallback. */
class NotYetDirect extends Error {}

function notYetDirect(): never {
  throw new NotYetDirect();
}

/** A build-time stand-in for a check function, written into the module as `source`. */
interface CompactCheck { readonly js: string }

const FORMAT_CHECKS: Readonly<Record<string, string>> = {
  keyword: "keywordFormat", url: "urlFormat", email: "emailFormat", date: "dateFormat", month: "monthFormat",
  week: "weekFormat", time: "timeFormat", "datetime-local": "datetimeLocalFormat", datetime: "datetimeFormat",
  color: "colorFormat", "color-hex": "colorHexFormat", length: "lengthFormat", percentage: "percentageFormat",
  duration: "durationFormat",
};

/** Whether `parseTypedValue` accepts null for the type, decided once at build time. */
const nullAccepted = (node: TypeNode): boolean => parseTypedValue(null, node, "$", "value").ok;

/** The compact form of a declared type; kinds without a structure of their own check through a predicate. */
export function compactType(node: TypeNode): CompactType | undefined {
  switch (node.kind) {
    case "terminal": {
      const names: Readonly<Record<string, CompactType>> = {
        string: "s", boolean: "b", number: "n", integer: "i", null: "z", absent: "a", unknown: "?",
      };
      const plain = names[node.name];
      if (plain !== undefined) return plain;
      const format = FORMAT_CHECKS[node.name];
      const check: CompactCheck = format !== undefined ? { js: `formatOf(${format})` }
        : node.name === "function" ? { js: "isFunctionValue" }
        : node.name === "event" ? { js: "isNativeEvent" }
        : { js: `detailCheck(${JSON.stringify(node)})` };
      return ["p", check, nullAccepted(node)];
    }
    case "keyword": return ["k", node.value];
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
      // A reference checks only the base; a null write checks the constraints too, so a base
      // that accepts null carries whether the whole type does.
      const base = compactType(node.base);
      if (base === undefined) return undefined;
      return acceptsNullCompact(base) ? ["c", base, nullAccepted(node)] : base;
    }
    default:
      // A selected type depends on another declaration; a separated list checks its items.
      return ["p", { js: `detailCheck(${JSON.stringify(node)})` } satisfies CompactCheck, nullAccepted(node)];
  }
}

const acceptsNullCompact = (type: CompactType): boolean =>
  type === "?" || type === "z" || typeof type === "object" && (type[0] === "u" ? type.some((member, index) => index > 0 && acceptsNullCompact(member as CompactType))
    : (type[0] === "p" || type[0] === "c") && type[2] === true);

/** JavaScript for a compact type: JSON, with each predicate's check written as code. */
export function compactSource(type: unknown): string {
  if (Array.isArray(type)) return `[${type.map(compactSource).join(",")}]`;
  if (type !== null && typeof type === "object" && "js" in type) return (type as CompactCheck).js;
  return JSON.stringify(type);
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

/** A local name: a row's item, index or `loop` record, or a `$with`/`$match` alias. */
interface AliasEntry {
  readonly name: string;
  /** The level of the block whose record holds it. */
  readonly level: number;
  readonly kind: "item" | "index" | "loop";
  /** A variable that holds it where it is evaluated (a function's parameter), not the record chain. */
  readonly source?: string;
}

interface Scope {
  readonly roots: readonly Root[];
  /** Local names, innermost last. */
  readonly aliases: readonly AliasEntry[];
  /** The nesting level of the block an expression is evaluated in; the root block is 0. */
  readonly level: number;
  /** The block at `level`, whose ancestors keep a parent link when a read walks up to them. */
  readonly block?: Block | undefined;
  /** Evaluated in a function whose `o` is its own parameter, so the block's own item is `r.i`. */
  readonly closure?: boolean | undefined;
  /** Declared types at build time, as the live scope answers them (`declareTypes`). */
  readonly types: TypeScope;
  /** The reads array an exact binding records every value it reads into (see `Binding.exact`). */
  readonly record?: string | undefined;
  /** An initializer of root N: roots from N on, and computeds, still read null, as live sets them. */
  readonly initializing?: number | undefined;
  /** A handler step: `$$event` is the event being handled. */
  readonly event?: boolean | undefined;
  /** A computed root's lowered expression (reads, result flags). */
  readonly computed?: ((index: number) => Lowered) | undefined;
}

/** Where a local name's value is read from the block evaluating it. */
function aliasSource(scope: Scope, entry: AliasEntry): string {
  if (entry.source !== undefined) return entry.source;
  const up = scope.level - entry.level;
  // Every block between the reader and the holder keeps a link to its parent's record.
  for (let block = scope.block, step = 0; step < up && block !== undefined; step += 1, block = block.parent) block.needsParent = true;
  const record = `r${".u".repeat(up)}`;
  if (entry.kind === "index") return `${record}.j`;
  if (entry.kind === "loop") return `loopRecord(${record})`;
  return up === 0 && scope.closure !== true ? "o" : `${record}.i`;
}

/** A read, recorded when the binding is exact. */
const read = (scope: Scope, source: string): string => scope.record === undefined ? source : `rec(${scope.record}, ${source})`;

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
  // A recorded evaluation is never shared: its reads array is its own.
  const key = `${scope.record ?? ""}${JSON.stringify(node)}`;
  switch (node.kind) {
    case "literal": {
      const value = node.value;
      if (value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") notYetDirect();
      return { ...none(key, valueSource(value)), boolean: typeof value === "boolean" };
    }
    case "id": {
      // The innermost local of that name: an item, an index or a `loop` record, which follow positions.
      const entry = scope.aliases.findLast((candidate) => candidate.name === node.name);
      if (entry !== undefined) {
        const source = read(scope, aliasSource(scope, entry));
        return entry.kind === "index" ? { ...none(key, source), item: true, positional: true }
          : { ...none(key, source), item: true, deep: true, positional: entry.kind === "loop" };
      }
      if (node.name === "$$event" && scope.event === true) return { ...none(key, "e"), deep: true };
      const index = scope.roots.findIndex((root) => root.name === node.name);
      if (index < 0) notYetDirect();
      const root = scope.roots[index]!;
      if (scope.initializing !== undefined && (index >= scope.initializing || root.computed !== undefined)) return none(key, "null");
      if (root.computed !== undefined) {
        // A computed reads what its expression reads; its bindings recompute it lazily, as live does.
        const value = scope.computed!(index);
        return { ...value, key, item: false, source: read(scope, `g(${index})`) };
      }
      const source = root.undefinable === true ? `rootValue(v[${index}], ${JSON.stringify(root.name)})` : `v[${index}]`;
      // A boolean root is only ever a boolean once its initial value is one (an absent value is null).
      return {
        ...none(key, read(scope, source)), bits: rootBit(index), ...index >= 29 ? { overflow: [index] } : {},
        boolean: root.type === "b" && root.initial !== "null" && root.checked !== true, deep: mayContain(root.type),
      };
    }
    case "member": {
      const object = lower(node.object, scope);
      return {
        ...object, key, boolean: false, deep: true,
        source: read(scope, `${object.fails ? "readFailing" : "readMember"}(${object.source}, ${JSON.stringify(node.key)})`),
        // A read below a root follows that root's data; a read below the item is item data.
        nested: object.nested || !object.item && object.bits !== 0,
      };
    }
    case "index": {
      const object = lower(node.object, scope);
      const index = lower(node.index, scope);
      const both = merge(object, index);
      return {
        ...none(key, read(scope, `readIndex(${object.source}, ${index.source})`)), ...both, deep: true,
        nested: both.nested || !object.item && object.bits !== 0,
      };
    }
    case "unary": {
      if (node.op === "-") {
        const operand = lower(node.operand, scope);
        const dimension = dimensionType(node.operand, scope.types);
        return { ...operand, key, boolean: false, deep: false, source: `negate(${operand.source}, ${dimensionSource(dimension)})` };
      }
      const operand = truthiness(lower(node.operand, scope), scope.record);
      return operand.fails
        ? { ...operand, source: `notValue(${operand.source})`, boolean: false, deep: false, key }
        : { ...operand, source: `!${operand.source}`, boolean: true, deep: false, key };
    }
    case "binary": {
      const left = lower(node.left, scope);
      const right = lower(node.right, scope);
      const fails = left.fails || right.fails;
      if (node.op === "and" || node.op === "or") {
        const a = truthiness(left, scope.record);
        const b = truthiness(right, scope.record);
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
      const test = truthiness(lower(node.test, scope), scope.record);
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
      const values = (): string => `[${args.map((argument) =>
        scope.record !== undefined && argument.deep ? `recContents(${scope.record}, ${convertible(argument)})` : convertible(argument)).join(", ")}]`;
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

type Reads = Pick<Lowered, "bits" | "nested" | "item" | "contents" | "fails" | "positional" | "overflow">;

function merge(left: Reads, right: Reads): Reads {
  return {
    bits: left.bits | right.bits, nested: left.nested || right.nested, item: left.item || right.item,
    contents: left.contents || right.contents, fails: left.fails || right.fails,
    positional: left.positional === true || right.positional === true,
    ...left.overflow === undefined && right.overflow === undefined ? {}
      : { overflow: [...new Set([...left.overflow ?? [], ...right.overflow ?? []])] },
  };
}

/** The parameters a key function reads: its item, then its position and count, then the owner record. */
function keyParameters(source: string): string {
  return /\br\b/.test(source) ? "o, j, l, r" : /\b[jl]\b/.test(source) ? "o, j, l" : "o";
}

/** Whether a list's rows or key reach the record of the block holding it. */
function listOwned(region: Region): boolean {
  return region.block.needsParent === true || region.key !== undefined && /\br\b/.test(region.key.source);
}

/** Whether a row's bindings, or the regions below it (not nested rows), read its position. */
function readsPosition(block: Block): boolean {
  return block.bindings.some((binding) => binding.expression.positional === true ||
      binding.parts?.some((part) => typeof part !== "string" && part.positional === true) === true) ||
    block.regions.some((region) => region.test?.positional === true || region.list?.positional === true ||
      region.kind !== "each" && [region.block, ...region.arms ?? []].some(readsPosition));
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
function truthiness(value: Lowered, record?: string): Lowered {
  const operand = record !== undefined && value.deep ? `recLength(${record}, ${convertible(value)})` : convertible(value);
  return value.boolean ? value : {
    ...converted(value), source: `${value.fails ? "truthyValue" : "truthy"}(${operand})`,
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

/** The value of a literal initializer, or undefined for one that needs evaluating. */
function literalInitial(node: ExpressionNode): { readonly value: unknown } | undefined {
  try { return { value: literalValue(node) }; }
  catch (error) {
    if (error instanceof NotYetDirect) return undefined;
    throw error;
  }
}

/** Roots a two-way binding writes: a control's value is stored unchecked, as live stores it. */
function twoWayRoots(definition: ComponentDefinition): Set<string> {
  const names = new Set<string>();
  const visit = (node: TemplateNode): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") {
      node.fallback?.forEach(visit);
      return;
    }
    for (const attribute of node.attributes) {
      if (attribute.kind === "attribute" && attribute.twoWay === true && typeof attribute.writablePath?.[0] === "string") {
        names.add(attribute.writablePath[0]);
      }
    }
    node.children.forEach(visit);
  };
  visit(definition.template);
  return names;
}

function compileRoots(definition: ComponentDefinition): Root[] {
  const declarations = definition.declarations ?? [];
  const controlled = twoWayRoots(definition);
  const states: Root[] = [];
  const computeds: Root[] = [];
  for (const declaration of declarations) {
    if (declaration.kind === "handler" || declaration.kind === "event") continue;
    if (declaration.kind !== "state" && declaration.kind !== "computed") notYetDirect();
    const node = declarationTypeNode(declaration.type, declaration.shape);
    // An untyped root says nothing about its value, so it may also hold undefined.
    const type = node === undefined ? "?" : compactType(node);
    if (type === undefined) notYetDirect();
    const undefinable = node === undefined || parseTypedValue(undefined, node, "$", "value").ok;
    if (declaration.kind === "computed") {
      computeds.push({ name: declaration.name, type, initial: "undefined", computed: declaration.expression, checked: node !== undefined });
      continue;
    }
    const literal = declaration.expression === undefined ? { value: null } : literalInitial(declaration.expression.ast);
    if (literal === undefined) {
      states.push({ name: declaration.name, type, initial: "null", init: declaration.expression, checked: node !== undefined, undefinable });
      continue;
    }
    // A literal that conforms keeps every read of the root free of the reference check.
    const conforming = literal.value === null || node === undefined || parseTypedValue(literal.value, node, "$", "value").ok;
    states.push({
      name: declaration.name, type, initial: valueSource(literal.value), undefinable,
      checked: (!conforming || controlled.has(declaration.name)) && node !== undefined,
    });
  }
  // Props follow, read-only: an accepted value always satisfies its type, so reads need no check.
  const props: Root[] = Object.entries(definition.contract.props).map(([name, prop]) => {
    // A select prop's type follows its selector, so every read checks it against the current choice.
    if (prop.select !== undefined) return { name, type: "?", initial: "null", checked: true };
    const type = compactType(normalizeType(prop.type));
    if (type === undefined) notYetDirect();
    return { name, type, initial: "null" };
  });
  return [...states, ...computeds, ...props];
}


interface HandlerPlan {
  readonly name: string;
  readonly lines: readonly string[];
}

class Planner {
  readonly blocks: Block[] = [];
  readonly scope: Scope;
  private recordings = 0;
  private readonly computeds = new Map<number, Lowered>();
  private readonly computing = new Set<number>();
  /** Initializer statements, in declaration order. */
  readonly initializers: string[] = [];
  readonly handlers = new Map<string, HandlerPlan>();

  constructor(readonly roots: readonly Root[], readonly definition: ComponentDefinition) {
    const types: TypeScope = { get: () => undefined };
    declareTypes(types, definition);
    this.scope = { roots, aliases: [], level: 0, types, computed: (index) => this.computedLowered(index) };
    roots.forEach((root, index) => {
      // Live evaluates initializers with `evalValue`, without reference checks.
      if (root.init !== undefined) this.initializers.push(`  v[${index}] = ${lower(root.init.ast, { ...this.scope, initializing: index }).source};`);
    });
  }

  /** A computed's lowered expression; a cycle reads nothing more and fails HR006 when it computes. */
  computedLowered(index: number): Lowered {
    const known = this.computeds.get(index);
    if (known !== undefined) return known;
    if (this.computing.has(index)) return none(`computed:${index}`, "undefined");
    this.computing.add(index);
    try {
      const expression = this.roots[index]!.computed;
      const value = expression === undefined ? none(`computed:${index}`, "null") : this.checked(expression, this.scope);
      this.computeds.set(index, value);
      return value;
    } finally { this.computing.delete(index); }
  }

  /** Compiles a handler's steps once, as `runHandler` runs them: `(e) => { … }`. */
  handler(name: string): HandlerPlan {
    const known = this.handlers.get(name);
    if (known !== undefined) return known;
    const declaration = (this.definition.declarations ?? []).find((candidate) => candidate.kind === "handler" && candidate.name === name);
    if (declaration?.kind !== "handler") notYetDirect();
    const scope: Scope = { ...this.scope, event: true };
    const lines: string[] = [];
    const events = this.definition.declarations ?? [];
    for (const step of declaration.steps) {
      const body: string[] = [];
      if (step.kind === "set") {
        const value = this.checked(step.value, scope);
        const segments = step.writablePath.map((segment) => typeof segment === "object"
          ? lower(segment.expression, scope).source : JSON.stringify(segment));
        const dynamic = step.writablePath.some((segment) => typeof segment === "object");
        body.push(`const x = ${value.source};`);
        const write = `setState(I, p, x, ${JSON.stringify(`handler:${name}:${step.path}`)}, ${JSON.stringify(step.path)});`;
        const resolved = dynamic ? "if (p.every((k) => typeof k === \"string\" || typeof k === \"number\")) " : "";
        body.push(value.fails ? `if (x !== NONCONFORMING) { const p = [${segments.join(", ")}]; ${resolved}${write} }`
          : `const p = [${segments.join(", ")}]; ${resolved}${write}`);
      } else if (step.kind === "dispatch") {
        const detail = step.value === undefined ? undefined : this.checked(step.value, scope);
        const declared = events.find((candidate) => candidate.kind === "event" && candidate.name === step.event);
        const target = step.target === undefined ? "element" : `refTargets(I.r[${JSON.stringify(step.target)}])`;
        body.push(`const x = ${detail === undefined ? "undefined" : detail.source};`);
        const dispatch = `dispatchDeclared(${target}, ${JSON.stringify(step.event)}, x, S.d?.[${JSON.stringify(step.event)}]);`;
        body.push(detail?.fails === true ? `if (x !== NONCONFORMING) ${dispatch}` : dispatch);
        void declared;
      } else {
        const target = `I.r[${JSON.stringify(step.target)}]`;
        body.push(`const t = ${target}; const x = Array.isArray(t) ? t[0] : t;`,
          step.kind === "focus" ? "x?.focus();" : "x?.reportValidity?.();");
      }
      if (step.guard === undefined) lines.push(`    { ${body.join(" ")} }`);
      else {
        const guard = this.checked(step.guard, scope);
        lines.push(`    { const q = ${guard.source}; if (q !== NONCONFORMING && truthy(q)) { ${body.join(" ")} } }`);
      }
    }
    const plan = { name: `h${this.handlers.size}`, lines };
    this.handlers.set(name, plan);
    return plan;
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
      const root = this.roots[index]!;
      const key = JSON.stringify(`expression:${plan.source}:${path}`);
      const select = this.definition.contract.props[name!]?.select;
      /** The check of a read: a select prop's against the type its selector's current value chooses. */
      const check = (read: string): string => {
        if (select === undefined) {
          const type = compactType(declared);
          if (type === undefined) notYetDirect();
          return `checkReference(S, ${read}, ${compactSource(type)}, ${key}, ${JSON.stringify(`Reference \`${path}\` must satisfy ${formatType(declared)}.`)})`;
        }
        const from = this.roots.findIndex((candidate) => candidate.name === select.from);
        if (from < 0) notYetDirect();
        reads = merge(reads, { bits: rootBit(from), nested: false, item: false, contents: false, fails: true, ...from >= 29 ? { overflow: [from] } : {} });
        const choice = (type: TypeNode | undefined): string => {
          for (const step of steps) type = type === undefined ? undefined : typeAtKey(type, step);
          if (type === undefined) return "0, \"\"";
          const compact = compactType(type);
          if (compact === undefined) notYetDirect();
          return `${compactSource(compact)}, ${JSON.stringify(`Reference \`${path}\` must satisfy ${formatType(type)}.`)}`;
        };
        // The last choice is the one no option matches, or a null selector: the null type.
        const options = [...select.options.map((option) => `[${JSON.stringify(option.value)}, ${choice(normalizeType(option.type))}]`),
          `[null, ${choice({ kind: "terminal", name: "null" })}]`];
        return `checkSelected(S, ${read}, v[${from}], [${options.join(", ")}], ${key})`;
      };
      // A local that shadows a root is still checked against the root's declared type, as live does.
      const shadow = scope.aliases.findLast((candidate) => candidate.name === name);
      if (shadow !== undefined) {
        const local = aliasSource(scope, shadow);
        const localRead = steps.length === 0 ? local : `readDeclared(${local}, ${JSON.stringify(steps)}${scope.record === undefined ? "" : `, ${scope.record}`})`;
        checks.push(check(scope.record === undefined ? localRead : `rec(${scope.record}, ${localRead})`));
        reads = merge(reads, { bits: 0, nested: false, item: true, contents: false, fails: true });
        continue;
      }
      // A state root's own value is checked on every write, unless its initial value may not conform.
      if (steps.length === 0 && root.checked !== true) continue;
      const base = root.computed === undefined ? `v[${index}]` : `g(${index})`;
      const declaredRead = scope.record === undefined
        ? steps.length === 0 ? base : `readDeclared(${base}, ${JSON.stringify(steps)})`
        : `rec(${scope.record}, readDeclared(${base}, ${JSON.stringify(steps)}, ${scope.record}))`;
      checks.push(check(declaredRead));
      const rootReads: Reads = root.computed === undefined
        ? { bits: rootBit(index), nested: steps.length > 0, item: false, contents: false, fails: true, ...index >= 29 ? { overflow: [index] } : {} }
        : this.computedLowered(index);
      reads = merge(reads, { ...rootReads, item: false, contents: false, fails: true });
    }
    if (checks.length === 0) return value;
    return { ...value, ...reads, source: `(${checks.join(" && ")} ? ${value.source} : NONCONFORMING)` };
  }

  /**
   * A two-way destination, resolved when the control reports as `setWritablePath` resolves it: an
   * outer local's object, or a root's name, then each key; an index that is not a string or number
   * writes nothing. It runs in the control's listener, where the block's own item is `r.i`.
   */
  writable(path: WritablePath, scope: Scope): string {
    const closure: Scope = { ...scope, closure: true };
    const [root, ...steps] = path;
    const local = scope.aliases.findLast((alias) => alias.name === root);
    const first = local === undefined ? JSON.stringify(root) : aliasSource(closure, local);
    const keys = steps.map((step) => typeof step === "object" ? lower(step.expression, closure).source : JSON.stringify(step));
    const dynamic = steps.some((step) => typeof step === "object");
    return `() => { const p = [${[first, ...keys].join(", ")}]; return ${dynamic
      ? 'p.every((k, i) => i === 0 || typeof k === "string" || typeof k === "number") ? p : undefined' : "p"}; }`;
  }

  /** A fresh reads array name for an exact binding. */
  recording(scope: Scope): Scope {
    return { ...scope, record: `f${this.recordings++}` };
  }

  block(element: ElementNode, row: boolean, outer: Scope, root: boolean, svg: boolean, alias = row): Block {
    // The root's prototype is a fragment of its children, which are SVG when the root is `<svg>`;
    // a `<template>` body is a fragment of its children too.
    const fragment = root || element.name === "template";
    const block: Block = {
      id: this.blocks.length, spec: undefined, sites: [], bindings: [], regions: [], row,
      svg: root ? element.name === "svg" : svg, events: [], refs: [], selects: [], alias, level: outer.level, parent: root ? undefined : outer.block,
    };
    this.blocks.push(block);
    const scope: Scope = { ...outer, block };
    if (fragment && !root) {
      if (row) notYetDirect();
      const spec: unknown[] = ["", []];
      spec.push(...this.children(block, element, element.children, [], 0, scope, svg));
      (block as { spec: unknown }).spec = spec;
      return block;
    }
    const spec = this.element(block, element, [], scope, root, svg);
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

  element(block: Block, node: ElementNode, path: readonly number[], scope: Scope, root: boolean, parentSvg: boolean): unknown[] {
    if (EXCLUDED.has(node.name) || node.name.includes("-")) notYetDirect();
    if (node.ref !== undefined) {
      block.refs.push({ site: this.site(block, path), name: node.ref, iterated: iteratedRefNames(this.definition).has(node.ref) });
    }
    for (const event of node.events ?? []) {
      block.events.push({ site: this.site(block, path), name: event.name, handler: this.handler(event.handler).name, modifiers: event.modifiers });
    }
    const literals = node.attributes.filter((attribute) => attribute.kind === "literal");
    if (literals.some((attribute) => attribute.name === "is")) notYetDirect();
    const svg = parentSvg || node.name === "svg";
    const literal = (name: string): string | undefined =>
      literals.find((attribute) => attribute.name === name)?.value;
    // A bound class attribute overwrites the class toggles, which then stay overwritten until their
    // own inputs change, so on such an element both write exactly when their reads change.
    const classOverwrites = node.attributes.some((attribute) => attribute.kind === "attribute" && attribute.target === undefined &&
      attribute.name === "class") && node.attributes.some((attribute) => attribute.kind === "attribute" && attribute.target === "class");
    let content: Lowered | undefined;
    let html: { readonly expression: Lowered; readonly record: string | undefined } | undefined;
    const selectValue = (name: string): boolean => node.name === "select" && name === "value";
    for (const attribute of node.attributes) {
      if (attribute.kind === "literal") continue;
      if (attribute.expressionPlan === undefined) notYetDirect();
      const exact = attribute.kind === "property" || attribute.kind === "directive" && attribute.name === "html" ||
        attribute.kind === "attribute" && attribute.twoWay === true ||
        classOverwrites && attribute.kind === "attribute" && (attribute.target === "class" || attribute.target === undefined && attribute.name === "class");
      const bindingScope = exact ? this.recording(scope) : scope;
      const expression = this.checked(attribute.expressionPlan, bindingScope);
      if (attribute.kind === "directive") {
        if (attribute.name === "html") html = { expression, record: bindingScope.record };
        else content = expression;
        continue;
      }
      const site = this.site(block, path);
      if (attribute.kind === "property") {
        block.bindings.push({
          site, kind: "property", name: attribute.name, expression, initial: "undefined", exact: bindingScope.record, select: selectValue(attribute.name),
          ...selectValue(attribute.name) ? { apply: this.checked(attribute.expressionPlan, { ...scope, closure: true }) } : {},
        });
        continue;
      }
      if (attribute.twoWay === true) {
        if (attribute.writablePath === undefined || attribute.writablePath.length < 2 && scope.aliases.some((alias) => alias.name === attribute.writablePath![0])) notYetDirect();
        block.bindings.push({
          site, kind: "control", name: svg ? svgAttributeName(attribute.name) : attribute.name, expression, initial: "undefined",
          exact: bindingScope.record, select: selectValue(attribute.name), path: this.writable(attribute.writablePath, scope),
          ...selectValue(attribute.name) ? { apply: this.checked(attribute.expressionPlan, { ...scope, closure: true }) } : {},
        });
        continue;
      }
      if (attribute.target === "class") {
        // The root's invocation may carry the class, so its first evaluation always writes.
        const initial = root ? "undefined" : String((literal("class") ?? "").split(/\s+/).includes(attribute.name));
        block.bindings.push({ site, kind: "class", name: attribute.name, expression, initial, exact: bindingScope.record });
        continue;
      }
      if (attribute.target === "style") {
        block.bindings.push({ site, kind: "style", name: attribute.name, expression, initial: "undefined" });
        continue;
      }
      const name = svg ? svgAttributeName(attribute.name) : attribute.name;
      const value = literal(attribute.name);
      block.bindings.push({
        site, kind: isUrlAttribute(name) ? "url" : "attribute", name, expression, exact: bindingScope.record,
        initial: root || bindingScope.record !== undefined ? "undefined" : value === undefined ? "null" : JSON.stringify(value),
      });
    }
    const spec: unknown[] = [node.name, literals.flatMap((attribute) => [attribute.name, attribute.value])];
    if (html !== undefined) {
      // `$html` replaces the element's content with sanitized markup whenever what it read changes.
      block.bindings.push({ site: this.site(block, path), kind: "html", name: "", expression: html.expression, initial: "undefined", exact: html.record });
      return spec;
    }
    if (content !== undefined) {
      // `$value` replaces the element's content, so its authored children never render.
      block.bindings.push({ site: this.site(block, path), kind: "value", name: "", expression: content, initial: "undefined" });
      spec.push(0);
      return spec;
    }
    spec.push(...this.children(block, node, node.children, path, 0, scope, svg && node.name !== "foreignObject"));
    if (node.name === "select" && block.bindings.some((binding) => binding.site === this.site(block, path) && binding.select === true)) {
      block.selects.push(this.site(block, path));
    }
    return spec;
  }

  /**
   * Plans children from position `start` under `path`. A `<template>` without a flow is a fragment
   * carrier: its children take its place (`$value` a text node, `$html` a range of its own).
   */
  children(block: Block, parent: ElementNode, nodes: readonly TemplateNode[], path: readonly number[], start: number, scope: Scope, svg: boolean): unknown[] {
    const items: unknown[] = [];
    let index = start;
    for (const child of nodes) {
      const planned = child.kind === "element" && child.name === "template" && child.flow === undefined
        ? this.carrier(block, child, path, index, scope, svg)
        : [this.child(block, parent, child, [...path, index], scope, svg)];
      for (const item of planned) {
        items.push(item);
        // A region is an anchor pair, so the next child sits two nodes on.
        index += item === 1 || item === 2 || item === 3 ? 2 : 1;
      }
    }
    return items;
  }

  carrier(block: Block, node: ElementNode, path: readonly number[], index: number, scope: Scope, svg: boolean): unknown[] {
    if (node.attributes.some((attribute) => attribute.kind === "literal" && attribute.name === "slot")) notYetDirect();
    const directive = node.attributes.find((attribute) => attribute.kind === "directive");
    if (directive?.kind === "directive" && directive.expressionPlan !== undefined) {
      const site = this.site(block, [...path, index]);
      if (directive.name === "value") {
        block.bindings.push({ site, kind: "text", name: "", expression: this.checked(directive.expressionPlan, scope), initial: '""' });
        return [0];
      }
      const recording = this.recording(scope);
      block.bindings.push({ site, kind: "range", name: "", expression: this.checked(directive.expressionPlan, recording), initial: "undefined", exact: recording.record });
      return [3];
    }
    return this.children(block, node, node.children, path, index, scope, svg);
  }

  child(block: Block, parent: ElementNode, node: TemplateNode, path: number[], scope: Scope, svg: boolean): unknown {
    if (node.kind === "slot") notYetDirect();
    if (node.kind === "text") {
      if (node.segments !== undefined) {
        const parts = node.segments.map((segment) => segment.expressionPlan === undefined ? segment.value : this.checked(segment.expressionPlan, scope));
        const reads = parts.reduce<Reads>((all, part) => typeof part === "string" ? all
          : merge(all, { ...converted(part), contents: part.contents || itemContainer(part) }), none("", ""));
        block.bindings.push({
          site: this.site(block, path), kind: "mixed", name: "", initial: '""', parts,
          expression: { ...none(JSON.stringify(node.segments), ""), ...reads, deep: false },
        });
        return 0;
      }
      if (node.expressionPlan === undefined) return node.value;
      const expression = this.checked(node.expressionPlan, scope);
      block.bindings.push({ site: this.site(block, path), kind: "text", name: "", expression, initial: '""' });
      return 0;
    }
    const flow = node.flow;
    // Outside a `$match`, a `$when` or `$else` marker is ignored and the element renders as written.
    if (flow === undefined || flow.kind === "when" || flow.kind === "else") {
      const { flow: _ignored, ...plain } = node;
      return this.element(block, plain, path, scope, false, svg);
    }
    const { flow: _flow, ...body } = node;
    const site = this.site(block, path);
    const plan = (compiled: CompiledExpression | undefined, source: string): CompiledExpression => compiled ?? compileExpression(source);
    /** A decision rebuilds its body whenever what it read changes, as its live effect re-runs. */
    const decide = (lowerDecision: (decisionScope: Scope) => Lowered): { test: Lowered; recorded: string | undefined } => {
      const exact = lowerDecision(scope);
      // A decision that reads only roots rebuilds on their change bits, which are exactly live's notifications.
      if (!exact.nested && !exact.item) return { test: exact, recorded: undefined };
      const recording = this.recording(scope);
      return { test: lowerDecision(recording), recorded: recording.record };
    };
    if (node.name === "template" && flow.kind !== "match" && flow.kind !== "if" && flow.kind !== "with") notYetDirect();
    const inner: Scope = { ...scope, level: scope.level + 1 };
    if (flow.kind === "if") {
      const { test, recorded } = decide((decisionScope) => truthiness(this.checked(plan(flow.testPlan, flow.test), decisionScope), decisionScope.record));
      block.regions.push({ kind: "if", site, block: this.block(body, false, inner, false, svg, false), test, recorded });
      return 1;
    }
    if (flow.kind === "with") {
      const expression = plan(flow.expressionPlan, flow.expr);
      const { test, recorded } = decide((decisionScope) => this.checked(expression, decisionScope));
      const aliasScope = this.layer(inner, flow.alias, declaredExpressionType(expression, scope.types), "item");
      block.regions.push({ kind: "with", site, block: this.block(body, false, aliasScope, false, svg, true), test, recorded });
      return 1;
    }
    if (flow.kind === "match") {
      const expression = flow.expr === undefined ? undefined : plan(flow.expressionPlan, flow.expr);
      const alias = flow.alias;
      const armScope = alias === undefined ? inner
        : this.layer(inner, alias, expression === undefined ? undefined : declaredExpressionType(expression, scope.types), "item");
      // The arms' tests run in a function of the match value, `o`, inside the region's own block.
      const testBase = alias === undefined ? scope : {
        ...this.layer(scope, alias, expression === undefined ? undefined : declaredExpressionType(expression, scope.types), "item", "o"),
        closure: true,
      };
      const arms = node.children.filter((child): child is ElementNode =>
        child.kind === "element" && (child.flow?.kind === "when" || child.flow?.kind === "else"));
      const chosen: ElementNode[] = [];
      for (const arm of arms) {
        chosen.push(arm);
        if (arm.flow?.kind === "else") break;
      }
      let matched: Lowered | undefined;
      const { test, recorded } = decide((decisionScope) => {
        const value = expression === undefined ? undefined : this.checked(expression, decisionScope);
        if (decisionScope === scope) matched = value;
        const testScope = { ...testBase, record: decisionScope.record };
        // The arms' tests run in order until one is truthy, so only those are read.
        let reads: Reads = value ?? none("", "");
        const lines = chosen.map((arm, index) => {
          if (arm.flow?.kind === "else") return `return ${index};`;
          const armTest = this.checked(plan((arm.flow as { testPlan?: CompiledExpression }).testPlan, (arm.flow as { test: string }).test), testScope);
          reads = merge(reads, converted(armTest));
          return `{ const t = ${armTest.source}; if (t === NONCONFORMING) return t; if (truthy(t)) return ${index}; }`;
        });
        const source = `((o) => { ${lines.join(" ")} return -1; })(${value === undefined ? "undefined" : `mv = ${value.source}`})`;
        const selection = value === undefined ? source : `((mv = ${value.source}) === NONCONFORMING ? mv : ${source.replace(`mv = ${value.source}`, "mv")})`;
        return { ...none(`match:${site}`, selection), ...reads, fails: true };
      });
      const armBlocks = chosen.map((arm) => {
        const { flow: _armFlow, ...armBody } = arm;
        return this.block(armBody, false, armScope, false, svg, alias !== undefined);
      });
      block.regions.push({ kind: "match", site, block: armBlocks[0] ?? this.block({ ...body, children: [] }, false, inner, false, svg, false),
        arms: armBlocks, test, recorded, matched });
      return 1;
    }
    if (node.name === "template") notYetDirect();
    const listPlan = plan(flow.listPlan, flow.list);
    const list = this.checked(listPlan, scope);
    const listType = declaredExpressionType(listPlan, scope.types);
    const itemType = listType?.kind === "list" ? listType.item : undefined;
    // A row holds its item, its index alias and its `loop` record.
    const positions = (base: Scope, item?: string, index?: string, loop?: string): Scope => {
      const layered = this.layer(base, flow.item, itemType, "item", item);
      return {
        ...layered,
        aliases: [
          ...layered.aliases,
          ...flow.index === undefined ? [] : [{ name: flow.index, level: base.level, kind: "index" as const, ...index === undefined ? {} : { source: index } }],
          { name: "loop", level: base.level, kind: "loop" as const, ...loop === undefined ? {} : { source: loop } },
        ],
      };
    };
    const rowScope = positions(inner);
    // A key is a function of the item and its position, run beside the row's owner: `(o, j, l, r)`.
    const keyScope: Scope = { ...positions(scope, "o", "j", "loopRecord({ j, l })"), closure: true };
    const key = flow.key === undefined ? undefined : lower(plan(flow.keyPlan, flow.key).ast, keyScope);
    const shaped = this.shape(flow, scope, list, itemType);
    const rows = this.block(body, true, rowScope, false, svg);
    const positional = readsPosition(rows) || key?.positional === true;
    rows.positional = positional;
    block.regions.push({ kind: "each", site, block: rows, list: shaped.list, key, alias: flow.item, positional });
    return 2;
  }

  /** A local layer over `scope`: a row's item, or a `$with` or `$match` alias, at the scope's level. */
  layer(scope: Scope, alias: string, type: TypeNode | undefined, kind: AliasEntry["kind"], source?: string): Scope {
    const types: TypeScope = { get: () => undefined };
    declareLayerTypes(types, scope.types, { [alias]: type });
    return { ...scope, types, aliases: [...scope.aliases, { name: alias, level: scope.level, kind, ...source === undefined ? {} : { source } }] };
  }

  /** `$where`, `$sort` and `$limit` around a list, through the shared `shapeItems`. */
  shape(flow: Extract<Flow, { kind: "each" }>, scope: Scope, list: Lowered, itemType: TypeNode | undefined): { list: Lowered; positional: boolean } {
    if (flow.where === undefined && flow.sort === undefined && flow.limit === undefined) return { list, positional: false };
    let reads: Reads = list;
    let where = "0";
    if (flow.where !== undefined) {
      // `$where`, `$sort` and `$limit` use `evalValue`, without reference checks.
      // `$where` runs per item in a function of it, `(o)`, beside the list's owner.
      const whereScope: Scope = { ...this.layer(scope, flow.item, itemType, "item", "o"), closure: true };
      const lowered = lower((flow.wherePlan ?? compileExpression(flow.where)).ast, whereScope);
      reads = merge(reads, { ...converted(lowered), item: false, nested: true });
      where = `(o) => ${lowered.source}`;
    }
    const sorts = (flow.sort ?? "").split(",").map((key: string) => key.trim()).filter((key: string) => key !== "").map((key: string) => {
      const descending = key.startsWith("-");
      const field = descending ? key.slice(1).trim() : key;
      let source = "o";
      for (const step of field.split(".")) source = `readMember(${source}, ${JSON.stringify(step)})`;
      return `[(o) => ${source}, ${descending}]`;
    });
    if (sorts.length > 0) reads = merge(reads, { bits: 0, nested: true, item: false, contents: false, fails: false });
    let limit = "undefined";
    if (flow.limit !== undefined) {
      const lowered = lower((flow.limitPlan ?? compileExpression(flow.limit)).ast, scope);
      reads = merge(reads, lowered);
      limit = lowered.source;
    }
    return {
      list: { ...list, ...reads, source: `shapeItems(${list.source}, ${where}, [${sorts.join(", ")}], ${limit})`, deep: true },
      positional: false,
    };
  }
}

/**
 * Plans a component for direct-extend emission, or returns undefined when it uses a feature the
 * subset does not cover yet (the caller keeps the general-runtime fallback).
 */
export function blockPlan(definition: ComponentDefinition): BlockPlan | undefined {
  try {
    if ((definition.slots?.length ?? 0) > 0 || definition.root?.kind === "component" ||
      rootArms(definition.template) !== undefined || definition.template.flow !== undefined) return undefined;

    const roots = compileRoots(definition);
    const planner = new Planner(roots, definition);
    const root = planner.block(definition.template, false, planner.scope, true, false);
    // `:host-state()` rules test `data-<tag>-state`, kept in step with the props and state they name.
    const states = compileComponentStylesForBuild(definition.css, definition).stateNames;
    if (states.length > 0) {
      const values = states.map((name) => lower({ kind: "id", name }, planner.scope));
      const reads = values.reduce<Reads>((all, value) => merge(all, value), none("", ""));
      root.bindings.push({
        site: planner.site(root, []), kind: "hoststate", name: stateAttribute(definition.contract.tag), initial: "undefined",
        expression: { ...none(`hoststate`, `hostState(${JSON.stringify(states)}, [${values.map((value) => value.source).join(", ")}])`), ...reads },
      });
    }
    const props = Object.keys(definition.contract.props).length;
    return { roots, root, blocks: planner.blocks, initializers: planner.initializers, handlers: [...planner.handlers.values()],
      computeds: roots.flatMap((item, index) => item.computed === undefined ? [] : [{ index, source: planner.computedLowered(index).source }]),
      states: roots.length - props - roots.filter((item) => item.computed !== undefined).length, shown: roots.length - props };
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

/** The `<select>` site holding a region's site, whose bound value its changes re-apply. */
function selectOf(block: Block, site: number): number | undefined {
  const path = block.sites[site]!;
  let found: number | undefined;
  for (const select of block.selects) {
    const prefix = block.sites[select]!;
    if (prefix.length < path.length && prefix.every((step, index) => path[index] === step) &&
      (found === undefined || block.sites[found]!.length < prefix.length)) found = select;
  }
  return found;
}

/** A select's `applySelection`: its value bindings, applied as they evaluate now. */
function selection(block: Block, select: number, siteOf: (site: number) => string): string {
  const writes = block.bindings.filter((binding) => binding.select === true && binding.site === select).map((binding) => {
    const value = binding.apply!;
    const write = binding.kind === "property" ? `${siteOf(select)}.value = x;` : `writeControl(${siteOf(select)}, "value", x);`;
    return `{ const x = ${value.source}; ${value.fails ? `if (x !== NONCONFORMING) ` : ""}${write} }`;
  });
  return `() => { ${writes.join(" ")} }`;
}

/**
 * Whether a root the expression reads was written in this batch: its bit, or for a root sharing the
 * overflow bit, its index in the written map. Root writes notify even when restored later.
 */
function rootsWritten(reads: Reads): string {
  const direct = reads.bits & ~OVERFLOW;
  const parts = [...direct === 0 ? [] : [`c & ${direct}`], ...(reads.overflow ?? []).map((index) => `d.has(${index})`)];
  return parts.length === 0 ? "" : ` || ${parts.join(" || ")}`;
}

/** What the regions inside a row read besides the row's own item: those changes patch every row. */
function regionOuter(block: Block): number {
  let mask = 0;
  for (const region of block.regions) {
    if (region.test !== undefined) mask |= outerOf(region.test);
    if (region.list !== undefined) mask |= outerOf(region.list) | (region.list.nested ? NESTED : 0);
    if (region.kind !== "each") for (const body of [region.block, ...region.arms ?? []]) {
      mask |= body.bindings.reduce((all, binding) => all | outerOf(finalExpression(binding)), 0) | regionOuter(body);
    }
  }
  return mask;
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
    if (binding.kind !== "class" || region.key === undefined || binding.exact !== undefined) return -1;
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
    block.bindings.forEach((binding, index) => {
      entries.push(`v${index}: ${binding.initial}`);
      // A nonconforming segment keeps the text it last accepted.
      binding.parts?.forEach((part, segment) => {
        if (typeof part !== "string" && part.fails) entries.push(`m${index}_${segment}: ""`);
      });
    });
    block.regions.forEach((region, index) => {
      const start = sites[region.site]!;
      if (region.kind !== "each") {
        entries.push(`a${region.site}: ${start}`, `e${index}: ${start}.nextSibling`, `b${index}: undefined`);
        if (region.recorded !== undefined) entries.push(`q${index}: undefined`);
      } else {
        const child = region.block.id;
        const key = region.key === undefined ? "undefined" : `(${keyParameters(region.key.source)}) => ${region.key.source}`;
        const positional = region.positional === true || region.key?.positional === true;
        const type = region.key === undefined ? "IndexedList" : positional ? "PositionalList" : "KeyedList";
        entries.push(`L${index}: new ${type}(${start}, ${start}.nextSibling, m${child}, p${child}, ${key}, ${JSON.stringify(region.alias)})`);
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
    const ordered = (binding: Binding): boolean =>
      binding.kind === "attribute" || binding.kind === "url" || binding.kind === "class" || binding.kind === "style";
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
        const index = block.bindings.indexOf(binding);
        const last = `r.v${index}`;
        const site = field(block, binding.site);
        const output = `s${index}`;
        if (binding.kind === "mixed") {
          const pieces = binding.parts!.map((part, segment) => {
            if (typeof part === "string") return JSON.stringify(part);
            const value = `x${temporary++}`;
            lines.push(`    const ${value} = ${convertible(part)};`);
            if (!part.fails) return `toText(${value})`;
            lines.push(`    if (${value} !== NONCONFORMING) r.m${index}_${segment} = toText(${value});`);
            return `r.m${index}_${segment}`;
          });
          lines.push(`    const ${output} = ${pieces.length === 0 ? '""' : pieces.join(" + ")};`,
            `    if (${output} !== ${last}) ${site}.data = ${last} = ${output};`);
          continue;
        }
        if (binding.exact !== undefined) {
          // Written whenever what it read changed, as its live effect re-runs (see `Binding.exact`).
          const value = `x${temporary++}`;
          const expression = binding.kind === "class" ? truthiness(binding.expression, binding.exact) : binding.expression;
          lines.push(`    const ${binding.exact} = [];`, `    const ${value} = ${convertible(expression)};`,
            // A full render (a reconnect) re-runs every live effect, and a root write notifies its
            // readers even when a later write in the batch restores it; nested reads compare values.
            `    if (c === -1${rootsWritten(expression)} || readsChanged(${last}, ${binding.exact})) {`,
            `      ${last} = ${binding.exact};`);
          const name = JSON.stringify(binding.name);
          const write = binding.kind === "property" ? `${site}[${name}] = ${value};`
            : binding.kind === "class" ? `${site}.classList.toggle(${name}, ${value});`
            : binding.kind === "control" ? `writeControl(${site}, ${name}, ${value});`
            : binding.kind === "html" ? `writeHtml(${site}, toText(${value}));`
            : binding.kind === "range" ? `writeHtmlRange(${site}, toText(${value}));`
            : `${binding.kind === "url" ? "writeUrlAttribute" : "writeAttribute"}(${site}, ${name}, toAttribute(${value}, ${name}));`;
          lines.push(expression.fails ? `      if (${value} !== NONCONFORMING) ${write}` : `      ${write}`, "    }");
          continue;
        }
        let value = shared.get(binding.expression.key);
        if (value === undefined) {
          value = `x${temporary++}`;
          shared.set(binding.expression.key, value);
          // Every binding sharing an expression converts it, so an item-reached container is flagged here.
          lines.push(`    const ${value} = ${convertible(binding.expression)};`);
        }
        // A nonconforming result leaves what the binding last wrote, as the live runtime does.
        const fails = finalExpression(binding).fails;
        if (fails) lines.push(`    if (${value} !== NONCONFORMING) {`);
        const start = lines.length;
        switch (binding.kind) {
          case "attribute":
          case "url":
            lines.push(`    const ${output} = toAttribute(${value}, ${JSON.stringify(binding.name)});`,
              `    if (${output} !== ${last}) ${binding.kind === "url" ? "writeUrlAttribute" : "writeAttribute"}(${site}, ${JSON.stringify(binding.name)}, ${last} = ${output});`);
            break;
          case "value":
            lines.push(`    const ${output} = toText(${value});`, `    if (${output} !== ${last}) writeText(${site}, ${last} = ${output});`);
            break;
          case "text":
            lines.push(`    const ${output} = toText(${value});`, `    if (${output} !== ${last}) ${site}.data = ${last} = ${output};`);
            break;
          case "hoststate":
            lines.push(`    const ${output} = ${value};`,
              `    if (${output} !== ${last}) writeAttribute(${site}, ${JSON.stringify(binding.name)}, (${last} = ${output}) === "" ? null : ${output});`);
            break;
          case "style":
            lines.push(`    const ${output} = toText(${value});`,
              `    if (${output} !== ${last}) ${site}.style.setProperty(${JSON.stringify(binding.name)}, ${last} = ${output});`);
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
      if (region.kind !== "each") {
        const test = region.test!;
        const body = `r.b${index}`;
        const patchBody = region.kind === "match"
          ? `${region.arms!.map((arm, armIndex) => `if (${body}.s === ${armIndex}) p${arm.id}(${body}, c, d);`).join(" ")}`
          : `p${child}(${body}, c, d);`;
        // What a rebuilt body is made from: nothing, the `$with` value, or the chosen arm and match value.
        const linked = [region.block, ...region.arms ?? []].some((body) => body.needsParent === true) ? ", r" : "";
        const make = region.kind === "if" ? `m${child}(d${linked === "" ? "" : ", undefined, r"})`
          : region.kind === "with" ? `m${child}(d, t${index}${linked})`
          : `[${region.arms!.map((arm) => `m${arm.id}`).join(", ")}][t${index}](d, mv${linked})`;
        const show = region.kind === "if" ? `t${index}` : region.kind === "with" ? "true" : `t${index} >= 0`;
        const rebuild = [
          ...([region.block, ...region.arms ?? []].some(disposable) ? [`      dispose(${body});`] : []),
          `      ${body} = undefined;`,
          `      clearRegion(r.a${region.site}, r.e${index});`,
          `      if (${show}) { ${body} = ${make};${region.kind === "match" ? ` ${body}.s = t${index};` : ""} r.e${index}.before(${body}.n); }`,
        ];
        const decide = region.recorded === undefined ? [] : [`    const ${region.recorded} = [];`];
        const changed = region.recorded === undefined ? test.overflow === undefined ? "true" : `c === -1${rootsWritten(test)}`
          : `c === -1${rootsWritten(test)} || readsChanged(r.q${index}, ${region.recorded})`;
        const reselect = selectOf(block, region.site);
        if (reselect !== undefined) rebuild.push(`      queueMicrotask(r.c${reselect});`);
        lines.push(
          `  if (${guard(maskOf(test))}) {`,
          ...(region.kind === "match" ? ["    let mv;"] : []),
          ...decide,
          `    const t${index} = ${test.source};`,
          `    if (${changed}) {`,
          ...(region.recorded === undefined ? [] : [`      r.q${index} = ${region.recorded};`]),
          // A nonconforming decision leaves the region as it is, and its body keeps updating.
          test.fails ? `      if (t${index} === NONCONFORMING) { if (${body} !== undefined) ${patchBody} } else {` : "      {",
          ...rebuild.map((line) => `  ${line}`),
          "      }",
          `    } else if (${body} !== undefined) ${patchBody}`,
          `  } else if (${body} !== undefined) ${patchBody}`,
        );
        return;
      }
      const list = region.list!;
      const key = region.key;
      // Keys that read roots, nested data or positions are re-read for every item when those change.
      const rekey = key === undefined ? 0 : key.bits | (key.nested ? NESTED : 0);
      const full = key?.positional === true ? "true" : rekey === 0 ? undefined : `(c & ${rekey}) !== 0`;
      const apply = (value: string): string => full === undefined ? `r.L${index}.update(${value}, d, c)`
        : `if (c === -1 || ${full}) r.L${index}.set(${value}, d, true); else r.L${index}.update(${value}, d, c)`;
      // A nonconforming list leaves the rows as they are; a list inside a select re-applies its selection.
      const reselect = selectOf(block, region.site);
      const queue = reselect === undefined ? "" : ` queueMicrotask(r.c${reselect});`;
      lines.push(list.fails || full !== undefined || reselect !== undefined
        ? `  if (${guard(maskOf(list) | NESTED | rekey)}) { const l = ${list.source}; ${list.fails ? "if (l !== NONCONFORMING) " : ""}{ ${apply("l")};${queue} } }`
        : `  if (${guard(maskOf(list) | NESTED)}) ${apply(list.source)};`);
      const outer = region.block.bindings.reduce((mask, binding) => mask |
        (selectorRoot(binding, region) < 0 ? outerOf(finalExpression(binding)) : 0), 0) | regionOuter(region.block);
      if (outer !== 0) lines.push(`  if (c !== -1 && c & ${outer}) r.L${index}.each(c, d);`);
      for (const root of selectors(region)) {
        lines.push(`  if (c !== -1 && c & ${rootBit(root)}${outer === 0 ? "" : ` && !(c & ${outer})`}) visitSelected(r.L${index}.m, s${root}, v[${root}], p${child}, c);`);
      }
    });
    return lines;
  };

  const prototype = (block: Block): string => `buildTemplate(T${block.id}${block.svg ? ", document, 1" : ""})`;
  const body: string[] = [];
  /** Listeners and refs of a block, and what disposing its record stops. */
  const ownership = (block: Block, sites: readonly string[], record: string, indent: string): string[] => {
    const lines: string[] = [];
    const siteOf = (site: number): string => block.sites[site]!.length === 0 ? "n" : sites[site]!;
    for (const ref of block.refs) {
      lines.push(ref.iterated
        ? `${indent}(I.r[${JSON.stringify(ref.name)}] ??= []).push(${siteOf(ref.site)});`
        : `${indent}I.r[${JSON.stringify(ref.name)}] = ${siteOf(ref.site)};`);
    }
    block.regions.forEach((region, index) => {
      if (region.kind === "each" && listOwned(region)) lines.push(`${indent}${record}.L${index}.u = ${record};`);
      if (region.kind === "each" && region.key === undefined && region.positional === true) lines.push(`${indent}${record}.L${index}.q = true;`);
    });
    // A select's `applySelection` runs once its options exist and after its option regions change.
    for (const select of block.selects) lines.push(`${indent}${record}.c${select} = ${selection(block, select, (site) => block.sites[site]!.length === 0 ? `${record}.n` : `${record}.a${site}`)};`);
    const stops = block.events.map((event) => listener(event, siteOf(event.site)));
    for (const binding of block.bindings) if (binding.kind === "control") stops.push(`bindControl(I, ${siteOf(binding.site)}, ${binding.path})`);
    // A cleared region or removed row stops its listeners and the regions and rows below it.
    block.regions.forEach((region, index) => {
      if (![region.block, ...region.arms ?? []].some(disposable)) return;
      stops.push(region.kind === "each" ? `() => { for (const row of ${record}.L${index}.r) dispose(row); }` : `() => dispose(${record}.b${index})`);
    });
    if (stops.length > 0) lines.push(`${indent}${record}.z = [${stops.join(", ")}];`);
    return lines;
  };
  const listener = (event: Block["events"][number], target: string): string => {
    const filter = event.modifiers.some((modifier) => !["capture", "once", "passive", "prevent", "stop"].includes(modifier))
      ? `if (!eventPasses(event, ${target}, ${JSON.stringify(event.modifiers)})) return; ` : "";
    const effects = `${event.modifiers.includes("prevent") ? "event.preventDefault(); " : ""}${event.modifiers.includes("stop") ? "event.stopPropagation(); " : ""}`;
    return `listen(I, ${target}, ${JSON.stringify(event.name)}, (event) => { ${filter}${effects}${event.handler}(event); }, ${event.modifiers.includes("capture")}, ${event.modifiers.includes("passive")}, ${event.modifiers.includes("once")})`;
  };
  for (const block of blocks.slice(1)) {
    const lines: string[] = [];
    const sites = walk("n", block.sites, lines, "t");
    const entries = fields(block, sites);
    const reads = block.alias;
    if (block.row) {
      body.push(
        `  const m${block.id} = (o, j, l${block.needsParent === true ? ", u" : ""}) => {`,
        `    const n = (P${block.id} ??= ${prototype(block)}).cloneNode(true);`,
        ...lines.map((line) => `    ${line}`),
        `    const r = { k: undefined, i: o, n, x: 0, y: 0${block.positional === true ? ", j, l" : ""}${block.needsParent === true ? ", u" : ""}${entries.map((entry) => `, ${entry}`).join("")} };`,
        ...ownership(block, sites, "r", "    "),
        `    p${block.id}(r, -1, E);`,
        ...block.selects.map((select) => `    r.c${select}();`),
        "    return r;",
        "  };",
      );
    } else {
      body.push(
        `  const m${block.id} = (d${block.alias || block.needsParent === true ? ", o" : ""}${block.needsParent === true ? ", u" : ""}) => {`,
        `    const n = (P${block.id} ??= ${prototype(block)}).cloneNode(true);`,
        ...lines.map((line) => `    ${line}`),
        `    const r = { n${block.alias ? ", i: o" : ""}${block.needsParent === true ? ", u" : ""}${entries.map((entry) => `, ${entry}`).join("")} };`,
        ...ownership(block, sites, "r", "    "),
        `    p${block.id}(r, -1, d);`,
        ...block.selects.map((select) => `    r.c${select}();`),
        "    return r;",
        "  };",
      );
    }
    body.push(
      `  const p${block.id} = (r, c, d) => {`,
      ...(reads ? ["    const o = r.i;"] : []),
      ...patch(block).map((line) => `  ${line}`),
      "  };",
    );
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
    ...root.selects.map((select) => `  R.c${select} = ${selection(root, select, (site) => root.sites[site]!.length === 0 ? "element" : `R.a${site}`)};`),
    ...root.regions.flatMap((region, index) => region.kind !== "each" ? [] : [
      ...listOwned(region) ? [`  R.L${index}.u = R;`] : [],
      ...region.key === undefined && region.positional === true ? [`  R.L${index}.q = true;`] : [],
    ]),
  );
  const propNames = Object.keys(contract.props);
  const instance = propNames.length > 0 || plan.handlers.length > 0 ||
    blocks.some((block) => block.refs.length > 0 || block.events.length > 0 || block.bindings.some((binding) => binding.kind === "control"));
  const siteOf = (site: number): string => root.sites[site]!.length === 0 ? "element" : rootSites[site]!;
  body.push(
    ...(instance ? [`  const I = {${propNames.length > 0 ? " B " : ""}};`] : []),
    `  attachGeneratedController(element, S, v, (c, d) => p0(R, c, d), ${definition.controller === undefined ? "undefined" : "C"}${
      plan.computeds.length > 0 || instance ? `, ${plan.computeds.length > 0 ? "X" : "undefined"}` : ""}${instance ? ", I" : ""});`,
    ...(propNames.length > 0 ? ["  manageProps(I, element);"] : []),
    ...root.refs.map((ref) => `  I.r[${JSON.stringify(ref.name)}] = ${siteOf(ref.site)};`),
    ...root.selects.map((select) => `  R.c${select}();`),
    ...root.events.map((event) => `  ${listener(event, siteOf(event.site))};`),
    ...root.bindings.some((binding) => binding.kind === "control") ? [
      "  {",
      // A destination function reads the root record as `r`, as listeners in other blocks do.
      "    const r = R;",
      ...root.bindings.filter((binding) => binding.kind === "control").map((binding) => `    bindControl(I, ${siteOf(binding.site)}, ${binding.path});`),
      "  }",
    ] : [],
    "  return element;",
    "}",
  );
  const factory = [
    `export function create${contract.name}(options${Object.values(contract.props).some((prop) => prop.required) ? "" : " = {}"}) {`,
    propNames.length === 0 ? "  const { attributes = {} } = options;" : "  const { attributes = {}, children = [], slots = {}, ...componentProps } = options;",
    definition.template.name === "svg"
      ? '  const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");'
      : `  const element = document.createElement(${JSON.stringify(definition.template.name)});`,
    "  for (const [name, value] of Object.entries(attributes)) {",
    "    if (value === null || value === undefined || value === false) continue;",
    "    element.setAttribute(name, value === true ? \"\" : String(value));",
    "  }",
    ...rootLines,
    `  element.setAttribute("data-component", ${JSON.stringify(contract.tag)});`,
    ...(rootChildren ? [`  element.append((P0 ??= ${prototype(plan.root)}).cloneNode(true));`] : []),
    `  const v = [${plan.roots.map((item) => item.initial).join(", ")}];`,
    // Props are accepted first: initial state may read them.
    ...(propNames.length === 0 ? [] : [`  const B = acceptProps(element, D, S.n, v, componentProps, ${JSON.stringify(propNames.filter((name) =>
      definition.template.attributes.some((attribute) => attribute.kind === "attribute" && attribute.name === `data-${kebabCase(name)}`)))});`]),
    ...plan.initializers,
    ...(plan.computeds.length === 0 ? [] : [
      "  const X = { e: 0, g: (j) => g(j), w: new Set() };",
      "  const ke = [];",
      `  const K = [${plan.computeds.map((computed) => `() => ${computed.source}`).join(", ")}];`,
      // Computed lazily on read, once per write epoch; a change tells the controller's effects.
      "  const g = (j) => {",
      `    const i = j - ${plan.computeds[0]!.index};`,
      "    if (ke[i] === X.e) return v[j];",
      "    if (ke[i] === -1) computedCycle();",
      "    ke[i] = -1;",
      "    let next;",
      "    try { next = K[i](); } catch (error) { ke[i] = undefined; throw error; }",
      "    ke[i] = X.e;",
      "    const previous = v[j];",
      "    if (!Object.is(previous, next)) { v[j] = next; X.n?.(j, previous, next); }",
      "    return next;",
      "  };",
    ]),
    ...plan.handlers.map((handler) => [`  const ${handler.name} = (e) => {`, ...handler.lines, "  };"].join("\n")),
    ...(selected.length === 0 ? [] : [`  let ${selected.map((root) => `s${root} = v[${root}]`).join(", ")};`]),
    ...body,
  ];
  const source = factory.join("\n");
  // Declared events: the controller's `host.dispatch` and handler dispatches check and flag them as live does.
  const events = (definition.declarations ?? []).flatMap((declaration) => {
    if (declaration.kind !== "event") return [];
    const type = declarationTypeNode(declaration.type, declaration.shape);
    return [`${JSON.stringify(declaration.name)}: [${type === undefined ? "0" : `detailCheck(${JSON.stringify(type)})`}, ${declaration.bubbles}, ${declaration.composed}, ${declaration.cancelable}]`];
  });
  const shown = plan.roots.slice(0, plan.shown);
  const stateSpec = `const S = { n: ${JSON.stringify(shown.map((item) => item.name))}, t: [${shown.map((item) => compactSource(item.type)).join(",")}], f: import.meta.url, g: ${JSON.stringify(contract.tag)}${
    plan.states === plan.shown ? "" : `, k: ${plan.states}`}${events.length === 0 ? "" : `, d: { ${events.join(", ")} }, x: dispatchDeclared`}${
    blocks.some((block) => block.refs.some((ref) => ref.iterated)) ? ", z: iteratedRef" : ""} };`;
  const helpers = ["attachGeneratedController", "binaryValue", "buildTemplate", "checkReference", "chooseValue", "clearRegion",
    "defaultValue", "formatCall", "KeyedList", "listValue", "logicValue", "mathCall", "negate", "NONCONFORMING", "notValue",
    "readDeclared", "readFailing", "readIndex", "readMember", "readsChanged", "rec", "recContents", "recLength", "recordValue",
    "textCall", "toAttribute", "toText", "trackContainer", "truthy", "truthyValue", "visitSelected", "writeAttribute", "writeText",
    "writeUrlAttribute", "computedCycle", "dispatchDeclared", "detailCheck", "eventPasses", "listen", "refTargets", "rootValue", "setState",
    "dispose", "shapeItems", "loopRecord", "IndexedList", "PositionalList", "iteratedRef", "writeControl", "writeHtml", "writeHtmlRange",
    "bindControl", "formatOf", "isFunctionValue", "isNativeEvent", "keywordFormat", "urlFormat", "emailFormat", "dateFormat",
    "monthFormat", "weekFormat", "timeFormat", "datetimeLocalFormat", "datetimeFormat", "colorFormat", "colorHexFormat",
    "lengthFormat", "percentageFormat", "durationFormat", "hostState", "acceptProps", "manageProps", "checkSelected"]
    .filter((name) => name === "attachGeneratedController" || new RegExp(`\\b${name}\\b`).test(`${source}\n${stateSpec}`));
  const specs = blocks.flatMap((block) => block.id === 0 && !rootChildren ? [] : [`const T${block.id} = ${JSON.stringify(block.spec)};`]);

  const prototypes = blocks.filter((block) => block.id !== 0 || rootChildren).map((block) => `P${block.id}`);
  return [
    `// Generated by HTML Next ${version} for Vanilla DOM. Do not edit.`,
    `import { ${helpers.join(", ")} } from "@nextwebwg/html-next/generated-runtime";`,
    ...(definition.controller === undefined ? [] : [`import * as controller from ${JSON.stringify(definition.controller)};`]),
    `import "../styles/${contract.tag}.css";`,
    "",
    ...specs,
    ...(prototypes.length === 0 ? [] : [`let ${prototypes.join(", ")};`]),
    // A fresh row's first patch has nothing written yet.
    ...(blocks.some((block) => block.row) ? ["const E = new Map();"] : []),
    stateSpec,
    ...(propNames.length === 0 ? [] : [`const D = { props: ${JSON.stringify(Object.fromEntries(Object.entries(runtimeProps(definition))
      .map(([name, prop]) => { const { target: _target, ...read } = prop as Record<string, unknown>; return [name, read]; })))} };`]),
    // Only the default export is read, and only on first connect, so bundlers need no namespace object.
    ...(definition.controller === undefined ? [] : ["const C = (host) => controller.default(host);"]),
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
    return lower(node, {
      roots: roots.map((root) => ({ ...root, initial: "undefined" })), level: 0, types: { get: () => undefined },
      aliases: alias === undefined ? [] : [{ name: alias, level: 0, kind: "item" }],
    }).source;
  } catch (error) {
    if (error instanceof NotYetDirect) return undefined;
    throw error;
  }
}
