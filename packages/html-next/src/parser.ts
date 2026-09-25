import type { DefaultTreeAdapterTypes } from "parse5";

import { parseTypeAttribute } from "./contract.js";
import { fail } from "./diagnostics.js";
import { compileExpression, getWritablePath, type CompiledExpression } from "./expression.js";
import { parseDuration } from "./duration.js";
import { deepFreeze } from "./freeze.js";
import {
  isReservedElement,
  validateDefinitionElementName,
  validateLiteralAttributeName,
  validateMvpDomProperty,
} from "./language.js";
import { componentName } from "./names.js";
import type {
  ComponentDefinition,
  ComponentDeclaration,
  ElementNode,
  EventBinding,
  Flow,
  HandlerStep,
  SlotContract,
  TemplateAttribute,
  TemplateNode,
} from "./template.js";
import { isAttributeType, parseTypedValue, parseTypeExpression } from "./type-system.js";
import type { ComponentContract, ContractStatus, PropContract, PropTarget, PropValue } from "./types.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode | globalThis.Node;
type Element = DefaultTreeAdapterTypes.Element | globalThis.Element;
type SourceAttribute = Readonly<{ name: string; value: string }>;

export type ComponentSourceNode = ChildNode;

export interface ComponentParserPlatform {
  readonly isNativeElement: (name: string) => boolean;
  readonly resolveDomProperty: (tagName: string, propertyName: string) => string | undefined;
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

function validateDeclarationContent(element: Element, source: string): void {
  for (const child of sourceChildren(element)) {
    if (!isElement(child)) continue;
    const name = sourceTag(child);
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
const EACH_RE = /^\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\bof\b\s*(.+)$/;
const AS_RE = /^\s*(.+?)\s+\bas\b\s+([A-Za-z_$][\w$]*)\s*$/;
const EVENT_PART_RE = /^[a-z][a-z0-9-]*$/;
const EVENT_MODIFIER_RE = /^(?:prevent|stop|self|once|passive|capture|left|middle|right|ctrl|shift|alt|meta|exact|enter|escape|space|tab|up|down)$/;
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

interface ParseScope {
  readonly roots: ReadonlySet<string>;
  readonly writableRoots: ReadonlySet<string>;
  readonly handlers: ReadonlySet<string>;
}

function withRoots(scope: ParseScope, ...roots: (string | undefined)[]): ParseScope {
  const expanded = new Set(scope.roots);
  for (const root of roots) {
    if (root !== undefined) expanded.add(root);
  }
  return {
    roots: expanded,
    writableRoots: scope.writableRoots,
    handlers: scope.handlers,
  };
}

function compileScopedExpression(
  value: string,
  scope: ParseScope,
  source: string,
): CompiledExpression {
  const expression = compileDeclarationExpression(value, source);
  validateCompiledExpression(expression, scope, source);
  return expression;
}

function validateCompiledExpression(
  expression: CompiledExpression,
  scope: ParseScope,
  source: string,
): void {
  for (const dependency of expression.dependencies) {
    const root = dependency.split(".", 1)[0]!;
    if (!scope.roots.has(root)) {
      fail("HT003", `Expression root \`${root}\` is not declared in this scope.`, source);
    }
  }
}

/**
 * A prop's target is defined by where it is bound in the markup, not restated: a
 * `:attr="prop"` binding targets that attribute, a `.prop="prop"` binding that DOM property. A prop
 * bound in several places targets its first binding in document order; the others only render it.
 */
function collectTargets(
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
      if (attribute.name.startsWith(":")) {
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(attribute.value)) {
          record(attribute.value, { attribute: attribute.name.slice(1).toLowerCase() });
        }
      } else if (attribute.name.startsWith(".")) {
        const key = attribute.name.slice(1).toLowerCase();
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(attribute.value)) {
          const property = platform.resolveDomProperty(sourceTag(element), key) ??
            (attribute.value.toLowerCase() === key ? attribute.value : key);
          record(attribute.value, { property });
        }
      }
    }
    for (const child of sourceChildren(element)) {
      if (isElement(child) && sourceTag(child) !== "slot") visit(child);
    }
  };
  visit(root);
  return targets;
}

function readProps(
  group: Element | undefined,
  targets: Record<string, PropTarget>,
  source: string,
  requireBinding = true,
): Record<string, PropContract> {
  const props = Object.create(null) as Record<string, PropContract>;
  const normalizedNames = Object.create(null) as Record<string, string>;
  if (group === undefined) return props;
  const elements = directElements(group, "prop");
  elements.sort((left, right) => {
    const leftName = attr(left, "name") ?? "";
    const rightName = attr(right, "name") ?? "";
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  for (const element of elements) {
    const name = attr(element, "name");
    if (name === undefined || name === "") {
      fail("HC010", "A <prop> requires a `name` attribute.", source);
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      fail("HC010", `Invalid prop name \`${name}\`.`, source);
    }
    const typeAttribute = attr(element, "type");
    if (typeAttribute === undefined || typeAttribute === "") {
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
    const type = parseTypeAttribute(typeAttribute);
    const required = attr(element, "required") !== undefined;
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
      required: boolean;
      default?: PropValue;
      target: PropTarget;
      description: string;
    } = { type, required, target, description };
    if (defaultValue !== undefined) {
      const parsed = parseTypedValue(defaultValue, type);
      if (!parsed.ok) fail("HC015", `Default for prop \`${name}\` does not satisfy its type.`, source);
      spec.default = parsed.value as PropValue;
    }
    props[name] = spec;
  }
  return props;
}

function readContract(
  wrapper: Element,
  group: Element | undefined,
  nativeElement: string,
  delegatedRoot: boolean,
  targets: Record<string, PropTarget>,
  source: string,
  requireBinding: boolean,
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
    props: readProps(group, targets, source, requireBinding),
  };
}

function compileDeclarationExpression(value: string, source: string) {
  try {
    return compileExpression(value);
  } catch {
    fail("HT013", `Malformed expression \`${value}\`.`, source);
  }
}

function readHandlerSteps(
  handler: Element,
  scope: ParseScope,
  source: string,
): HandlerStep[] {
  const steps: HandlerStep[] = [];
  for (const step of significant(sourceChildren(handler))) {
    if (!isElement(step)) fail("HC023", "Handler bodies contain declarative step elements only.", source);
    const guardSource = attr(step, "$if");
    const guard =
      guardSource === undefined ? undefined : compileScopedExpression(guardSource, scope, source);
    if (sourceTag(step) === "set") {
      const path = attr(step, "name") ?? "";
      const expressionSource = attr(step, ":value");
      const literal = attr(step, "value");
      if (path === "" || (expressionSource === undefined) === (literal === undefined)) {
        fail("HC023", "A <set> requires `name` and exactly one of `value` or `:value`.", source);
      }
      compileScopedExpression(path, scope, source);
      const writablePath = getWritablePath(path, scope.writableRoots);
      if (writablePath === undefined) {
        fail("HT005", `Handler write \`${path}\` is not rooted in declared state.`, source);
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
        value: compileScopedExpression(
          expressionSource ?? JSON.stringify(literal),
          scope,
          source,
        ),
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
      const expressionSource = attr(step, ":value");
      const literal = attr(step, "value");
      if (expressionSource !== undefined && literal !== undefined) {
        fail("HC023", "A <dispatch> may declare only one of `value` or `:value`.", source);
      }
      const value =
        expressionSource === undefined && literal === undefined
          ? undefined
          : compileScopedExpression(expressionSource ?? JSON.stringify(literal), scope, source);
      const parsed: {
        kind: "dispatch";
        event: string;
        value?: CompiledExpression;
        guard?: CompiledExpression;
      } = {
        kind: "dispatch",
        event,
      };
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

function readDeclarations(
  group: Element | undefined,
  contract: ComponentContract,
  source: string,
): { declarations: ComponentDeclaration[]; scope: ParseScope } {
  const declarations: ComponentDeclaration[] = [];
  const roots = new Set(Object.keys(contract.props));
  const writableRoots = new Set<string>();
  const handlers = new Set<string>();
  if (group === undefined) return { declarations, scope: { roots, writableRoots, handlers } };
  const elements: Element[] = [];
  const names = new Set<string>();
  const eventNames = new Set<string>();
  for (const node of sourceChildren(group)) {
    if (!isElement(node)) continue;
    const element = node;
    elements.push(element);
    const kind = sourceTag(element);
    if (!/^(?:prop|state|computed|data|handler|event|method)$/.test(kind)) {
      fail("HC021", `<${kind}> is not a recognized definition declaration.`, source);
    }
    const name = attr(element, "name") ?? "";
    if (name === "") fail("HC010", `A <${kind}> requires a \`name\` attribute.`, source);
    if (kind === "event") {
      if (eventNames.has(name)) fail("HC020", `Event \`${name}\` is declared more than once.`, source);
      eventNames.add(name);
      continue;
    }
    if (names.has(name)) {
      fail("HC020", `Declaration \`${name}\` collides in the flat component scope.`, source);
    }
    names.add(name);
    roots.add(name);
    if (kind === "state") writableRoots.add(name);
    else if (kind === "handler") handlers.add(name);
  }

  const scope = { roots, writableRoots, handlers };
  for (const element of elements) {
    const kind = sourceTag(element);
    if (kind === "prop") continue;
    const name = attr(element, "name")!;

    if (kind === "state") {
      const expressionSource = attr(element, ":value");
      const literal = attr(element, "value");
      if (expressionSource !== undefined && literal !== undefined) {
        fail("HC013", `<state name="${name}"> may declare only one of \`value\` or \`:value\`.`, source);
      }
      const expression =
        expressionSource === undefined && literal === undefined
          ? undefined
          : compileScopedExpression(expressionSource ?? JSON.stringify(literal), scope, source);
      const declaration: {
        kind: "state";
        name: string;
        type?: string;
        value?: string;
        expression?: CompiledExpression;
      } = {
        kind,
        name,
      };
      // A declared type states what the state holds, as a prop's does.
      const stateType = attr(element, "type");
      if (stateType !== undefined) {
        parseTypeAttribute(stateType);
        declaration.type = stateType;
      }
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
        const expressionSource = attr(parameter, ":value");
        if (!NAME_RE.test(parameterName) || expressionSource === undefined) {
          fail("HC024", "A data <param> requires a valid `name` and a `:value` expression.", source);
        }
        if (parameterNames.has(parameterName)) {
          fail("HC024", `Data source \`${name}\` repeats a parameter name.`, source);
        }
        parameterNames.add(parameterName);
        parameters.push({
          name: parameterName,
          expression: compileScopedExpression(expressionSource, scope, source),
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
      declarations.push({
        kind,
        name,
        type: attr(element, "type") ?? "object",
        bubbles: attr(element, "bubbles") !== "false",
        composed: attr(element, "composed") !== "false",
        cancelable: attr(element, "cancelable") === "true",
      });
      continue;
    }
    if (kind === "method") {
      declarations.push({
        kind,
        name,
        exportName: attr(element, "export") ?? name,
        returns: attr(element, "returns") ?? "undefined",
      });
      continue;
    }
    declarations.push({
      kind: "handler",
      name,
      steps: readHandlerSteps(element, scope, source),
    });
  }
  for (const declaration of declarations) {
    if (declaration.kind !== "handler") continue;
    for (const step of declaration.steps) {
      if (step.kind === "dispatch" && !eventNames.has(step.event)) {
        fail("HC023", `Handler \`${declaration.name}\` dispatches undeclared component event \`${step.event}\`.`, source);
      }
    }
  }
  return { declarations, scope };
}

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
      const expressionPlan = compileScopedExpression(attribute.value, scope, source);
      const writablePath = getWritablePath(attribute.value, scope.writableRoots);
      if (writablePath === undefined) {
        fail("HT005", `\`${attribute.value}\` is not a writable state-rooted path.`, source);
      }
      parsed.push({
        kind: "attribute",
        name,
        expression: attribute.value,
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

    if (attribute.name.startsWith(":")) {
      const name = attribute.name.slice(1).toLowerCase();
      if (RAW_SINK_RE.test(name)) {
        fail("HT007", `\`:${name}\` cannot bind a raw content sink.`, source);
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

function parseEvents(
  sourceAttributes: readonly SourceAttribute[] | undefined,
  scope: ParseScope,
  source: string,
): EventBinding[] | undefined {
  if (sourceAttributes === undefined) return undefined;
  const events: EventBinding[] = [];
  for (const attribute of sourceAttributes) {
    const [name = "", ...modifiers] = attribute.name.slice("on:".length).split(".");
    if (!EVENT_PART_RE.test(name) || modifiers.some((modifier) => !EVENT_PART_RE.test(modifier))) {
      fail("HT010", `\`${attribute.name}\` is not a valid declarative event binding.`, source);
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
    events.push({ name, handler: attribute.value, modifiers });
  }
  return events;
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
    if (values.$sort !== undefined) result.sort = values.$sort;
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

function parseElement(
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
): ElementNode {
  const tagName = sourceTag(element);
  if (isReservedElement(tagName)) {
    fail("HT009", `<${tagName}> is reserved but not supported by this profile.`, source);
  }
  validateDefinitionElementName(tagName, source);

  let flowValues: Record<string, string> | undefined;
  const bindingAttributes: SourceAttribute[] = [];
  let eventAttributes: SourceAttribute[] | undefined;
  let refName: string | undefined;
  for (const attribute of sourceAttributes(element)) {
    if (FLOW_NAME_RE.test(attribute.name)) (flowValues ??= {})[attribute.name] = attribute.value;
    else if (attribute.name === "$ref") refName = attribute.value;
    else if (attribute.name.startsWith("on:")) (eventAttributes ??= []).push(attribute);
    else bindingAttributes.push(attribute);
  }
  const flow = extractFlow(flowValues, scope, source);
  const nodeScope =
    flow?.kind === "each"
      ? withRoots(scope, flow.item, flow.index, "loop")
      : flow?.kind === "with" || (flow?.kind === "match" && flow.alias !== undefined)
        ? withRoots(scope, flow.alias)
        : scope;
  const attributes = parseAttributes(bindingAttributes, tagName, contract, nodeScope, source, platform);
  const events = parseEvents(eventAttributes, nodeScope, source);
  const ref = parseRef(refName, slotState.refs, source);
  const children: TemplateNode[] = [];
  const childNodes = sourceChildren(element);
  // A root `$match` renders exactly one arm, so each arm may declare the same slots and refs.
  const shared = rootMatch
    ? { defaults: slotState.defaults, names: [...slotState.names], refs: [...slotState.refs] }
    : undefined;
  const merged = { defaults: slotState.defaults, names: new Set<string>(), refs: new Set<string>() };
  // Dynamic slots have no name to match, so arms' dynamic slots merge by position.
  const dynamicSlots: SlotContract[] = [];
  for (const child of childNodes) {
    if (child.nodeName === "#comment") continue;
    if (isText(child)) {
      const value = sourceText(child);
      if (value.trim() !== "") children.push({ kind: "text", value });
      continue;
    }
    if (!isElement(child)) continue;
    if (sourceTag(child) === "slot") {
      const name = attr(child, "name");
      const nameExpression = attr(child, ":name");
      if (name !== undefined && nameExpression !== undefined) {
        fail("HT008", "A slot cannot declare both `name` and `:name`.", source);
      }
      for (const attribute of sourceAttributes(child)) {
        if (attribute.name !== "name" && attribute.name !== ":name") {
          fail("HT008", "A slot has an unsupported attribute.", source);
        }
      }
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
      for (const fallbackNode of sourceChildren(child)) {
        if (fallbackNode.nodeName === "#comment") continue;
        if (isText(fallbackNode)) {
          const value = sourceText(fallbackNode);
          if (value.trim() !== "") fallback.push({ kind: "text", value });
        } else if (isElement(fallbackNode)) {
          fallback.push(parseElement(fallbackNode, contract, nodeScope, source, slotState, platform));
        }
      }
      const dynamic = nameExpression !== undefined;
      const slotContract: { name?: string; dynamic: boolean; required: boolean } = {
        dynamic,
        required: fallback.length === 0,
      };
      if (name !== undefined) slotContract.name = name;
      // Root arms repeat their slots; the contract lists each once, required if any arm requires it.
      const existing = dynamic
        ? -1
        : slotState.contracts.findIndex((contract) => !contract.dynamic && contract.name === name);
      if (existing === -1) slotState.contracts.push(slotContract);
      else if (slotContract.required) slotState.contracts[existing] = { ...slotState.contracts[existing]!, required: true };
      if (name === undefined && nameExpression === undefined && fallback.length === 0) {
        children.push({ kind: "slot" });
      } else {
        const slot: {
          kind: "slot";
          name?: string;
          nameExpression?: CompiledExpression;
          fallback: TemplateNode[];
        } = {
          kind: "slot",
          fallback,
        };
        if (name !== undefined) slot.name = name;
        if (nameExpression !== undefined) {
          slot.nameExpression = compileScopedExpression(nameExpression, nodeScope, source);
        }
        children.push(slot);
      }
      continue;
    }
    if (shared === undefined) {
      children.push(parseElement(child, contract, nodeScope, source, slotState, platform));
      continue;
    }
    slotState.defaults = shared.defaults;
    slotState.names.clear();
    slotState.refs.clear();
    for (const name of shared.names) slotState.names.add(name);
    for (const ref of shared.refs) slotState.refs.add(ref);
    const before = slotState.contracts.length;
    children.push(parseElement(child, contract, nodeScope, source, slotState, platform));
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

  if (attributes.some((binding) => binding.kind === "directive") && children.length > 0) {
    fail("HT006", "A content directive cannot coexist with children.", source);
  }
  if (
    attributes.some((binding) => binding.kind === "property" && binding.name === "textContent") &&
    children.length > 0
  ) {
    fail("HT006", "A content-replacing property binding cannot coexist with children.", source);
  }

  if (flow?.kind === "match") {
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
  } = {
    kind: "element",
    name: tagName,
    attributes,
    children,
  };
  if (flow !== undefined) parsed.flow = flow;
  if (events !== undefined) parsed.events = events;
  if (ref !== undefined) parsed.ref = ref;
  return parsed;
}

export function parseComponentNodes(
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
    if (name === "props" || name === "defs") {
      if (declarationGroup !== undefined) {
        fail("HS002", "A component has one optional declaration group, one markup root, and one optional <style>.", source);
      }
      declarationGroup = node;
      legacyProps = name === "props";
      validateDeclarationContent(node, source);
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
  const contract = readContract(
    wrapper,
    declarationGroup,
    rootName,
    delegatedRoot,
    targets,
    source,
    legacyProps,
  );

  const { declarations, scope } = readDeclarations(legacyProps ? undefined : declarationGroup, contract, source);
  const slotState = {
    defaults: 0,
    names: new Set<string>(),
    contracts: [] as SlotContract[],
    refs: new Set<string>(),
  };
  const template = parseElement(root, contract, scope, source, slotState, platform, rootArms !== undefined);
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
  return deepFreeze(definition);
}
