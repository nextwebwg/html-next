import type { DefaultTreeAdapterTypes } from "parse5";

import { matchesPropBounds, matchesPropValues, parseTypeAttribute, parseValueBounds, parseValuesConstraint } from "./contract.js";
import { fail, HtmlDiagnosticError, recoverDiagnostic, withDiagnosticLocation, type HtmlDiagnostic, type DiagnosticLocation } from "./diagnostics.js";
import { checkExpressionSemantics, compileExpression, compilePath, getWritablePath, writablePathOf, type CompiledExpression, type ExpressionNode, type WritablePath } from "./expression.js";
import { parseDuration } from "./duration.js";
import { deepFreeze } from "./freeze.js";
import {
  isReservedElement,
  isWhitespaceDiscardingElement,
  validateDefinitionElementName,
  validateLiteralAttributeName,
  validateMvpDomProperty,
} from "./language.js";
import { componentName, requestPropName } from "./names.js";
import { IDENTIFIER, isIdentifier } from "./identifiers.js";
import { HEAD_ATTRIBUTES, HEAD_LINK_RELS, SCRIPT_STANDARD_ATTRIBUTES } from "./head-rules.js";
import { hasExecutableUrl } from "./sanitize.js";
import type {
  AttributeBinding,
  ComponentDefinition,
  ComponentDeclaration,
  ComponentLifecycle,
  ElementNode,
  ElementTransition,
  EventBinding,
  Flow,
  HandlerStep,
  HeadDeclaration,
  LiteralAttribute,
  ScriptDeclaration,
  SlotContract,
  SortKey,
  TemplateAttribute,
  TemplateNode,
  TextNode,
} from "./template.js";
import { isAttributeType, normalizeType, parseTypedValue, parseTypeExpression, typeAtKey, TypeSyntaxError, type TypeNode } from "./type-system.js";
import type { ComponentContract, ContractStatus, PropContract, PropTarget, PropValue, RequestContract } from "./types.js";

type DiagnosticFail = typeof fail;

type ChildNode = DefaultTreeAdapterTypes.ChildNode | globalThis.Node;
type Element = DefaultTreeAdapterTypes.Element | globalThis.Element;
type SourceAttribute = Readonly<{ name: string; value: string }>;
const recoveredElements = new WeakSet<ElementNode>();

export type ComponentSourceNode = ChildNode;

export interface ComponentParserPlatform {
  readonly isNativeElement: (name: string) => boolean;
  readonly resolveDomProperty: (tagName: string, propertyName: string) => string | undefined;
  readonly onDiagnostic?: (diagnostic: HtmlDiagnostic) => void;
  readonly warnInvalidDeclaration?: (message: string, source: string) => void;
  /** Receives warnings, such as HT022, when no check collects them through `onDiagnostic`. */
  readonly warn?: (diagnostic: HtmlDiagnostic) => void;
}

/** Parse the inert contents of a consumer's scoped-slot template against its exposed names. */
export function parseProjectedSlotContent(
  template: Element,
  definition: ComponentDefinition,
  names: readonly string[],
  source: string,
  platform: ComponentParserPlatform,
): readonly TemplateNode[] {
  const scope: ParseScope = {
    roots: new Set(names),
    writableRoots: new Set(),
    handlers: new Set(),
    report: platform.onDiagnostic ?? platform.warn,
  };
  const slotState = { defaults: 0, names: new Set<string>(), contracts: [] as SlotContract[], refs: new Set<string>() };
  const nodes: TemplateNode[] = [];
  for (const child of contentNodes(template)) {
    if (typeof child === "string") nodes.push(...parseText(child, scope, source));
    else nodes.push(parseElement(child, definition.contract, scope, source, slotState, platform));
  }
  return nodes;
}

function sourceLocation(node: ChildNode | undefined): DiagnosticLocation | undefined {
  if (node === undefined || !("sourceCodeLocation" in node) || node.sourceCodeLocation == null) return undefined;
  return { line: node.sourceCodeLocation.startLine, column: node.sourceCodeLocation.startCol };
}

function locatedFail(node: ChildNode): DiagnosticFail {
  const location = sourceLocation(node);
  if (location === undefined) return fail;
  return (code, message, source, override) => fail(code, message, source, override ?? location);
}

function recoverSource(error: unknown, node: ChildNode, source: string, report?: ComponentParserPlatform["onDiagnostic"]): void {
  if (report !== undefined && error instanceof TypeSyntaxError) {
    error = new HtmlDiagnosticError({ code: "HC013", message: error.message, source, ...sourceLocation(node) });
  } else if (error instanceof HtmlDiagnosticError && (error.diagnostic.line === undefined || error.diagnostic.source === undefined)) {
    error = new HtmlDiagnosticError({ ...sourceLocation(node), ...error.diagnostic, source: error.diagnostic.source ?? source });
  }
  recoverDiagnostic(error, report);
}

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function isText(node: ChildNode): boolean {
  return node.nodeName === "#text";
}

function sourceTag(element: Element): string {
  return "localName" in element ? element.localName : element.tagName;
}

function sourceAttributes(element: Element): Iterable<SourceAttribute> {
  return "attrs" in element ? element.attrs : element.attributes;
}

function sourceChildren(element: Element): Iterable<ChildNode> {
  const content = sourceTag(element) === "template"
    ? (element as unknown as { content?: { childNodes: ArrayLike<unknown> } }).content
    : undefined;
  const children = content?.childNodes ?? element.childNodes;
  return children as unknown as Iterable<ChildNode>;
}

function sourceText(node: ChildNode): string {
  if ("value" in node) return node.value;
  return "nodeValue" in node ? node.nodeValue ?? "" : "";
}

const HTML_WHITESPACE_RE = /^[\t\n\f\r ]*$/;

/**
 * An element's text and element children. Text is kept as written, whitespace-only text included:
 * it renders between inline content, and CSS `white-space` decides how it collapses. Text that only
 * a comment separates is one DOM text node once rendered, so it reads as one run.
 */
function contentNodes(element: Element): Array<Element | string> {
  const result: Array<Element | string> = [];
  for (const node of sourceChildren(element)) {
    if (isText(node)) {
      if (typeof result.at(-1) === "string") result[result.length - 1] += sourceText(node);
      else result.push(sourceText(node));
    } else if (isElement(node)) result.push(node);
  }
  return result;
}

function isWhitespaceText(node: TemplateNode): boolean {
  return node.kind === "text" && node.expressionPlan === undefined && node.segments === undefined && HTML_WHITESPACE_RE.test(node.value);
}

function significant(nodes: Iterable<ChildNode>): ChildNode[] {
  const result: ChildNode[] = [];
  for (const node of nodes) {
    if (node.nodeName !== "#comment" && (!isText(node) || sourceText(node).trim() !== "")) {
      result.push(node);
    }
  }
  return result;
}

function attr(element: Element, name: string): string | undefined {
  return "attrs" in element
    ? element.attrs.find((item) => item.name === name)?.value
    : element.getAttribute(name) ?? undefined;
}

function textContent(element: Element): string {
  let text = "";
  for (const node of sourceChildren(element)) {
    if (isText(node)) text += sourceText(node);
  }
  return text;
}

function directElements(element: Element, name: string): Element[] {
  const matches: Element[] = [];
  for (const node of sourceChildren(element)) {
    if (isElement(node) && sourceTag(node) === name) matches.push(node);
  }
  return matches;
}

function validateDeclarationContent(...args: Parameters<typeof validateDeclarationContentAtSource>): ReturnType<typeof validateDeclarationContentAtSource> {
  return withDiagnosticLocation(sourceLocation(args[0]), () => validateDeclarationContentAtSource(...args));
}

/** The elements `<defs>` may hold as direct children to add to the document head. */
const HEAD_ELEMENT_RE = /^(?:title|meta|link|script)$/;

function validateDeclarationContentAtSource(element: Element, source: string, defs = false): void {
  for (const child of sourceChildren(element)) {
    if (!isElement(child)) continue;
    const name = sourceTag(child);
    // Head declarations are read, attribute by attribute, with the other declarations.
    if (defs && HEAD_ELEMENT_RE.test(name)) continue;
    if (defs && name === "base") {
      fail("HC025", "`<base>` would rebase every relative URL in the document; it is not a head declaration.", source);
    }
    if (name === "link") {
      fail("HL001", "External definition dependencies require the application-owned graph resolver.", source);
    }
    validateDefinitionElementName(name, source);
    for (const attribute of sourceAttributes(child)) {
      if (/^on(?!:)/i.test(attribute.name)) {
        validateLiteralAttributeName(attribute.name, source, attribute.value);
      }
    }
    validateDeclarationContent(child, source);
  }
}

const FLOW_NAME_RE = /^\$(?:if|each|where|sort|limit|key|with|match|when|else)$/;
const RAW_SINK_RE = /^(?:innerhtml|outerhtml|textcontent|innertext|srcdoc)$/;
const EACH_RE = new RegExp(String.raw`^\s*(${IDENTIFIER})(?:\s*,\s*(${IDENTIFIER}))?\s+of\b\s*(.+)$`, "u");
const AS_RE = new RegExp(String.raw`^\s*(.+?)\s+\bas\b\s+(${IDENTIFIER})\s*$`, "u");
const EVENT_PART_RE = /^[a-z][a-z0-9-]*$/;
const EVENT_MODIFIER_RE = /^(?:prevent|stop|self|once|passive|capture|left|middle|right|ctrl|shift|alt|meta|exact|enter|escape|space|tab|up|down)$/;
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

interface ParseScope {
  readonly roots: ReadonlySet<string>;
  readonly writableRoots: ReadonlySet<string>;
  readonly handlers: ReadonlySet<string>;
  readonly allowUndeclared?: boolean;
  /** Check-mode sink for non-fatal diagnostics, and the authored element they point at. */
  readonly report?: ((diagnostic: HtmlDiagnostic) => void) | undefined;
  readonly at?: DiagnosticLocation | undefined;
  /** What each `$each`, `$with`, and `$match` name stands for when a path field writes through it. */
  readonly aliases?: ReadonlyMap<string, Writable>;
  /** How many `$each` layers enclose this point, so a `loop.index` segment names the right loop. */
  readonly loops?: number;
  /** Among table-structure or SVG-container children, where whitespace-only text never renders. */
  readonly discardsWhitespace?: boolean;
}

/**
 * A path's state destination, valid only at `loops` depth when it reads a `loop.index`, or why it
 * cannot be written. An alias of a writable path is writable (Declarative Components, Bindings).
 */
type Writable = { readonly path: WritablePath; readonly loops?: number } | { readonly reason?: string };

function readsLoop(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(readsLoop);
  if (node === null || typeof node !== "object") return false;
  const id = node as ExpressionNode;
  return id.kind === "id" && id.name === "loop" || Object.values(node).some(readsLoop);
}

function writableAt(node: ExpressionNode, scope: ParseScope): Writable {
  const segments = writablePathOf(node);
  if (segments === undefined || segments[0] === "$$event") return {};
  const [root, ...rest] = segments as [string, ...typeof segments];
  const loops = scope.loops ?? 0;
  const local = rest.some((segment) => typeof segment === "object" && readsLoop(segment.expression)) ? loops : undefined;
  const alias = scope.aliases?.get(root);
  if (alias === undefined) return scope.writableRoots.has(root) ? { path: segments, ...local === undefined ? {} : { loops: local } } : {};
  if (!("path" in alias)) return alias;
  if (alias.loops !== undefined && alias.loops !== loops) {
    return { reason: `\`${root}\` is an outer loop's item here; name that loop's index (\`${root}, i of …\`) to write through it` };
  }
  // Replacing a whole loop item needs its live position; a field of it is written through the item.
  const last = alias.path.at(-1);
  if (rest.length === 0 && typeof last === "object" && last.item !== undefined) {
    return { reason: `\`${root}\` is a whole loop item; bind one of its fields, or a field of its state path` };
  }
  const at = alias.loops ?? local;
  return { path: [...alias.path, ...rest], ...at === undefined ? {} : { loops: at } };
}

/** The write targets the names of a structural directive introduce for its subtree. */
function withAliases(scope: ParseScope, flow: Flow | undefined): ParseScope {
  if (flow?.kind === "each") {
    const loops = (scope.loops ?? 0) + 1;
    const list = flow.listPlan === undefined ? {} : writableAt(flow.listPlan.ast, scope);
    const item: Writable = !("path" in list) ? { reason: `\`${flow.item}\` is an item of a list that is not declared state` }
      : flow.where !== undefined || flow.sortKeys !== undefined || flow.limit !== undefined
        ? { reason: `\`${flow.item}\` is an item of a \`$where\`, \`$sort\`, or \`$limit\` list, whose positions differ from the state's` }
        : list.loops !== undefined ? { reason: `\`${flow.item}\` iterates an outer loop's item; name that loop's index to write through it` }
          : {
              path: [...list.path, { kind: "index", item: flow.item, expression: flow.index === undefined
                ? { kind: "member", object: { kind: "id", name: "loop" }, key: "index" }
                : { kind: "id", name: flow.index } }],
              ...flow.index === undefined ? { loops } : {},
            };
    const aliases = new Map(scope.aliases);
    aliases.set(flow.item, item);
    aliases.set("loop", { reason: "`loop` is the loop record" });
    if (flow.index !== undefined) aliases.set(flow.index, { reason: `\`${flow.index}\` is a loop index` });
    return { ...scope, aliases, loops };
  }
  if ((flow?.kind === "with" || flow?.kind === "match") && flow.alias !== undefined) {
    const subject = flow.expressionPlan === undefined ? {} : writableAt(flow.expressionPlan.ast, scope);
    const aliases = new Map(scope.aliases);
    aliases.set(flow.alias, "path" in subject ? subject
      : { reason: `\`${flow.alias}\` stands for \`${flow.expr}\`, which is not a writable state path` });
    return { ...scope, aliases };
  }
  return scope;
}

function withRoots(scope: ParseScope, ...roots: (string | undefined)[]): ParseScope {
  const expanded = new Set(scope.roots);
  for (const root of roots) {
    if (root !== undefined) expanded.add(root);
  }
  return { ...scope, roots: expanded };
}

function compileScopedExpression(
  value: string,
  scope: ParseScope,
  source: string,
  path = false,
): CompiledExpression {
  const expression = compileDeclarationExpression(value, source, path);
  validateCompiledExpression(expression, scope, source);
  if (scope.report !== undefined) warnBareNames(expression.ast, scope, source, value);
  return expression;
}

/** A bare word is a keyword literal. Spelling a name in scope is almost always a missing `$`. */
function warnBareNames(node: unknown, scope: ParseScope, source: string, expression: string): void {
  if (Array.isArray(node)) {
    for (const child of node) warnBareNames(child, scope, source, expression);
  } else if (node !== null && typeof node === "object") {
    const literal = node as ExpressionNode;
    if (literal.kind !== "literal") {
      for (const child of Object.values(node)) warnBareNames(child, scope, source, expression);
    } else if (literal.keyword && scope.roots.has(literal.value as string)) {
      const name = literal.value as string;
      // The expression locates the mistake where a browser-parsed carrier has no line numbers.
      scope.report!({
        code: "HT022",
        message: `\`${name}\` is a keyword, not a reference; did you mean \`$${name}\`? (in \`${expression}\`)`,
        source,
        ...scope.at,
        severity: "warning",
      });
    }
  }
}

// Scan browser-parsed text, not source HTML. Mixed segments share one native Text node.
// Braces delimit every insertion and contain any checked expression.

function parseText(value: string, scope: ParseScope, source: string): TemplateNode[] {
  const nodes: TextNode[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") nodes.push({ kind: "text", value: literal });
    literal = "";
  };
  for (let offset = 0; offset < value.length;) {
    if (value[offset] === "\\" && ["{", "\\"].includes(value[offset + 1] ?? "")) {
      literal += value[offset + 1];
      offset += 2;
      continue;
    }
    if (value[offset] === "{") {
      let end = offset + 1;
      let depth = 1;
      let quote: string | undefined;
      for (; end < value.length; end++) {
        const char = value[end];
        if (quote !== undefined) {
          if (char === "\\") end++;
          else if (char === quote) quote = undefined;
        } else if (char === "'" || char === '"') quote = char;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) break;
      }
      if (depth !== 0) fail("HT004", "Unterminated text expression; escape a literal opening brace as `\\{`.", source);
      flush();
      const expression = value.slice(offset + 1, end);
      nodes.push({ kind: "text", value: expression, expressionPlan: compileScopedExpression(expression, scope, source) });
      offset = end + 1;
      continue;
    }
    literal += value[offset++];
  }
  flush();
  return nodes.length > 1 && nodes.some((node) => node.expressionPlan !== undefined)
    ? [{ kind: "text", value, segments: nodes }] : nodes;
}

function validateCompiledExpression(
  expression: CompiledExpression,
  scope: ParseScope,
  source: string,
): void {
  for (const dependency of expression.dependencies) {
    const root = dependency.split(".", 1)[0]!;
    if (!scope.roots.has(root) && (root === "$$event" || scope.allowUndeclared !== true)) {
      fail("HT003", `Expression root \`${root}\` is not declared in this scope.`, source);
    }
  }
}

/**
 * A prop's target is defined by where it is bound in the markup, not restated: a
 * `from:attr="prop"` binding targets that attribute, a `.prop="prop"` binding that DOM property. A prop
 * bound in several places targets its first binding in document order; the others only render it.
 */
function collectTargets(...args: Parameters<typeof collectTargetsAtSource>): ReturnType<typeof collectTargetsAtSource> {
  return withDiagnosticLocation(sourceLocation(args[0]), () => collectTargetsAtSource(...args));
}

function collectTargetsAtSource(
  root: Element,
  source: string,
  platform: ComponentParserPlatform,
): Record<string, PropTarget> {
  const targets: Record<string, PropTarget> = Object.create(null) as Record<string, PropTarget>;
  const record = (name: string, target: PropTarget): void => {
    targets[name] ??= target;
  };
  const visit = (element: Element): void => {
    for (const attribute of sourceAttributes(element)) {
      // A target is a direct `$prop` reference.
      const name = attribute.value.slice(1);
      if (!attribute.value.startsWith("$") || !isIdentifier(name)) continue;
      if (attribute.name.startsWith("from:")) {
        record(name, { attribute: attribute.name.slice("from:".length).toLowerCase() });
      } else if (attribute.name.startsWith(".")) {
        const key = attribute.name.slice(1).toLowerCase();
        const property = platform.resolveDomProperty(sourceTag(element), key) ??
          (name.toLowerCase() === key ? name : key);
        record(name, { property });
      }
    }
    for (const child of sourceChildren(element)) {
      if (isElement(child) && sourceTag(child) !== "slot") visit(child);
    }
  };
  visit(root);
  return targets;
}

function readDeclaredType(...args: Parameters<typeof readDeclaredTypeAtSource>): ReturnType<typeof readDeclaredTypeAtSource> {
  return withDiagnosticLocation(sourceLocation(args[0]), () => readDeclaredTypeAtSource(...args));
}

function readDeclaredTypeAtSource(
  element: Element,
  source: string,
  nested = false,
  warnInvalidDeclaration?: ComponentParserPlatform["warnInvalidDeclaration"],
): PropContract["type"] {
  if (attr(element, "nullable") !== undefined) {
    // Every value accepts null, which means not present (types#null-and-missing-values).
    const message = "`nullable` is not a declaration attribute; remove it. Every value accepts `null`, which means not present.";
    if (warnInvalidDeclaration === undefined) fail("HC013", message, source);
    warnInvalidDeclaration(message, source);
  }
  const written = attr(element, "type");
  if (written === undefined || written === "") fail("HC013", "A typed declaration requires a `type` attribute.", source);
  if (attr(element, "open") !== undefined && written !== "object") {
    fail("HC013", "Only an object declaration can be open.", source);
  }
  const children = directElements(element, "prop");
  let type: PropContract["type"];
  if (written === "list") {
    if (children.length !== 1 || attr(children[0]!, "name") !== undefined) {
      fail("HC013", "A list requires one unnamed item <prop>.", source);
    }
    type = { kind: "list", item: normalizeType(readDeclaredType(children[0]!, source, true, warnInvalidDeclaration)) };
  } else if (written === "object" && (children.length > 0 || attr(element, "open") !== undefined)) {
    const fields: { name: string; type: TypeNode; optional: boolean }[] = [];
    for (const child of children) {
      const fieldName = attr(child, "name");
      if (fieldName === undefined || fieldName === "" || fields.some((field) => field.name === fieldName)) {
        fail("HC013", "Object fields require distinct names.", source);
      }
      fields.push({ name: fieldName, type: normalizeType(readDeclaredType(child, source, true, warnInvalidDeclaration)), optional: attr(child, "required") === undefined });
    }
    type = { kind: "object", fields, open: attr(element, "open") !== undefined };
  } else {
    if (children.length > 0) fail("HC013", "Only object and list declarations contain nested <prop> fields.", source);
    type = parseTypeAttribute(written);
  }
  if (!nested) return type;
  const rawValues = attr(element, "values");
  let values: readonly (string | number | boolean)[] | undefined;
  if (rawValues !== undefined) {
    values = parseValuesConstraint(type, rawValues);
    if (values === undefined) {
      const message = `A nested values constraint does not conform to type \`${written}\`; the constraint is ignored.`;
      if (warnInvalidDeclaration === undefined) fail("HC013", message, source);
      warnInvalidDeclaration(message, source);
    }
  }
  const { bounds, invalid } = parseValueBounds(type, {
    min: attr(element, "min"), max: attr(element, "max"),
    minLength: attr(element, "minlength"), maxLength: attr(element, "maxlength"),
    pattern: attr(element, "pattern"),
  });
  for (const key of invalid) {
    const message = `A nested ${key} constraint does not conform to type \`${written}\`; the constraint is ignored.`;
    if (warnInvalidDeclaration === undefined) fail("HC013", message, source);
    warnInvalidDeclaration(message, source);
  }
  if (values !== undefined || Object.keys(bounds).length > 0) {
    type = { kind: "constrained", base: normalizeType(type), ...(values === undefined ? {} : { values }), ...bounds };
  }
  return type;
}

function readProps(
  group: Element | undefined,
  targets: Record<string, PropTarget>,
  source: string,
  requireBinding = true,
  warnInvalidDeclaration?: ComponentParserPlatform["warnInvalidDeclaration"],
  onDiagnostic?: ComponentParserPlatform["onDiagnostic"],
): Record<string, PropContract> {
  const elements = group === undefined ? [] : directElements(group, "prop");
  const namedTypes = new Map<string, Element>();
  for (const element of group === undefined ? [] : directElements(group, "type")) {
    const fail: DiagnosticFail = locatedFail(element);
    const name = attr(element, "name") ?? "";
    if (!/^[a-z][a-z0-9-]*$/.test(name) || namedTypes.has(name)) {
      fail("HC013", "Named <type> declarations require distinct lowercase names.", source);
    }
    try { parseTypeExpression(name); }
    catch { namedTypes.set(name, element); continue; }
    fail("HC013", `Named type \`${name}\` conflicts with a built-in type.`, source);
  }
  const selectedType = (element: Element): NonNullable<PropContract["select"]> => {
    const fail: DiagnosticFail = locatedFail(element);
    const from = attr(element, "from") ?? "";
    const selectorProp = elements.find((candidate) => attr(candidate, "name") === from);
    const selector = selectorProp ?? (group === undefined ? undefined : directElements(group, "state")
      .find((candidate) => attr(candidate, "name") === from));
    if (selector === undefined || attr(selector, "type") === undefined) {
      fail("HC013", `<type from="${from}"> must name a declared prop or state with finite values.`, source);
    }
    const selectorType = normalizeType(parseTypeAttribute(attr(selector, "type")!));
    const selectorValues = parseValuesConstraint(selectorType, attr(selector, "values"));
    if (selectorValues === undefined) {
      fail("HC013", `<type from="${from}"> requires a valid values constraint.`, source);
    }
    if (selectorProp !== undefined && attr(selector, "default") === undefined && attr(selector, "required") === undefined) {
      fail("HC013", `Selecting prop \`${from}\` must be required or have a default.`, source);
    }
    const options: { value: string | number | boolean; type: TypeNode }[] = [];
    for (const node of significant(sourceChildren(element))) {
      if (!isElement(node) || sourceTag(node) !== "option") {
        fail("HC013", "A <type> contains <option> elements only.", source);
      }
      const value = attr(node, "value");
      const type = attr(node, "type");
      if (value === undefined || type === undefined || directElements(node, "option").length > 0) {
        fail("HC013", "Each type <option> requires `value` and `type` attributes.", source);
      }
      const parsed = parseTypedValue(value, selectorType);
      if (!parsed.ok || options.some((option) => option.value === parsed.value)) {
        fail("HC013", `Type option \`${value}\` is not a distinct selector member.`, source);
      }
      options.push({ value: parsed.value as string | number | boolean, type: normalizeType(parseTypeAttribute(type)) });
    }
    if (options.length !== selectorValues.length ||
      selectorValues.some((member) => !options.some((option) => option.value === member))) {
      fail("HC013", `<type from="${from}"> must cover every permitted selector value exactly once.`, source);
    }
    return { from, options };
  };
  const props = Object.create(null) as Record<string, PropContract>;
  const normalizedNames = Object.create(null) as Record<string, string>;
  if (group === undefined) return props;
  elements.sort((left, right) => {
    const leftName = attr(left, "name") ?? "";
    const rightName = attr(right, "name") ?? "";
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  for (const element of elements) {
    try {
      const fail: DiagnosticFail = locatedFail(element);
      const name = attr(element, "name");
      if (name === undefined || name === "") {
        fail("HC010", "A <prop> requires a `name` attribute.", source);
      }
      if (!isIdentifier(name)) {
        fail("HC010", `Invalid prop name \`${name}\`.`, source);
      }
      const typeAttribute = attr(element, "type");
      const inline = directElements(element, "type");
      if (inline.length > 1 || (inline.length === 1 && typeAttribute !== undefined)) {
        fail("HC013", `Prop \`${name}\` must declare one type, inline or by attribute.`, source);
      }
      if ((typeAttribute === undefined || typeAttribute === "") && inline.length === 0) {
        fail("HC013", `Prop \`${name}\` requires a \`type\` attribute.`, source);
      }
      const normalizedName = name.toLowerCase();
      const priorName = normalizedNames[normalizedName];
      if (priorName !== undefined) {
        fail("HC011", `Props \`${priorName}\` and \`${name}\` collide after lowercase normalization.`, source);
      }
      normalizedNames[normalizedName] = name;
      let target = targets[name];
      if (target === undefined && requireBinding) {
        fail("HC018", `Prop \`${name}\` is declared but never bound in the markup.`, source);
      }
      target ??= { attribute: name.toLowerCase() };
      const selected = inline[0] ?? namedTypes.get(typeAttribute ?? "");
      if (inline[0] !== undefined && attr(inline[0], "name") !== undefined) {
        fail("HC013", "An inline <type> has no name; put named types directly under <defs>.", source);
      }
      const select = selected === undefined ? undefined : selectedType(selected);
      const type = select === undefined ? readDeclaredType(element, source, false, warnInvalidDeclaration)
        : { kind: "selected", from: select.from, options: select.options } as const;
      const required = attr(element, "required") !== undefined;
      const values = parseValuesConstraint(type, attr(element, "values"));
      if (attr(element, "values") !== undefined && values === undefined) {
        const message = `Prop \`${name}\` has a values constraint that does not conform to its type; the constraint is ignored.`;
        if (warnInvalidDeclaration === undefined) fail("HC013", message, source);
        warnInvalidDeclaration(message, source);
      }
      const { bounds, invalid } = parseValueBounds(type, {
        min: attr(element, "min"), max: attr(element, "max"),
        minLength: attr(element, "minlength"), maxLength: attr(element, "maxlength"),
        pattern: attr(element, "pattern"),
      });
      for (const key of invalid) {
        const message = `Prop \`${name}\` has a ${key} constraint that does not conform to its type; the constraint is ignored.`;
        if (warnInvalidDeclaration === undefined) fail("HC013", message, source);
        warnInvalidDeclaration(message, source);
      }
      const description = textContent(element).trim();
      if (description === "") {
        fail("HC003", `\`props.${name}.description\` must be a non-empty string.`, source);
      }
      if (!isAttributeType(type)) {
        fail(
          "HC017",
          `Prop \`${name}\` cannot be written as an HTML attribute; function, unknown, and trusted content types have no text form.`,
          source,
        );
      }
      const defaultValue = attr(element, "default");
      if (required && defaultValue !== undefined) {
        fail("HC019", `Required prop \`${name}\` cannot also declare a default.`, source);
      }
      const spec: {
        type: PropContract["type"];
        values?: readonly (string | number | boolean)[];
        select?: NonNullable<PropContract["select"]>;
        pattern?: string;
        min?: number | string;
        max?: number | string;
        minLength?: number;
        maxLength?: number;
        required: boolean;
        default?: PropValue;
        target: PropTarget;
        description: string;
      } = { type, required, target, description };
      if (values !== undefined) spec.values = values;
      if (select !== undefined) spec.select = select;
      Object.assign(spec, bounds);
      if (defaultValue !== undefined) {
        let defaultType = type;
        if (select !== undefined) {
          const selector = elements.find((candidate) => attr(candidate, "name") === select.from);
          if (selector === undefined) {
            fail("HC015", `Prop \`${name}\` needs a prop-selected type before it can declare its own default.`, source);
          }
          const selectorDefault = attr(selector, "default");
          if (selectorDefault === undefined) {
            fail("HC015", `Prop \`${name}\` needs a selector default before it can declare its own default.`, source);
          }
          const selected = parseTypedValue(selectorDefault, parseTypeAttribute(attr(selector, "type")!));
          if (!selected.ok) fail("HC015", `Default for selecting prop \`${select.from}\` is invalid.`, source);
          defaultType = select.options.find((option) => option.value === selected.value)!.type;
        }
        const parsed = parseTypedValue(defaultValue, defaultType);
        if (!parsed.ok || !matchesPropBounds(parsed.value, defaultType, bounds) || !matchesPropValues(parsed.value, values)) fail("HC015", `Default for prop \`${name}\` does not satisfy its type.`, source);
        spec.default = parsed.value as PropValue;
      }
      props[name] = spec;
    } catch (error) { recoverSource(error, element, source, onDiagnostic); }
  }
  return props;
}

function readContract(...args: Parameters<typeof readContractAtSource>): ReturnType<typeof readContractAtSource> {
  return withDiagnosticLocation(sourceLocation(args[0]), () => readContractAtSource(...args));
}

function readContractAtSource(
  wrapper: Element,
  group: Element | undefined,
  nativeElement: string,
  delegatedRoot: boolean,
  targets: Record<string, PropTarget>,
  source: string,
  requireBinding: boolean,
  warnInvalidDeclaration?: ComponentParserPlatform["warnInvalidDeclaration"],
  onDiagnostic?: ComponentParserPlatform["onDiagnostic"],
): ComponentContract {
  const tag = attr(wrapper, "component") ?? "";
  if (tag.trim() === "") fail("HC003", "`component` must be a non-empty string.", source);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(tag)) {
    fail("HC005", "The `component` tag must be lowercase and contain a hyphen.", source);
  }
  const status = attr(wrapper, "status");
  if (status !== undefined && !/^(?:early|experimental|stable|deprecated)$/.test(status)) {
    fail("HC007", "Component `status` is not recognized.", source);
  }
  const summary = attr(wrapper, "summary");
  if (summary !== undefined && summary.trim() === "") fail("HC003", "`summary` must be a non-empty string.", source);
  if (
    !/^[a-z][a-z0-9-]*$/.test(nativeElement) ||
    (delegatedRoot && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(nativeElement))
  ) {
    fail("HC008", "`nativeElement` must be a lowercase HTML element or component tag.", source);
  }
  return {
    version: 1,
    name: componentName(tag),
    tag,
    ...(status === undefined ? {} : { status: status as ContractStatus }),
    ...(summary === undefined ? {} : { summary }),
    nativeElement,
    props: readProps(group, targets, source, requireBinding, warnInvalidDeclaration, onDiagnostic),
  };
}

function compileDeclarationExpression(value: string, source: string, path = false) {
  try {
    const expression = path ? compilePath(value) : compileExpression(value);
    checkExpressionSemantics(expression.ast);
    return expression;
  } catch {
    fail("HT013", `Malformed expression \`${value}\`.`, source);
  }
}

function readHandlerSteps(...args: Parameters<typeof readHandlerStepsAtSource>): ReturnType<typeof readHandlerStepsAtSource> {
  return withDiagnosticLocation(sourceLocation(args[0]), () => readHandlerStepsAtSource(...args));
}

function readHandlerStepsAtSource(
  handler: Element,
  scope: ParseScope,
  source: string,
  stateTypes: ReadonlyMap<string, TypeNode>,
  eventTypes: ReadonlyMap<string, TypeNode>,
): HandlerStep[] {
  const steps: HandlerStep[] = [];
  for (const step of significant(sourceChildren(handler))) {
    if (!isElement(step)) fail("HC023", "Handler bodies contain declarative step elements only.", source);
    const guardSource = attr(step, "$if");
    const guard =
      guardSource === undefined ? undefined : compileScopedExpression(guardSource, scope, source);
    if (sourceTag(step) === "set") {
      const path = attr(step, "name") ?? "";
      if (attr(step, ":value") !== undefined || attr(step, "from:value") !== undefined) {
        fail("HC023", "Use `expr:value` for an expression on <set>.", source);
      }
      const literal = attr(step, "value");
      const expressionSource = attr(step, "expr:value");
      if (path === "" || (literal === undefined) === (expressionSource === undefined)) {
        fail("HC023", "A <set> requires `name` and exactly one of `value` or `expr:value`.", source);
      }
      compileScopedExpression(path, scope, source, true);
      const writablePath = getWritablePath(path, scope.writableRoots);
      if (writablePath === undefined) {
        fail("HT005", `Handler write \`${path}\` is not rooted in declared state.`, source);
      }
      let type = stateTypes.get(String(writablePath[0]));
      for (const key of writablePath.slice(1)) {
        type = type === undefined || typeof key === "object" ? undefined : typeAtKey(type, key);
      }
      const parsedLiteral = literal === undefined || type === undefined ? undefined : parseTypedValue(literal, type);
      if (parsedLiteral !== undefined && !parsedLiteral.ok) {
        fail("HC023", `<set name="${path}"> has a value that does not satisfy its state type.`, source);
      }
      const parsed: {
        kind: "set";
        path: string;
        writablePath: NonNullable<ReturnType<typeof getWritablePath>>;
        value: CompiledExpression;
        guard?: CompiledExpression;
      } = {
        kind: "set",
        path,
        writablePath,
        value: compileScopedExpression(expressionSource ?? JSON.stringify(parsedLiteral?.ok ? parsedLiteral.value : literal), scope, source),
      };
      if (guard !== undefined) parsed.guard = guard;
      steps.push(parsed);
      continue;
    }
    if (sourceTag(step) === "dispatch") {
      const event = attr(step, "event") ?? "";
      if (!EVENT_PART_RE.test(event)) {
        fail("HC023", "A <dispatch> requires a valid `event` name.", source);
      }
      if (attr(step, ":value") !== undefined || attr(step, ":detail") !== undefined || attr(step, "from:value") !== undefined) {
        fail("HC023", "Use `expr:value` for an expression on <dispatch>.", source);
      }
      const target = attr(step, "target");
      if (target !== undefined && !NAME_RE.test(target)) fail("HC023", "A <dispatch> target must name a component-local $ref.", source);
      const expressionSource = attr(step, "expr:value");
      const literal = attr(step, "value");
      if (expressionSource !== undefined && literal !== undefined) {
        fail("HC023", "A <dispatch> may declare only one of `value` or `expr:value`.", source);
      }
      const eventType = eventTypes.get(event);
      const parsedLiteral = literal === undefined || eventType === undefined ? undefined : parseTypedValue(literal, eventType);
      if (parsedLiteral !== undefined && !parsedLiteral.ok) {
        fail("HC023", `<dispatch event="${event}"> has a value that does not satisfy its event type.`, source);
      }
      const value =
        expressionSource === undefined && literal === undefined
          ? undefined
          : compileScopedExpression(expressionSource ?? JSON.stringify(parsedLiteral?.ok ? parsedLiteral.value : literal), scope, source);
      const parsed: {
        kind: "dispatch";
        target?: string;
        event: string;
        value?: CompiledExpression;
        guard?: CompiledExpression;
      } = {
        kind: "dispatch",
        event,
      };
      if (target !== undefined) parsed.target = target;
      if (value !== undefined) parsed.value = value;
      if (guard !== undefined) parsed.guard = guard;
      steps.push(parsed);
      continue;
    }
    if (sourceTag(step) === "validate" || sourceTag(step) === "focus") {
      const target = attr(step, "target") ?? attr(step, "ref") ?? attr(step, "name") ?? "";
      if (!NAME_RE.test(target)) {
        fail("HC023", `<${sourceTag(step)}> requires a valid target reference.`, source);
      }
      const parsed: {
        kind: "validate" | "focus";
        target: string;
        guard?: CompiledExpression;
      } = {
        kind: sourceTag(step) as "validate" | "focus",
        target,
      };
      if (guard !== undefined) parsed.guard = guard;
      steps.push(parsed);
      continue;
    }
    fail("HC023", `<${sourceTag(step)}> is not a recognized handler step.`, source);
  }
  return steps;
}

/** A request's detail or answer type, from its attribute or expanded form; `fallback` when neither is written. */
function requestType(element: Element, attribute: string | undefined, expanded: boolean, fallback: TypeNode, source: string,
  warnInvalidDeclaration: ComponentParserPlatform["warnInvalidDeclaration"]): TypeNode {
  if (expanded) return normalizeType(readDeclaredType(element, source, true, warnInvalidDeclaration));
  return attribute === undefined ? fallback : normalizeType(parseTypeAttribute(attribute));
}

function readDeclarations(
  group: Element | undefined,
  contract: ComponentContract,
  source: string,
  warnInvalidDeclaration?: ComponentParserPlatform["warnInvalidDeclaration"],
  onDiagnostic?: ComponentParserPlatform["onDiagnostic"],
  warn?: ComponentParserPlatform["warn"],
): {
  declarations: ComponentDeclaration[]; scope: ParseScope; requests?: Record<string, RequestContract>;
  head?: HeadDeclaration[]; scripts?: ScriptDeclaration[];
} {
  const declarations: ComponentDeclaration[] = [];
  const roots = new Set(Object.keys(contract.props));
  const writableRoots = new Set<string>();
  const handlers = new Set<string>();
  if (group === undefined) return { declarations, scope: { roots, writableRoots, handlers, report: onDiagnostic ?? warn } };
  if (onDiagnostic !== undefined) {
    for (const prop of directElements(group, "prop")) {
      const name = attr(prop, "name");
      if (name !== undefined && isIdentifier(name)) roots.add(name);
    }
  }
  const invalid = onDiagnostic === undefined ? undefined : new Set<Element>();
  const elements: Element[] = [];
  const stateTypes = new Map<string, TypeNode>();
  const eventTypes = new Map<string, TypeNode>();
  const names = new Set<string>();
  const eventNames = new Set<string>();
  const requestElements = new Map<string, Element>();
  // A build tool fails an interface declaration the proposal forbids; the live parser warns and ignores it.
  const ignored = new Set<Element>();
  const reject = (element: Element, code: string, message: string): void => {
    if (warnInvalidDeclaration === undefined) locatedFail(element)(code, message, source);
    warn?.({ code, message, source, ...sourceLocation(element), severity: "warning" });
    ignored.add(element);
  };
  for (const node of sourceChildren(group)) {
    if (!isElement(node)) continue;
    const element = node;
    try {
      const fail: DiagnosticFail = locatedFail(element);
      elements.push(element);
      const kind = sourceTag(element);
      if (!/^(?:prop|type|state|computed|data|context|handler|event|request)$/.test(kind) && !HEAD_ELEMENT_RE.test(kind)) {
        fail("HC021", `<${kind}> is not a recognized definition declaration.`, source);
      }
      if (kind === "type") continue;
      if (HEAD_ELEMENT_RE.test(kind)) {
        // A named declared script shares the flat namespace: `$stripe` reads its status.
        const scriptName = kind === "script" ? attr(element, "name") : undefined;
        if (scriptName === undefined) continue;
        if (!isIdentifier(scriptName)) fail("HC013", `Script name \`${scriptName}\` is not a valid expression identifier.`, source);
        if (names.has(scriptName) || Object.hasOwn(contract.props, scriptName)) {
          fail("HC020", `Declaration \`${scriptName}\` collides in the flat component scope.`, source);
        }
        names.add(scriptName);
        roots.add(scriptName);
        continue;
      }
      const name = attr(element, "name") ?? "";
      if (name === "") fail("HC010", `A <${kind}> requires a \`name\` attribute.`, source);
      if ((kind === "event" || kind === "request") && name === "responder") {
        reject(element, "HC010", `<${kind} name="responder"> takes the name of the host event that announces late responders.`);
        continue;
      }
      if (kind === "request") {
        if (!EVENT_PART_RE.test(name)) fail("HC010", `Request name \`${name}\` must be lowercase kebab case.`, source);
        if (requestElements.has(name)) fail("HC020", `Request \`${name}\` is declared more than once.`, source);
        requestElements.set(name, element);
        continue;
      }
      if (kind === "event") {
        if (eventNames.has(name)) fail("HC020", `Event \`${name}\` is declared more than once.`, source);
        eventNames.add(name);
        const eventType = attr(element, "type") ?? "object";
        const shape = directElements(element, "prop").length > 0 || attr(element, "values") !== undefined || attr(element, "nullable") !== undefined
          ? normalizeType(readDeclaredType(element, source, true, warnInvalidDeclaration))
          : normalizeType(parseTypeAttribute(eventType));
        eventTypes.set(name, shape);
        continue;
      }
      const localName = kind === "context" ? attr(element, "as") ?? name : name;
      if (kind === "context" && !isIdentifier(localName)) {
        fail("HC013", `<context name="${name}"> has an invalid local name.`, source);
      }
      if (kind !== "handler" && !isIdentifier(localName)) {
        fail("HC013", `Declaration \`${localName}\` is not a valid expression identifier.`, source);
      }
      if (names.has(localName)) {
        fail("HC020", `Declaration \`${localName}\` collides in the flat component scope.`, source);
      }
      names.add(localName);
      roots.add(localName);
      if (kind === "state") writableRoots.add(name);
      else if (kind === "handler") handlers.add(name);
      if (kind === "state" && attr(element, "type") !== undefined) {
        const stateType = attr(element, "type")!;
        const shape = directElements(element, "prop").length > 0 || attr(element, "values") !== undefined || attr(element, "nullable") !== undefined
          ? normalizeType(readDeclaredType(element, source, true, warnInvalidDeclaration))
          : normalizeType(parseTypeAttribute(stateType));
        stateTypes.set(name, shape);
      }
    } catch (error) {
      recoverSource(error, element, source, onDiagnostic);
      invalid?.add(element);
    }
  }
  for (const [name, element] of requestElements) {
    try {
      if (eventNames.has(name)) {
        reject(element, "HC020", `Event and request \`${name}\` share a name; a component either announces it or asks it.`);
      } else if (warnInvalidDeclaration === undefined && Object.hasOwn(contract.props, requestPropName(name))) {
        // A framework component takes the function that answers the request under this prop name.
        locatedFail(element)("HC011", `Request \`${name}\` and prop \`${requestPropName(name)}\` collide as a framework prop.`, source);
      }
    } catch (error) {
      recoverSource(error, element, source, onDiagnostic);
      invalid?.add(element);
    }
  }

  const declarationScope = { roots, writableRoots, handlers, report: onDiagnostic ?? warn };
  const requests: Record<string, RequestContract> = {};
  const head: HeadDeclaration[] = [];
  const scripts: ScriptDeclaration[] = [];
  const headKeys = new Set<string>();
  for (const element of elements) {
    if (invalid?.has(element) || ignored.has(element)) continue;
    const scope = { ...declarationScope, at: sourceLocation(element) };
    try {
      const fail: DiagnosticFail = locatedFail(element);
      const kind = sourceTag(element);
      if (kind === "prop" || kind === "type") continue;
      if (HEAD_ELEMENT_RE.test(kind)) {
        withDiagnosticLocation(sourceLocation(element), () =>
          readHeadDeclaration(element, scope, source, head, scripts, headKeys, warn));
        continue;
      }
      const name = attr(element, "name")!;

      if (kind === "request") {
        const returns = directElements(element, "returns");
        const written = attr(element, "returns");
        if (returns.length > 1 || (returns.length === 1 && written !== undefined)) {
          fail("HC013", `Request \`${name}\` declares its answer's type once, by \`returns\` or one <returns>.`, source);
        }
        const description = textContent(element).trim();
        requests[name] = {
          type: requestType(element, attr(element, "type"), directElements(element, "prop").length > 0, NULL_TYPE, source, warnInvalidDeclaration),
          returns: returns[0] === undefined ? requestType(element, written, false, UNKNOWN_TYPE, source, warnInvalidDeclaration)
            : requestType(returns[0], undefined, true, UNKNOWN_TYPE, source, warnInvalidDeclaration),
          ...(description === "" ? {} : { description }),
        };
        continue;
      }

      if (kind === "context") {
        const from = attr(element, "from");
        if (from === undefined || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(from)) {
          fail("HC013", `<context name="${name}"> requires a component tag in \`from\`.`, source);
        }
        const as = attr(element, "as");
        declarations.push({ kind, name, from, ...(as === undefined ? {} : { as }) });
        continue;
      }

      if (kind === "state") {
        if (attr(element, ":value") !== undefined || attr(element, "from:value") !== undefined) {
          fail("HC013", `<state name="${name}"> uses a literal \`value\`; use <computed from> for a derived value.`, source);
        }
        const literal = attr(element, "value");
        const declaration: {
          kind: "state";
          name: string;
          type?: string;
          shape?: TypeNode;
          value?: string;
          expression?: CompiledExpression;
        } = {
          kind,
          name,
        };
        if (attr(element, "context") !== undefined) {
          fail("HC013", `<state name="${name}"> does not use a \`context\` attribute; descendant <context> declarations can read any named ancestor state.`, source);
        }
        // A declared type states what the state holds, as a prop's does.
        const stateType = attr(element, "type");
        if (stateType !== undefined) {
          if (directElements(element, "prop").length > 0 || attr(element, "values") !== undefined || attr(element, "nullable") !== undefined) {
            declaration.shape = normalizeType(readDeclaredType(element, source, true, warnInvalidDeclaration));
          } else parseTypeAttribute(stateType);
          declaration.type = stateType;
        } else if (directElements(element, "prop").length > 0 || attr(element, "values") !== undefined) {
          fail("HC013", `<state name="${name}"> needs a type for its nested fields or values.`, source);
        }
        let initial: unknown = literal;
        if (literal !== undefined && stateType !== undefined) {
          const parsed = parseTypedValue(literal, declaration.shape ?? parseTypeExpression(stateType), "$", "html");
          if (!parsed.ok) fail("HC013", `<state name="${name}"> has a value that does not satisfy its type.`, source);
          initial = parsed.value;
        }
        const expression = literal === undefined
          ? undefined
          : compileScopedExpression(JSON.stringify(initial), scope, source);
        if (literal !== undefined) declaration.value = literal;
        if (expression !== undefined) declaration.expression = expression;
        declarations.push(declaration);
        continue;
      }
      if (kind === "computed") {
        const expressionSource = attr(element, "from");
        if (expressionSource === undefined || expressionSource === "") {
          fail("HC013", `<computed name="${name}"> requires a \`from\` expression.`, source);
        }
        declarations.push({
          kind,
          name,
          expression: compileScopedExpression(expressionSource, scope, source),
        });
        continue;
      }
      if (kind === "data") {
        const dataSource = attr(element, "src");
        const dataType = attr(element, "type");
        const dataDebounce = attr(element, "debounce");
        const dataPoll = attr(element, "poll");
        // Validate here so an unreadable time value is a diagnostic, not a silently ignored delay.
        for (const [timing, text] of [["debounce", dataDebounce], ["poll", dataPoll]] as const) {
          if (text !== undefined && parseDuration(text) === undefined) {
            fail("HC024", `Data source \`${name}\` has an unreadable \`${timing}\` time \`${text}\`.`, source);
          }
        }
        if (dataType !== undefined) {
          try { parseTypeExpression(dataType); }
          catch { fail("HC024", `Data source \`${name}\` declares an unreadable type \`${dataType}\`.`, source); }
        }
        const parameters = [];
        const parameterNames = new Set<string>();
        for (const parameter of directElements(element, "param")) {
          const parameterName = attr(parameter, "name") ?? "";
          const from = attr(parameter, "from:value");
          const expr = attr(parameter, "expr:value");
          if (!NAME_RE.test(parameterName) || (from === undefined) === (expr === undefined)) {
            fail("HC024", "A data <param> requires a valid `name` and exactly one of `from:value` or `expr:value`.", source);
          }
          if (parameterNames.has(parameterName)) {
            fail("HC024", `Data source \`${name}\` repeats a parameter name.`, source);
          }
          parameterNames.add(parameterName);
          parameters.push({
            name: parameterName,
            mode: from === undefined ? "expr" as const : "from" as const,
            expression: compileScopedExpression(from ?? expr!, scope, source),
          });
        }
        const declaration: {
          kind: "data";
          name: string;
          source?: string;
          type?: string;
          debounce?: string;
          poll?: string;
          parameters: typeof parameters;
        } = {
          kind,
          name,
          parameters,
        };
        if (dataSource !== undefined) declaration.source = dataSource;
        if (dataType !== undefined) declaration.type = dataType;
        if (dataDebounce !== undefined) declaration.debounce = dataDebounce;
        if (dataPoll !== undefined) declaration.poll = dataPoll;
        declarations.push(declaration);
        continue;
      }
      if (kind === "event") {
        const eventType = attr(element, "type") ?? "object";
        const shape = directElements(element, "prop").length > 0 || attr(element, "values") !== undefined
          ? normalizeType(readDeclaredType(element, source, true, warnInvalidDeclaration)) : undefined;
        if (shape === undefined) parseTypeAttribute(eventType);
        declarations.push({
          kind,
          name,
          type: eventType,
          ...(shape === undefined ? {} : { shape }),
          bubbles: attr(element, "bubbles") !== "false",
          composed: attr(element, "composed") !== "false",
          cancelable: attr(element, "cancelable") === "true",
        });
        continue;
      }
      declarations.push({
        kind: "handler",
        name,
        steps: readHandlerSteps(element, { ...scope, roots: new Set([...roots, "$$event"]) }, source, stateTypes, eventTypes),
      });
    } catch (error) { recoverSource(error, element, source, onDiagnostic); }
  }
  for (const declaration of declarations) {
    if (declaration.kind !== "handler") continue;
    for (const step of declaration.steps) {
      if (step.kind === "dispatch" && !eventNames.has(step.event)) {
        fail("HC023", `Handler \`${declaration.name}\` dispatches undeclared component event \`${step.event}\`.`, source);
      }
    }
  }
  return {
    declarations, scope: declarationScope,
    ...(Object.keys(requests).length === 0 ? {} : { requests }),
    ...(head.length === 0 ? {} : { head }),
    ...(scripts.length === 0 ? {} : { scripts }),
  };
}

const LOADING_RE = /^(?:eager|lazy|manual)$/;

/**
 * Reads one head declaration in `<defs>` (components#head-elements): a `<title>`, `<meta>`,
 * `<link>`, JSON-LD block, or declared `<script src>`. Policy elements, inline code and attributes
 * HTML does not define for the element are invalid, so the definition is rejected.
 */
function readHeadDeclaration(
  element: Element,
  scope: ParseScope,
  source: string,
  head: HeadDeclaration[],
  scripts: ScriptDeclaration[],
  keys: Set<string>,
  warn: ComponentParserPlatform["warn"],
): void {
  const tag = sourceTag(element);
  const attributes = Array.from(sourceAttributes(element));
  const literal = (name: string): string | undefined => attributes.find((attribute) => attribute.name === name)?.value;
  const once = (key: string, what: string): void => {
    if (keys.has(key)) fail("HC027", `A definition declares ${what} once.`, source);
    keys.add(key);
  };
  for (const { name } of attributes) {
    if (name === "blocking") fail("HC025", "The render-blocking `blocking` attribute is invalid in a definition.", source);
    if (name === "nonce") fail("HC025", "A `nonce` comes from the application, never from a definition.", source);
    if (/^on(?!:)/i.test(name) || (name.startsWith("on:") && tag !== "script")) {
      fail("HC025", `<${tag} ${name}> is an event-handler attribute; a head declaration cannot run code.`, source);
    }
  }
  if (tag === "script") {
    const type = literal("type")?.trim().toLowerCase();
    if (type === "application/ld+json") {
      for (const { name } of attributes) {
        if (name !== "type" && name !== "from:value") fail("HC026", `A JSON-LD block takes only \`type\` and \`from:value\`, not \`${name}\`.`, source);
      }
      const text = textContent(element);
      const bound = literal("from:value");
      if (bound !== undefined) {
        if (text.trim() !== "") fail("HC026", "A JSON-LD block has literal content or `from:value`, not both.", source);
        head.push({ kind: "json", value: compileScopedExpression(bound, scope, source) });
        return;
      }
      try { JSON.parse(text); }
      catch { fail("HC026", "A JSON-LD block's content is not valid JSON.", source); }
      head.push({ kind: "json", text });
      return;
    }
    const src = literal("src");
    if (src === undefined) {
      fail("HC025", "An inline executable `<script>` is invalid in a definition; declare the script by its `src`.", source);
    }
    if (type !== undefined && type !== "" && type !== "module") {
      fail("HC025", type === "importmap"
        ? "An import map is invalid in a definition; only the application document's import map resolves bare names."
        : `A declared script is classic or \`type="module"\`, not \`type="${type}"\`.`, source);
    }
    if (textContent(element).trim() !== "") fail("HC025", "A declared `<script src>` cannot also contain code.", source);
    if (src.trim() === "") fail("HC025", "A declared script requires a non-empty `src`.", source);
    if (hasExecutableUrl(src)) fail("HT007", "Literal `src` contains an executable URL.", source);
    const declaration: { -readonly [K in keyof ScriptDeclaration]: ScriptDeclaration[K] } = { src, loading: "eager" };
    for (const { name, value } of attributes) {
      if (name === "src" || name === "type") continue;
      if (name === "name") declaration.name = value;
      else if (name === "loading") {
        if (!LOADING_RE.test(value)) fail("HC025", `A declared script loads \`eager\`, \`lazy\` or \`manual\`, not \`${value}\`.`, source);
        declaration.loading = value as ScriptDeclaration["loading"];
      } else if (name === "on:load" || name === "on:error") {
        if (!scope.handlers.has(value)) fail("HT010", `Event binding \`${name}\` names undeclared handler \`${value}\`.`, source);
        declaration[name === "on:load" ? "load" : "error"] = value;
      } else if ((SCRIPT_STANDARD_ATTRIBUTES as readonly string[]).includes(name)) {
        declaration[name as typeof SCRIPT_STANDARD_ATTRIBUTES[number]] = value;
      } else if (name === "async" || name === "defer") {
        fail("HC025", `\`${name}\` adds nothing to a declared script: a script inserted through the DOM runs as soon as it arrives.`, source);
      } else {
        fail("HC025", `A declared script does not accept \`${name}\`.`, source);
      }
    }
    if (type === "module") declaration.type = "module";
    if (declaration.loading === "manual" && declaration.name === undefined) {
      fail("HC025", 'A `loading="manual"` script requires a `name`, so a controller can call `load()`.', source);
    }
    scripts.push(declaration);
    return;
  }
  const allowed = HEAD_ATTRIBUTES[tag]!;
  const bindable = tag === "meta" ? "content" : tag === "link" ? "href" : undefined;
  const parsed: (LiteralAttribute | AttributeBinding)[] = [];
  for (const { name, value } of attributes) {
    if (bindable !== undefined && name === `from:${bindable}`) {
      parsed.push({ kind: "attribute", name: bindable, expression: value, expressionPlan: compileScopedExpression(value, scope, source) });
      continue;
    }
    if (tag === "meta" && (name === "http-equiv" || name === "charset")) {
      fail("HC025", `\`<meta ${name}>\` sets document policy or encoding; it is invalid in a definition.`, source);
    }
    if (!allowed.has(name)) {
      fail("HC025", name.includes(":") || name.startsWith("$") || name.startsWith(".")
        ? `<${tag}> binds ${bindable === undefined ? "nothing" : `only \`from:${bindable}\``}; \`${name}\` is not a head binding.`
        : `<${tag}> does not accept \`${name}\`.`, source);
    }
    validateLiteralAttributeName(name, source, value);
    parsed.push({ kind: "literal", name, value });
  }
  const has = (name: string): boolean => parsed.some((attribute) => attribute.name === name);
  if (tag === "title") {
    once("title", "one `<title>`");
    head.push({ kind: "title", text: parseText(textContent(element), scope, source) as TextNode[] });
    return;
  }
  if (bindable !== undefined && !has(bindable)) fail("HC025", `<${tag}> requires \`${bindable}\` or \`from:${bindable}\`.`, source);
  if (parsed.filter((attribute) => attribute.name === bindable).length > 1) {
    fail("HC025", `<${tag}> takes \`${bindable}\` or \`from:${bindable}\`, not both.`, source);
  }
  if (tag === "meta") {
    const name = literal("name");
    if ((name === undefined) === (literal("property") === undefined)) {
      fail("HC025", "A `<meta>` head declaration has one `name` or one `property`.", source);
    }
    if (name?.toLowerCase() === "component-src") {
      // Only the application document's own head says which sources supply application components.
      const message = '`<meta name="component-src">` belongs to the application document; a component\'s is ignored.';
      if (warn === undefined) fail("HC028", message, source);
      warn({ code: "HC028", message, source, ...scope.at, severity: "warning" });
      return;
    }
  } else {
    const rel = literal("rel")?.trim().toLowerCase() ?? "";
    if (/(?:^|\s)stylesheet(?:\s|$)/.test(rel)) {
      fail("HC025", "`<link rel=\"stylesheet\">` is not a head declaration: a component's CSS is its scoped `<style>`, including `@import`.", source);
    }
    if (/(?:^|\s)import(?:\s|$)/.test(rel)) fail("HC025", "HTML Imports (`<link rel=\"import\">`) are invalid in a definition.", source);
    if (!HEAD_LINK_RELS.has(rel)) fail("HC025", `\`<link rel="${rel}">\` is not a head declaration.`, source);
    const href = literal("href");
    if (rel === "canonical") once("canonical", "one canonical link");
    else if (href !== undefined) once(`link ${rel} ${href}`, `one \`<link rel="${rel}" href="${href}">\``);
  }
  head.push({ kind: tag as "meta" | "link", attributes: parsed });
}

const NULL_TYPE: TypeNode = { kind: "terminal", name: "null" };
const UNKNOWN_TYPE: TypeNode = { kind: "terminal", name: "unknown" };

function parseAttributes(
  sourceAttributes: readonly SourceAttribute[],
  tagName: string,
  contract: ComponentContract,
  scope: ParseScope,
  source: string,
  platform: ComponentParserPlatform,
): TemplateAttribute[] {
  const parsed: TemplateAttribute[] = [];
  for (const attribute of sourceAttributes) {
    if (attribute.name.startsWith("bind:")) {
      const name = attribute.name.slice("bind:".length).toLowerCase();
      if (name === "" || RAW_SINK_RE.test(name)) {
        fail("HT007", `Two-way binding cannot target \`${name || attribute.name}\`.`, source);
      }
      const expressionPlan = compileScopedExpression(attribute.value, scope, source, true);
      const writable = writableAt(expressionPlan.ast, scope);
      if (!("path" in writable)) {
        fail("HT005", writable.reason === undefined ? `\`${attribute.value}\` is not a writable state-rooted path.`
          : `\`${attribute.value}\` is not writable: ${writable.reason}.`, source);
      }
      const writablePath = writable.path;
      parsed.push({
        kind: "attribute",
        name,
        // The path's read side, spelled as the expression `$path` for every consumer.
        expression: expressionPlan.source,
        expressionPlan,
        twoWay: true,
        writablePath,
      });
      continue;
    }

    if (attribute.name.startsWith("class:") || attribute.name.startsWith("style:")) {
      const target = attribute.name.startsWith("class:") ? "class" : "style";
      const name = attribute.name.slice(target.length + 1);
      const valid =
        target === "class"
          ? name !== "" && !/\s/.test(name)
          : /^(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)$/.test(name);
      if (!valid) {
        fail("HT020", `\`${attribute.name}\` does not name a valid ${target} binding target.`, source);
      }
      parsed.push({
        kind: "attribute",
        name,
        expression: attribute.value,
        expressionPlan: compileScopedExpression(attribute.value, scope, source),
        target,
      });
      continue;
    }

    if (attribute.name.startsWith("$")) {
      const name = attribute.name.slice(1).toLowerCase();
      if (name !== "value" && name !== "html") {
        fail("HT012", `\`$${name}\` is not a known content directive.`, source);
      }
      parsed.push({
        kind: "directive",
        name,
        expression: attribute.value,
        expressionPlan: compileScopedExpression(attribute.value, scope, source),
      });
      continue;
    }

    if (attribute.name.startsWith("from:")) {
      const name = attribute.name.slice("from:".length).toLowerCase();
      if (RAW_SINK_RE.test(name)) {
        fail("HT007", `\`from:${name}\` cannot bind a raw content sink.`, source);
      }
      const expressionPlan = compileScopedExpression(attribute.value, scope, source);
      parsed.push({ kind: "attribute", name, expression: attribute.value, expressionPlan });
      continue;
    }

    if (attribute.name.startsWith(".")) {
      const key = attribute.name.slice(1).toLowerCase();
      const expressionPlan = compileScopedExpression(attribute.value, scope, source);
      // Property bindings reach native DOM properties only; component inputs are attributes.
      const name = platform.resolveDomProperty(tagName, key);
      if (name === undefined) {
        fail("HP001", `\`${key}\` is not a native property of <${tagName}>.`, source);
      }
      validateMvpDomProperty(name, source);
      parsed.push({ kind: "property", key, name, expression: attribute.value, expressionPlan });
      continue;
    }

    validateLiteralAttributeName(attribute.name, source, attribute.value);
    parsed.push({ kind: "literal", name: attribute.name, value: attribute.value });
  }
  return parsed;
}

/**
 * The element's DOM event bindings. `lifecycle` is given for the component's native root only: it
 * collects the root's `on:connect` and `on:disconnect`, which name handlers rather than listen.
 */
function parseEvents(
  sourceAttributes: readonly SourceAttribute[] | undefined,
  scope: ParseScope,
  source: string,
  lifecycle?: { -readonly [K in keyof ComponentLifecycle]: ComponentLifecycle[K] },
): EventBinding[] | undefined {
  if (sourceAttributes === undefined) return undefined;
  const events: EventBinding[] = [];
  for (const attribute of sourceAttributes) {
    const [name = "", ...modifiers] = attribute.name.slice("on:".length).split(".");
    if (!EVENT_PART_RE.test(name) || modifiers.some((modifier) => !EVENT_PART_RE.test(modifier))) {
      fail("HT010", `\`${attribute.name}\` is not a valid declarative event binding.`, source);
    }
    const connection = name === "connect" || name === "disconnect";
    if (connection && lifecycle === undefined) {
      fail("HT010", `\`${attribute.name}\` is a component lifecycle binding; only the component's native root element takes it.`, source);
    }
    if (connection && modifiers.length > 0) {
      fail("HT010", `Lifecycle binding \`${attribute.name}\` takes no modifiers.`, source);
    }
    for (let index = 0; index < modifiers.length; index += 1) {
      const modifier = modifiers[index]!;
      if (modifiers.indexOf(modifier) !== index) {
        fail("HT010", `\`${attribute.name}\` repeats an event modifier.`, source);
      }
      if (!EVENT_MODIFIER_RE.test(modifier)) {
        fail("HT010", `\`${attribute.name}\` contains an unsupported event modifier.`, source);
      }
    }
    if (modifiers.includes("passive") && modifiers.includes("prevent")) {
      fail("HT010", `\`${attribute.name}\` cannot combine passive and prevent.`, source);
    }
    if (!scope.handlers.has(attribute.value)) {
      fail("HT010", `Event binding \`${attribute.name}\` names undeclared handler \`${attribute.value}\`.`, source);
    }
    if (connection) lifecycle![name] = attribute.value;
    else events.push({ name, handler: attribute.value, modifiers });
  }
  return events.length === 0 ? undefined : events;
}

function parseRef(name: string | undefined, refs: Set<string>, source: string): string | undefined {
  if (name === undefined) return undefined;
  if (!NAME_RE.test(name)) fail("HT019", "`$ref` requires a valid non-empty name.", source);
  if (refs.has(name)) fail("HT019", `Reference \`${name}\` is duplicated.`, source);
  refs.add(name);
  return name;
}

function extractFlow(
  values: Record<string, string> | undefined,
  scope: ParseScope,
  source: string,
): Flow | undefined {
  if (values === undefined) return undefined;
  const structural: string[] = [];
  const eachModifiers: string[] = [];
  if (values.$if !== undefined) structural.push("$if");
  if (values.$each !== undefined) structural.push("$each");
  if (values.$with !== undefined) structural.push("$with");
  if (values.$match !== undefined) structural.push("$match");
  if (values.$when !== undefined) structural.push("$when");
  if (values.$else !== undefined) structural.push("$else");
  if (values.$where !== undefined) eachModifiers.push("$where");
  if (values.$sort !== undefined) eachModifiers.push("$sort");
  if (values.$limit !== undefined) eachModifiers.push("$limit");
  if (values.$key !== undefined) eachModifiers.push("$key");
  if (structural.length > 1) {
    fail("HT014", `An element carries one structural directive; found ${structural.join(", ")}.`, source);
  }
  const eachSource = values.$each;
  if (eachSource === undefined && eachModifiers.length > 0) {
    fail("HT014", `${eachModifiers.join(", ")} may only modify \`$each\`.`, source);
  }

  const ifSource = values.$if;
  if (ifSource !== undefined) {
    const test = ifSource;
    return { kind: "if", test, testPlan: compileScopedExpression(test, scope, source) };
  }
  const withSource = values.$with;
  if (withSource !== undefined) {
    const match = AS_RE.exec(withSource);
    if (match === null) fail("HT015", "`$with` must be written `expr as name`.", source);
    return {
      kind: "with",
      expr: match[1]!,
      expressionPlan: compileScopedExpression(match[1]!, scope, source),
      alias: match[2]!,
    };
  }
  if (eachSource !== undefined) {
    const match = EACH_RE.exec(eachSource);
    if (match === null) {
      fail("HT016", "`$each` must be written `item of items` (optionally `item, i of items`).", source);
    }
    const item = match[1]!;
    const index = match[2];
    if (scope.roots.has(item) || (index !== undefined && scope.roots.has(index))) {
      fail("HC020", "Loop locals may not collide with an existing scope name.", source);
    }
    const localScope = withRoots(scope, item, index, "loop");
    const result: {
      kind: "each";
      item: string;
      index?: string;
      list: string;
      listPlan?: CompiledExpression;
      where?: string;
      wherePlan?: CompiledExpression;
      sort?: string;
      sortKeys?: SortKey[];
      limit?: string;
      limitPlan?: CompiledExpression;
      key?: string;
      keyPlan?: CompiledExpression;
    } = {
      kind: "each",
      item,
      list: match[3]!,
      listPlan: compileScopedExpression(match[3]!, scope, source),
    };
    if (index !== undefined) result.index = index;
    const where = values.$where;
    if (where !== undefined) {
      result.where = where;
      result.wherePlan = compileScopedExpression(where, localScope, source);
    }
    // A path list rooted at the loop item, so `p.price` cannot be confused with a field named `p`:
    // `-p.name` sorts descending, `p` alone sorts by the item itself, and a leading `$` is accepted.
    if (values.$sort !== undefined) {
      result.sort = values.$sort;
      result.sortKeys = values.$sort.split(",").map((raw) => {
        const descending = raw.trim().startsWith("-");
        const key = raw.trim().slice(descending ? 1 : 0).trim();
        const steps = key.replace(/^\$/, "").split(".");
        const valid = steps.every((step, index) => isIdentifier(step) || index > 0 && /^\d+$/.test(step));
        const [root, ...path] = steps;
        if (root !== item || !valid) {
          const hint = valid ? `; did you mean \`${descending ? "-" : ""}${item}.${steps.join(".")}\`?` : ".";
          fail("HT023", `\`$sort\` key \`${raw.trim()}\` must be a path from the loop item \`${item}\`${hint}`, source);
        }
        return { path, descending };
      });
    }
    const limit = values.$limit;
    if (limit !== undefined) {
      result.limit = limit;
      result.limitPlan = compileScopedExpression(limit, localScope, source);
    }
    const key = values.$key;
    if (key !== undefined) {
      result.key = key;
      result.keyPlan = compileScopedExpression(key, localScope, source);
    }
    return result;
  }
  const matchSource = values.$match;
  if (matchSource !== undefined) {
    const raw = matchSource.trim();
    if (raw === "") return { kind: "match" };
    const match = AS_RE.exec(raw);
    if (match === null) fail("HT017", "`$match` scope must be written `expr as name`.", source);
    return {
      kind: "match",
      expr: match[1]!,
      expressionPlan: compileScopedExpression(match[1]!, scope, source),
      alias: match[2]!,
    };
  }
  const whenSource = values.$when;
  if (whenSource !== undefined) {
    const test = whenSource;
    return { kind: "when", test, testPlan: compileScopedExpression(test, scope, source) };
  }
  if (values.$else !== undefined) return { kind: "else" };
  return undefined;
}

function parseElement(...args: Parameters<typeof parseElementAtSource>): ReturnType<typeof parseElementAtSource> {
  try {
    return withDiagnosticLocation(sourceLocation(args[0]), () => parseElementAtSource(...args));
  } catch (error) {
    recoverSource(error, args[0], args[3], args[5].onDiagnostic);
    // Check-only placeholder. A resource with diagnostics never reaches a backend.
    const recovered: ElementNode = { kind: "element", name: "div", attributes: [], children: [] };
    recoveredElements.add(recovered);
    return recovered;
  }
}

function parseElementAtSource(
  element: Element,
  contract: ComponentContract,
  scope: ParseScope,
  source: string,
  slotState: {
    defaults: number;
    names: Set<string>;
    contracts: SlotContract[];
    refs: Set<string>;
  },
  platform: ComponentParserPlatform,
  rootMatch = false,
  lifecycle?: Parameters<typeof parseEvents>[3],
): ElementNode {
  if (scope.report !== undefined) scope = { ...scope, at: sourceLocation(element) ?? scope.at };
  const tagName = sourceTag(element);
  if (isReservedElement(tagName)) {
    fail("HT009", `<${tagName}> is reserved but not supported by this profile.`, source);
  }
  validateDefinitionElementName(tagName, source);

  let flowValues: Record<string, string> | undefined;
  const bindingAttributes: SourceAttribute[] = [];
  let eventAttributes: SourceAttribute[] | undefined;
  let refName: string | undefined;
  let transitionValue: string | undefined;
  let transitionName: string | undefined;
  for (const attribute of sourceAttributes(element)) {
    if (FLOW_NAME_RE.test(attribute.name)) (flowValues ??= {})[attribute.name] = attribute.value;
    else if (attribute.name === "$ref") refName = attribute.value;
    // The `transitions` extension. Its value grammar is checked only where the extension is built.
    else if (attribute.name === "$transition") transitionValue = attribute.value;
    else if (attribute.name === "$transition-name") transitionName = attribute.value;
    else if (attribute.name.startsWith("on:")) (eventAttributes ??= []).push(attribute);
    else bindingAttributes.push(attribute);
  }
  const flow = extractFlow(flowValues, scope, source);
  const nodeScope = withAliases(
    flow?.kind === "each"
      ? withRoots(scope, flow.item, flow.index, "loop")
      : flow?.kind === "with" || (flow?.kind === "match" && flow.alias !== undefined)
        ? withRoots(scope, flow.alias)
        : scope,
    flow,
  );
  // The receiving component declares these names, so a standalone consumer definition cannot
  // validate them yet. Keep the expression plans; the graph/runtime can bind the slot props later.
  // A <template> renders its children among its parent's; a projected one, wherever its slot is.
  const projectedTemplate = tagName === "template" && attr(element, "slot") !== undefined;
  const discardsWhitespace = tagName === "template" && !projectedTemplate ? nodeScope.discardsWhitespace === true : isWhitespaceDiscardingElement(tagName);
  const childScope = projectedTemplate || discardsWhitespace !== (nodeScope.discardsWhitespace === true)
    ? { ...nodeScope, discardsWhitespace, ...(projectedTemplate ? { allowUndeclared: true } : {}) }
    : nodeScope;
  const attributes = parseAttributes(bindingAttributes, tagName, contract, nodeScope, source, platform);
  const events = parseEvents(eventAttributes, nodeScope, source, lifecycle);
  const ref = parseRef(refName, slotState.refs, source);
  const transition = parseTransition(element, tagName, transitionValue, transitionName, nodeScope, source);
  const children: TemplateNode[] = [];
  // A root `$match` renders exactly one arm, so each arm may declare the same slots and refs.
  const shared = rootMatch
    ? { defaults: slotState.defaults, names: [...slotState.names], refs: [...slotState.refs] }
    : undefined;
  const merged = { defaults: slotState.defaults, names: new Set<string>(), refs: new Set<string>() };
  // Dynamic slots have no name to match, so arms' dynamic slots merge by position.
  const dynamicSlots: SlotContract[] = [];
  for (const child of contentNodes(element)) {
    if (typeof child === "string") {
      // A `$match`'s children are its arms; whitespace between them is layout, not content.
      if ((flow?.kind !== "match" && !discardsWhitespace) || !HTML_WHITESPACE_RE.test(child)) children.push(...parseText(child, childScope, source));
      continue;
    }
    if (sourceTag(child) === "slot") {
      const name = attr(child, "name");
      const nameExpression = attr(child, "from:name");
      if (name !== undefined && nameExpression !== undefined) {
        fail("HT008", "A slot cannot declare both `name` and `from:name`.", source);
      }
      const flowValues: Record<string, string> = {};
      const rawProps: Array<{ name: string; expression: string }> = [];
      for (const attribute of sourceAttributes(child)) {
        if (FLOW_NAME_RE.test(attribute.name)) {
          flowValues[attribute.name] = attribute.value;
        } else if (attribute.name.startsWith("from:") && attribute.name !== "from:name") {
          const prop = attribute.name.slice("from:".length);
          if (!isIdentifier(prop)) {
            fail("HT008", `Slot prop \`${prop}\` is not an expression-scope name.`, source);
          }
          rawProps.push({ name: prop, expression: attribute.value });
        } else if (attribute.name !== "name" && attribute.name !== "from:name") {
          fail("HT008", "A slot has an unsupported attribute.", source);
        }
      }
      const parsedFlow = extractFlow(flowValues, childScope, source);
      if (parsedFlow !== undefined && parsedFlow.kind !== "each") {
        fail("HT008", "A slot only supports `$each` structural flow.", source);
      }
      const flow = parsedFlow?.kind === "each" ? parsedFlow : undefined;
      const slotScope = flow === undefined ? childScope : withAliases(withRoots(childScope, flow.item, flow.index, "loop"), flow);
      const props = rawProps.map((prop) => ({
        ...prop,
        expressionPlan: compileScopedExpression(prop.expression, slotScope, source),
      }));
      if (name === undefined && nameExpression === undefined) {
        slotState.defaults += 1;
        if (slotState.defaults > 1) fail("HT008", "A component may declare one default slot.", source);
      }
      if (name !== undefined) {
        if (name === "" || slotState.names.has(name)) {
          fail("HT008", `Slot name \`${name}\` is empty or duplicated.`, source);
        }
        slotState.names.add(name);
      }
      const fallback: TemplateNode[] = [];
      for (const fallbackNode of contentNodes(child)) {
        if (typeof fallbackNode === "string") fallback.push(...parseText(fallbackNode, slotScope, source));
        else fallback.push(parseElement(fallbackNode, contract, slotScope, source, slotState, platform));
      }
      const dynamic = nameExpression !== undefined;
      const slotContract: { name?: string; dynamic: boolean; required: boolean; props?: readonly string[] } = {
        dynamic,
        required: fallback.length === 0,
      };
      if (name !== undefined) slotContract.name = name;
      if (props.length > 0) slotContract.props = props.map((prop) => prop.name);
      // Root arms repeat their slots; the contract lists each once, required if any arm requires it.
      const existing = dynamic
        ? -1
        : slotState.contracts.findIndex((contract) => !contract.dynamic && contract.name === name);
      if (existing === -1) slotState.contracts.push(slotContract);
      else {
        const previous = slotState.contracts[existing]!;
        const names = [...new Set([...(previous.props ?? []), ...(slotContract.props ?? [])])];
        slotState.contracts[existing] = {
          ...previous,
          required: previous.required || slotContract.required,
          ...(names.length === 0 ? {} : { props: names }),
        };
      }
      if (name === undefined && nameExpression === undefined && fallback.length === 0 && flow === undefined && props.length === 0) {
        children.push({ kind: "slot" });
      } else {
        const slot: {
          kind: "slot";
          name?: string;
          nameExpression?: CompiledExpression;
          flow?: Extract<Flow, { kind: "each" }>;
          props?: readonly { name: string; expression: string; expressionPlan: CompiledExpression }[];
          fallback: TemplateNode[];
        } = {
          kind: "slot",
          fallback,
        };
        if (name !== undefined) slot.name = name;
        if (nameExpression !== undefined) {
          slot.nameExpression = compileScopedExpression(nameExpression, slotScope, source);
        }
        if (flow !== undefined) slot.flow = flow;
        if (props.length > 0) slot.props = props;
        children.push(slot);
      }
      continue;
    }
    if (shared === undefined) {
      children.push(parseElement(child, contract, childScope, source, slotState, platform));
      continue;
    }
    slotState.defaults = shared.defaults;
    slotState.names.clear();
    slotState.refs.clear();
    for (const name of shared.names) slotState.names.add(name);
    for (const ref of shared.refs) slotState.refs.add(ref);
    const before = slotState.contracts.length;
    children.push(parseElement(child, contract, childScope, source, slotState, platform));
    const armDynamic = slotState.contracts.slice(before).filter((slot) => slot.dynamic);
    slotState.contracts.splice(0, slotState.contracts.length, ...slotState.contracts.filter((slot) => !armDynamic.includes(slot)));
    for (const [index, slot] of armDynamic.entries()) {
      const known = dynamicSlots[index];
      dynamicSlots[index] = known === undefined ? slot : { ...known, required: known.required || slot.required };
    }
    merged.defaults = Math.max(merged.defaults, slotState.defaults);
    for (const name of slotState.names) merged.names.add(name);
    for (const ref of slotState.refs) merged.refs.add(ref);
  }
  if (shared !== undefined) {
    slotState.contracts.push(...dynamicSlots);
    slotState.defaults = merged.defaults;
    for (const name of merged.names) slotState.names.add(name);
    for (const ref of merged.refs) slotState.refs.add(ref);
  }

  // A component's children are projected content. Whitespace at their edges or beside content for a
  // named slot lays out the invocation, and would otherwise reach the default slot and hide its
  // fallback; whitespace between default-slot content stays.
  if (tagName.includes("-") && !platform.isNativeElement(tagName)) {
    const named = (node: TemplateNode | undefined): boolean => node?.kind === "element" &&
      node.attributes.some((binding) => binding.kind === "literal" && binding.name === "slot" && (binding.value !== "" || node.name === "template"));
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (isWhitespaceText(children[index]!) && (index === 0 || index === children.length - 1 || named(children[index - 1]) || named(children[index + 1]))) {
        children.splice(index, 1);
      }
    }
  }
  // Content directives replace the element's children, so whitespace-only text beside one is layout.
  if (
    attributes.some((binding) => binding.kind === "directive" || (binding.kind === "property" && binding.name === "textContent")) &&
    children.every(isWhitespaceText)
  ) children.length = 0;
  if (attributes.some((binding) => binding.kind === "directive") && children.length > 0) {
    fail("HT006", "A content directive cannot coexist with children.", source);
  }
  if (
    attributes.some((binding) => binding.kind === "property" && binding.name === "textContent") &&
    children.length > 0
  ) {
    fail("HT006", "A content-replacing property binding cannot coexist with children.", source);
  }

  if (flow?.kind === "match" && (platform.onDiagnostic === undefined || !children.some((child) => child.kind === "element" && recoveredElements.has(child)))) {
    let remainingArms = 0;
    for (const child of children) {
      if (child.kind === "element") remainingArms += 1;
    }
    let elseSeen = false;
    for (const arm of children) {
      if (arm.kind !== "element") continue;
      remainingArms -= 1;
      if (arm.flow?.kind === "when") {
        if (elseSeen) fail("HT018", "A `$when` arm may not follow `$else`.", source);
      } else if (arm.flow?.kind === "else") {
        if (elseSeen) fail("HT018", "A `$match` has at most one `$else`.", source);
        elseSeen = true;
        if (remainingArms !== 0) fail("HT018", "`$else` must be the last arm.", source);
      } else {
        fail("HT018", "Every direct child of a `$match` must be a `$when` or `$else` arm.", source);
      }
    }
  }

  const parsed: {
    kind: "element";
    name: string;
    attributes: TemplateAttribute[];
    children: TemplateNode[];
    flow?: Flow;
    events?: EventBinding[];
    ref?: string;
    transition?: ElementTransition;
  } = {
    kind: "element",
    name: tagName,
    attributes,
    children,
  };
  if (flow !== undefined) parsed.flow = flow;
  if (events !== undefined) parsed.events = events;
  if (ref !== undefined) parsed.ref = ref;
  if (transition !== undefined) parsed.transition = transition;
  return parsed;
}

function parseTransition(
  element: Element,
  tagName: string,
  value: string | undefined,
  name: string | undefined,
  scope: ParseScope,
  source: string,
): ElementTransition | undefined {
  if (value === undefined && name === undefined) return undefined;
  if (tagName === "template") {
    scope.report?.({
      code: "HT026",
      message: "A `<template>` has no box to animate; put `$transition` and `$transition-name` on the elements inside it.",
      source,
      ...scope.at,
      severity: "warning",
    });
    return undefined;
  }
  const transition: { -readonly [K in keyof ElementTransition]: ElementTransition[K] } = { ...sourceLocation(element) };
  if (value !== undefined) transition.value = value.trim();
  if (name !== undefined) {
    transition.name = name;
    transition.namePlan = compileScopedExpression(name, scope, source);
  }
  return transition;
}

export function parseComponentNodes(...args: Parameters<typeof parseComponentNodesAtSource>): ComponentDefinition {
  return withDiagnosticLocation(sourceLocation(args[0].find(isElement)), () => parseComponentNodesAtSource(...args));
}

function parseComponentNodesAtSource(
  childNodes: readonly ChildNode[],
  source: string,
  platform: ComponentParserPlatform,
): ComponentDefinition {
  const topLevel = significant(childNodes);
  if (
    topLevel.length !== 1 ||
    !isElement(topLevel[0]!) ||
    sourceTag(topLevel[0]) !== "template" ||
    attr(topLevel[0], "component") === undefined
  ) {
    fail("HS001", "A source must contain exactly one top-level <template component>.", source);
  }
  const wrapper = topLevel[0];

  // A <template>'s children live in its content fragment, inert and unrendered.
  let declarationGroup: Element | undefined;
  let legacyProps = false;
  let style: Element | undefined;
  let root: Element | undefined;
  for (const node of sourceChildren(wrapper)) {
    if (node.nodeName === "#comment" || (isText(node) && sourceText(node).trim() === "")) continue;
    if (!isElement(node)) {
      fail("HT001", "A component's markup must be exactly one element root.", source);
    }
    const name = sourceTag(node);
    if (name === "title" || name === "meta" || name === "link") {
      fail("HS002", `A \`<${name}>\` placed directly in a carrier is invalid; a component's head content is its head declarations in \`<defs>\`.`, source);
    }
    if (name === "props" || name === "defs") {
      if (declarationGroup !== undefined) {
        fail("HS002", "A component has one optional declaration group, one markup root, and one optional <style>.", source);
      }
      declarationGroup = node;
      legacyProps = name === "props";
      validateDeclarationContent(node, source, !legacyProps);
    } else if (name === "style") {
      if (style !== undefined) {
        fail("HS002", "A component has one optional declaration group, one markup root, and one optional <style>.", source);
      }
      style = node;
    } else if (root === undefined) {
      root = node;
    } else {
      fail("HT001", "A component's markup must be exactly one element root.", source);
    }
  }
  if (root === undefined) {
    fail("HT001", "A component's markup must be exactly one element root.", source);
  }
  const rootTag = sourceTag(root);
  if ((rootTag === "template" && attr(root, "$match") === undefined) || rootTag === "slot") {
    fail("HT021", "A component root must always select exactly one native or delegated element.", source);
  }
  if (attr(root, "as") !== undefined) {
    fail("HT021", "`as` does not retag a root; declare an `as` prop and choose native roots with `$match`.", source);
  }
  // A polymorphic root is a `<template $match>` whose arms are the native roots it may render;
  // the last arm is `$else`, so exactly one is chosen.
  const rootArms = sourceTag(root) === "template" && attr(root, "$match") !== undefined
    ? significant(sourceChildren(root))
    : undefined;
  if (rootArms !== undefined) {
    const last = rootArms.at(-1);
    if (
      attr(root, "$match") !== "" ||
      last === undefined ||
      rootArms.some((arm) => !isElement(arm) || ["template", "slot"].includes(sourceTag(arm)) || !platform.isNativeElement(sourceTag(arm))) ||
      attr(last as Element, "$else") === undefined
    ) {
      fail("HT021", "A root `$match` has no expression, and its arms are native elements ending in `$else`.", source);
    }
  }
  const rootName = rootArms === undefined ? sourceTag(root) : sourceTag(rootArms.at(-1) as Element);
  const rootChoices = rootArms === undefined
    ? [rootName]
    : [...new Set(rootArms.map((arm) => sourceTag(arm as Element)))];
  const delegatedRoot = !platform.isNativeElement(rootName);

  const targets = collectTargets(root, source, platform);
  const propContract = readContract(
    wrapper,
    declarationGroup,
    rootName,
    delegatedRoot,
    targets,
    source,
    legacyProps,
    platform.warnInvalidDeclaration,
    platform.onDiagnostic,
  );

  const { declarations, scope: declarationScope, requests, head, scripts } = readDeclarations(legacyProps ? undefined : declarationGroup, propContract, source, platform.warnInvalidDeclaration, platform.onDiagnostic, platform.warn);
  // The same object, so it keeps its diagnostic location; the definition freezes it below.
  const contract: ComponentContract = Object.assign(propContract, {
    ...(requests === undefined ? {} : { requests }),
    ...(scripts === undefined ? {} : { scripts: scripts.map(({ load: _load, error: _error, ...script }) => script) }),
  });
  let scope = declarationScope;
  if (legacyProps && platform.onDiagnostic !== undefined && declarationGroup !== undefined) {
    const roots = new Set(scope.roots);
    for (const prop of directElements(declarationGroup, "prop")) {
      const name = attr(prop, "name");
      if (name !== undefined && isIdentifier(name)) roots.add(name);
    }
    scope = { ...scope, roots };
  }
  const slotState = {
    defaults: 0,
    names: new Set<string>(),
    contracts: [] as SlotContract[],
    refs: new Set<string>(),
  };
  // Lifecycle bindings belong to the one element the component always renders as its own root.
  const lifecycle: Parameters<typeof parseEvents>[3] = {};
  const template = parseElement(root, contract, scope, source, slotState, platform, rootArms !== undefined,
    rootArms === undefined && !delegatedRoot ? lifecycle : undefined);
  if (template.flow !== undefined && template.flow.kind !== "with" && template.flow.kind !== "match") {
    fail("HT021", "A component root must always select exactly one native or delegated element.", source);
  }
  for (const declaration of declarations) {
    if (declaration.kind !== "handler") continue;
    for (const step of declaration.steps) {
      if (step.kind === "dispatch" && step.target !== undefined && !slotState.refs.has(step.target)) {
        fail("HC023", `Dispatch target \`${step.target}\` is not a declared component-local $ref.`, source);
      }
    }
  }
  const controller = attr(wrapper, "controller");
  if (controller === "") fail("HC022", "A controller specifier cannot be empty.", source);

  const definition: {
    source: { file: string };
    contract: ComponentContract;
    template: ElementNode;
    css: string;
    controller?: string;
    declarations: ComponentDeclaration[];
    slots: SlotContract[];
    root: NonNullable<ComponentDefinition["root"]>;
    lifecycle?: ComponentLifecycle;
    head?: readonly HeadDeclaration[];
    scripts?: readonly ScriptDeclaration[];
  } = {
    source: { file: source },
    contract,
    template,
    css: style === undefined ? "" : textContent(style).trim(),
    declarations,
    slots: slotState.contracts,
    root: delegatedRoot
      ? { kind: "component" as const, tag: rootName }
      : {
          kind: "native" as const,
          element: rootName,
          choices: rootChoices,
        },
  };
  if (controller !== undefined) definition.controller = controller;
  if (Object.keys(lifecycle).length > 0) definition.lifecycle = lifecycle;
  if (head !== undefined) definition.head = head;
  if (scripts !== undefined) definition.scripts = scripts;
  return deepFreeze(definition);
}
