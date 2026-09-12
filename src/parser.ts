import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

import { coerceDefault, defineContract, parseTypeAttribute } from "./contract.js";
import { fail } from "./diagnostics.js";
import { compileExpression, getWritablePath, type CompiledExpression } from "./expression.js";
import {
  isReservedElement,
  validateDefinitionElementName,
  validateLiteralAttributeName,
  validateMvpDomProperty,
} from "./language.js";
import { getDomInterface, resolveDomProperty } from "./platform.js";
import type {
  ComponentDefinition,
  ComponentDeclaration,
  ElementNode,
  EventBinding,
  Flow,
  FormDeclaration,
  HandlerStep,
  SlotContract,
  TemplateAttribute,
  TemplateNode,
} from "./template.js";
import type { ComponentContract, PropTarget } from "./types.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function isText(node: ChildNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === "#text" && "value" in node;
}

function significant(nodes: readonly ChildNode[]): ChildNode[] {
  return nodes.filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (isText(node)) return node.value.trim() !== "";
    return true;
  });
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

function textContent(element: Element): string {
  return element.childNodes
    .filter(isText)
    .map((node) => node.value)
    .join("");
}

function directElements(element: Element, name: string): Element[] {
  return element.childNodes.filter(
    (node): node is Element => isElement(node) && node.tagName === name,
  );
}

const FLOW_NAMES = new Set([
  "$if",
  "$each",
  "$where",
  "$sort",
  "$limit",
  "$key",
  "$with",
  "$match",
  "$when",
  "$else",
]);
const RAW_SINKS = new Set(["innerhtml", "outerhtml", "textcontent", "innertext", "srcdoc"]);
const EACH_RE = /^\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\bof\b\s*(.+)$/;
const AS_RE = /^\s*(.+?)\s+\bas\b\s+([A-Za-z_$][\w$]*)\s*$/;
const EVENT_PART_RE = /^[a-z][a-z0-9-]*$/;
const EVENT_MODIFIERS = new Set([
  "prevent", "stop", "self", "once", "passive", "capture",
  "left", "middle", "right", "ctrl", "shift", "alt", "meta", "exact",
  "enter", "escape", "space", "tab", "up", "down", "left", "right",
]);
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

interface ParseScope {
  readonly roots: ReadonlySet<string>;
  readonly writableRoots: ReadonlySet<string>;
  readonly handlers: ReadonlySet<string>;
}

function withRoots(scope: ParseScope, ...roots: (string | undefined)[]): ParseScope {
  return {
    ...scope,
    roots: new Set([...scope.roots, ...roots.filter((root): root is string => root !== undefined)]),
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
 * `:attr="prop"` binding targets that attribute, a `.prop="prop"` binding that DOM property.
 */
function collectTargets(root: Element, source: string): Record<string, PropTarget> {
  const targets: Record<string, PropTarget> = {};
  const record = (name: string, target: PropTarget): void => {
    const prior = targets[name];
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(target)) {
      fail("HT004", `Prop \`${name}\` is bound to conflicting targets.`, source);
    }
    targets[name] = target;
  };
  const visit = (element: Element): void => {
    for (const attribute of element.attrs) {
      if (attribute.name.startsWith(":")) {
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(attribute.value)) {
          record(attribute.value, { attribute: attribute.name.slice(1).toLowerCase() });
        }
      } else if (attribute.name.startsWith(".")) {
        const key = attribute.name.slice(1).toLowerCase();
        if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(attribute.value)) {
          record(attribute.value, { property: resolveDomProperty(element.tagName, key) ?? key });
        }
      }
    }
    for (const child of element.childNodes) {
      if (isElement(child) && child.tagName !== "slot") visit(child);
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
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (group === undefined) return props;
  for (const element of directElements(group, "prop")) {
    const name = attr(element, "name");
    if (name === undefined || name === "") {
      fail("HC010", "A <prop> requires a `name` attribute.", source);
    }
    const typeAttribute = attr(element, "type");
    if (typeAttribute === undefined || typeAttribute === "") {
      fail("HC013", `Prop \`${name}\` requires a \`type\` attribute.`, source);
    }
    let target = targets[name];
    if (target === undefined && requireBinding) {
      fail("HC018", `Prop \`${name}\` is declared but never bound in the markup.`, source);
    }
    target ??= { attribute: name.toLowerCase() };
    const type = parseTypeAttribute(typeAttribute);
    const spec: Record<string, unknown> = { type, target, description: textContent(element).trim() };
    if (element.attrs.some((item) => item.name === "required")) spec.required = true;
    const defaultValue = attr(element, "default");
    if (defaultValue !== undefined) spec.default = coerceDefault(type, defaultValue);
    props[name] = spec;
  }
  return props;
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
  for (const step of significant(handler.childNodes)) {
    if (!isElement(step)) fail("HC023", "Handler bodies contain declarative step elements only.", source);
    const guardSource = attr(step, "$if");
    const guard =
      guardSource === undefined ? undefined : compileScopedExpression(guardSource, scope, source);
    if (step.tagName === "set") {
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
      steps.push({
        kind: "set",
        path,
        writablePath,
        value: compileScopedExpression(
          expressionSource ?? JSON.stringify(literal),
          scope,
          source,
        ),
        ...(guard === undefined ? {} : { guard }),
      });
      continue;
    }
    if (step.tagName === "dispatch") {
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
      steps.push({
        kind: "dispatch",
        event,
        ...(value === undefined ? {} : { value }),
        ...(guard === undefined ? {} : { guard }),
      });
      continue;
    }
    if (step.tagName === "validate" || step.tagName === "focus") {
      const target = attr(step, "target") ?? attr(step, "ref") ?? attr(step, "name") ?? "";
      if (!NAME_RE.test(target)) {
        fail("HC023", `<${step.tagName}> requires a valid target reference.`, source);
      }
      steps.push({
        kind: step.tagName,
        target,
        ...(guard === undefined ? {} : { guard }),
      });
      continue;
    }
    fail("HC023", `<${step.tagName}> is not a recognized handler step.`, source);
  }
  return steps;
}

function readDeclarations(
  group: Element | undefined,
  contract: ComponentContract,
  source: string,
  formNames: ReadonlySet<string> = new Set(),
): ComponentDeclaration[] {
  if (group === undefined) return [];
  const elements = group.childNodes.filter(isElement);
  const allowed = new Set(["prop", "state", "computed", "data", "handler", "event", "method"]);
  const names = new Set<string>(formNames);
  for (const element of elements) {
    const kind = element.tagName;
    if (!allowed.has(kind)) {
      fail("HC021", `<${kind}> is not a recognized definition declaration.`, source);
    }
    const name = attr(element, "name") ?? "";
    if (name === "") fail("HC010", `A <${kind}> requires a \`name\` attribute.`, source);
    if (names.has(name)) {
      fail("HC020", `Declaration \`${name}\` collides in the flat component scope.`, source);
    }
    names.add(name);
  }

  const scope: ParseScope = {
    roots: new Set([...Object.keys(contract.props), ...names]),
    writableRoots: new Set(
      elements
        .filter((element) => element.tagName === "state")
        .map((element) => attr(element, "name")!),
    ),
    handlers: new Set(
      elements
        .filter((element) => element.tagName === "handler")
        .map((element) => attr(element, "name")!),
    ),
  };
  const declarations: ComponentDeclaration[] = [];
  for (const element of elements) {
    const kind = element.tagName;
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
      declarations.push({
        kind,
        name,
        ...(literal === undefined ? {} : { value: literal }),
        ...(expression === undefined ? {} : { expression }),
      });
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
      const dataSchema = attr(element, "schema");
      const dataDebounce = attr(element, "debounce");
      const dataPoll = attr(element, "poll");
      const parameters = directElements(element, "param").map((parameter) => {
        const parameterName = attr(parameter, "name") ?? "";
        const expressionSource = attr(parameter, ":value");
        if (!NAME_RE.test(parameterName) || expressionSource === undefined) {
          fail("HC024", "A data <param> requires a valid `name` and a `:value` expression.", source);
        }
        return Object.freeze({
          name: parameterName,
          expression: compileScopedExpression(expressionSource, scope, source),
        });
      });
      if (new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length) {
        fail("HC024", `Data source \`${name}\` repeats a parameter name.`, source);
      }
      declarations.push({
        kind,
        name,
        ...(dataSource === undefined ? {} : { source: dataSource }),
        ...(dataType === undefined ? {} : { type: dataType }),
        ...(dataSchema === undefined ? {} : { schema: dataSchema }),
        ...(dataDebounce === undefined ? {} : { debounce: dataDebounce }),
        ...(dataPoll === undefined ? {} : { poll: dataPoll }),
        parameters: Object.freeze(parameters),
      });
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
      steps: Object.freeze(readHandlerSteps(element, scope, source)),
    });
  }
  return declarations;
}

function enhancedForms(root: Element, source: string): Element[] {
  const forms: Element[] = [];
  const visit = (element: Element): void => {
    if (element.tagName === "form" && attr(element, "src") !== undefined) forms.push(element);
    for (const child of element.childNodes) if (isElement(child)) visit(child);
  };
  visit(root);
  const names = new Set<string>();
  for (const form of forms) {
    const name = attr(form, "name") ?? "";
    if (!NAME_RE.test(name)) fail("HC025", "An enhanced form requires a valid `name`.", source);
    if (names.has(name)) fail("HC020", `Enhanced form \`${name}\` is duplicated.`, source);
    names.add(name);
  }
  return forms;
}

function readFormDeclarations(
  forms: readonly Element[],
  scope: ParseScope,
  source: string,
): FormDeclaration[] {
  return forms.map((form) => {
    const name = attr(form, "name")!;
    const formSource = attr(form, "src")!;
    if (formSource === "") fail("HC025", `Enhanced form \`${name}\` requires a non-empty \`src\`.`, source);
    const parameters = directElements(form, "param").map((parameter) => {
      const parameterName = attr(parameter, "name") ?? "";
      const expressionSource = attr(parameter, ":value");
      if (!NAME_RE.test(parameterName) || expressionSource === undefined) {
        fail("HC025", "A form <param> requires a valid `name` and a `:value` expression.", source);
      }
      return Object.freeze({
        name: parameterName,
        expression: compileScopedExpression(expressionSource, scope, source),
      });
    });
    if (new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length) {
      fail("HC025", `Enhanced form \`${name}\` repeats a parameter name.`, source);
    }
    return { kind: "form", name, source: formSource, parameters: Object.freeze(parameters) };
  });
}

function parseAttributes(
  element: Element,
  contract: ComponentContract,
  scope: ParseScope,
  source: string,
): TemplateAttribute[] {
  return element.attrs
    .filter(
      (attribute) =>
        !FLOW_NAMES.has(attribute.name) &&
        attribute.name !== "$ref" &&
        attribute.name !== "as" &&
        !(element.tagName === "form" && attribute.name === "src") &&
        !attribute.name.startsWith("on:"),
    )
    .map((attribute) => {
    if (attribute.name.startsWith("bind:")) {
      const name = attribute.name.slice("bind:".length).toLowerCase();
      if (name === "" || RAW_SINKS.has(name)) {
        fail("HT007", `Two-way binding cannot target \`${name || attribute.name}\`.`, source);
      }
      const expressionPlan = compileScopedExpression(attribute.value, scope, source);
      const writablePath = getWritablePath(attribute.value, scope.writableRoots);
      if (writablePath === undefined) {
        fail("HT005", `\`${attribute.value}\` is not a writable state-rooted path.`, source);
      }
      return {
        kind: "attribute",
        name,
        expression: attribute.value,
        expressionPlan,
        twoWay: true,
        writablePath,
      };
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
      return {
        kind: "attribute",
        name,
        expression: attribute.value,
        expressionPlan: compileScopedExpression(attribute.value, scope, source),
        target,
      };
    }

    if (attribute.name.startsWith("$")) {
      const name = attribute.name.slice(1).toLowerCase();
      if (name !== "value" && name !== "html") {
        fail("HT012", `\`$${name}\` is not a known content directive.`, source);
      }
      return {
        kind: "directive",
        name,
        expression: attribute.value,
        expressionPlan: compileScopedExpression(attribute.value, scope, source),
      };
    }

    if (attribute.name.startsWith(":")) {
      const name = attribute.name.slice(1).toLowerCase();
      if (RAW_SINKS.has(name)) {
        fail("HT007", `\`:${name}\` cannot bind a raw content sink.`, source);
      }
      const expressionPlan = compileScopedExpression(attribute.value, scope, source);
      const prop = contract.props[attribute.value];
      if (prop !== undefined && (!("attribute" in prop.target) || prop.target.attribute !== name)) {
        fail("HT004", `Binding \`:${name}\` does not match prop \`${attribute.value}\`'s target.`, source);
      }
      return { kind: "attribute", name, expression: attribute.value, expressionPlan };
    }

    if (attribute.name.startsWith(".")) {
      const key = attribute.name.slice(1).toLowerCase();
      const expressionPlan = compileScopedExpression(attribute.value, scope, source);
      const prop = contract.props[attribute.value];
      if (prop !== undefined && (!("property" in prop.target) || prop.target.property.toLowerCase() !== key)) {
        fail("HT004", `Property binding \`.${key}\` does not match prop \`${attribute.value}\`'s target.`, source);
      }
      const name = resolveDomProperty(element.tagName, key);
      if (name === undefined) {
        fail("HP001", `\`${key}\` is not a known property of <${element.tagName}>.`, source);
      }
      validateMvpDomProperty(name, source);
      return { kind: "property", key, name, expression: attribute.value, expressionPlan };
    }

    validateLiteralAttributeName(attribute.name, source, attribute.value);
    return { kind: "literal", name: attribute.name, value: attribute.value };
  });
}

function parseEvents(element: Element, scope: ParseScope, source: string): EventBinding[] {
  const events: EventBinding[] = [];
  for (const attribute of element.attrs.filter((item) => item.name.startsWith("on:"))) {
    const [name = "", ...modifiers] = attribute.name.slice("on:".length).split(".");
    if (!EVENT_PART_RE.test(name) || modifiers.some((modifier) => !EVENT_PART_RE.test(modifier))) {
      fail("HT010", `\`${attribute.name}\` is not a valid declarative event binding.`, source);
    }
    if (new Set(modifiers).size !== modifiers.length) {
      fail("HT010", `\`${attribute.name}\` repeats an event modifier.`, source);
    }
    if (modifiers.some((modifier) => !EVENT_MODIFIERS.has(modifier))) {
      fail("HT010", `\`${attribute.name}\` contains an unsupported event modifier.`, source);
    }
    if (modifiers.includes("passive") && modifiers.includes("prevent")) {
      fail("HT010", `\`${attribute.name}\` cannot combine passive and prevent.`, source);
    }
    if (!scope.handlers.has(attribute.value)) {
      fail("HT010", `Event binding \`${attribute.name}\` names undeclared handler \`${attribute.value}\`.`, source);
    }
    events.push({ name, handler: attribute.value, modifiers: Object.freeze(modifiers) });
  }
  return events;
}

function parseRef(element: Element, refs: Set<string>, source: string): string | undefined {
  const name = attr(element, "$ref");
  if (name === undefined) return undefined;
  if (!NAME_RE.test(name)) fail("HT019", "`$ref` requires a valid non-empty name.", source);
  if (refs.has(name)) fail("HT019", `Reference \`${name}\` is duplicated.`, source);
  refs.add(name);
  return name;
}

function extractFlow(element: Element, scope: ParseScope, source: string): Flow | undefined {
  const has = (name: string): boolean => attr(element, name) !== undefined;
  const value = (name: string): string => attr(element, name) ?? "";
  const structural = ["$if", "$each", "$with", "$match", "$when", "$else"].filter(has);
  if (structural.length > 1) {
    fail("HT014", `An element carries one structural directive; found ${structural.join(", ")}.`, source);
  }
  const eachModifiers = ["$where", "$sort", "$limit", "$key"].filter(has);
  if (!has("$each") && eachModifiers.length > 0) {
    fail("HT014", `${eachModifiers.join(", ")} may only modify \`$each\`.`, source);
  }

  if (has("$if")) {
    const test = value("$if");
    return { kind: "if", test, testPlan: compileScopedExpression(test, scope, source) };
  }
  if (has("$with")) {
    const match = AS_RE.exec(value("$with"));
    if (match === null) fail("HT015", "`$with` must be written `expr as name`.", source);
    return {
      kind: "with",
      expr: match[1]!,
      expressionPlan: compileScopedExpression(match[1]!, scope, source),
      alias: match[2]!,
    };
  }
  if (has("$each")) {
    const match = EACH_RE.exec(value("$each"));
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
      ...(index === undefined ? {} : { index }),
      list: match[3]!,
      listPlan: compileScopedExpression(match[3]!, scope, source),
    };
    if (has("$where")) {
      result.where = value("$where");
      result.wherePlan = compileScopedExpression(result.where, localScope, source);
    }
    if (has("$sort")) result.sort = value("$sort");
    if (has("$limit")) {
      result.limit = value("$limit");
      result.limitPlan = compileScopedExpression(result.limit, localScope, source);
    }
    if (has("$key")) {
      result.key = value("$key");
      result.keyPlan = compileScopedExpression(result.key, localScope, source);
    }
    return result;
  }
  if (has("$match")) {
    const raw = value("$match").trim();
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
  if (has("$when")) {
    const test = value("$when");
    return { kind: "when", test, testPlan: compileScopedExpression(test, scope, source) };
  }
  if (has("$else")) return { kind: "else" };
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
): ElementNode {
  if (isReservedElement(element.tagName)) {
    fail("HT009", `<${element.tagName}> is reserved but not supported by the component MVP.`, source);
  }
  validateDefinitionElementName(element.tagName, source);

  const flow = extractFlow(element, scope, source);
  const nodeScope =
    flow?.kind === "each"
      ? withRoots(scope, flow.item, flow.index, "loop")
      : flow?.kind === "with" || (flow?.kind === "match" && flow.alias !== undefined)
        ? withRoots(scope, flow.alias)
        : scope;
  const attributes = parseAttributes(element, contract, nodeScope, source);
  const events = parseEvents(element, nodeScope, source);
  const ref = parseRef(element, slotState.refs, source);
  const children: TemplateNode[] = [];
  const childNodes =
    element.tagName === "template" && "content" in element
      ? (element as Template).content.childNodes
      : element.childNodes;
  for (const child of childNodes) {
    if (child.nodeName === "#comment") continue;
    if (isText(child)) {
      if (child.value.trim() !== "") children.push({ kind: "text", value: child.value });
      continue;
    }
    if (!isElement(child)) continue;
    if (element.tagName === "form" && attr(element, "src") !== undefined && child.tagName === "param") {
      continue;
    }
    if (child.tagName === "slot") {
      const name = attr(child, "name");
      const nameExpression = attr(child, ":name");
      if (name !== undefined && nameExpression !== undefined) {
        fail("HT008", "A slot cannot declare both `name` and `:name`.", source);
      }
      const unknown = child.attrs.filter((item) => item.name !== "name" && item.name !== ":name");
      if (unknown.length > 0) fail("HT008", "A slot has an unsupported attribute.", source);
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
      for (const fallbackNode of child.childNodes) {
        if (fallbackNode.nodeName === "#comment") continue;
        if (isText(fallbackNode)) {
          if (fallbackNode.value.trim() !== "") fallback.push({ kind: "text", value: fallbackNode.value });
        } else if (isElement(fallbackNode)) {
          fallback.push(parseElement(fallbackNode, contract, nodeScope, source, slotState));
        }
      }
      const dynamic = nameExpression !== undefined;
      slotState.contracts.push({
        ...(name === undefined ? {} : { name }),
        dynamic,
        required: fallback.length === 0,
      });
      if (name === undefined && nameExpression === undefined && fallback.length === 0) {
        children.push({ kind: "slot" });
      } else {
        children.push({
          kind: "slot",
          ...(name === undefined ? {} : { name }),
          ...(nameExpression === undefined
            ? {}
            : { nameExpression: compileScopedExpression(nameExpression, nodeScope, source) }),
          fallback: Object.freeze(fallback),
        });
      }
      continue;
    }
    children.push(parseElement(child, contract, nodeScope, source, slotState));
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
    const arms = children.filter((node): node is ElementNode => node.kind === "element");
    let elseSeen = false;
    arms.forEach((arm, index) => {
      if (arm.flow?.kind === "when") {
        if (elseSeen) fail("HT018", "A `$when` arm may not follow `$else`.", source);
      } else if (arm.flow?.kind === "else") {
        if (elseSeen) fail("HT018", "A `$match` has at most one `$else`.", source);
        elseSeen = true;
        if (index !== arms.length - 1) fail("HT018", "`$else` must be the last arm.", source);
      } else {
        fail("HT018", "Every direct child of a `$match` must be a `$when` or `$else` arm.", source);
      }
    });
  }

  return {
    kind: "element",
    name: element.tagName,
    attributes,
    children,
    ...(flow === undefined ? {} : { flow }),
    ...(events.length === 0 ? {} : { events: Object.freeze(events) }),
    ...(ref === undefined ? {} : { ref }),
  };
}

export function parseComponent(sourceText: string, source = "<source>"): ComponentDefinition {
  const parserErrors: ParserError[] = [];
  const fragment = parseFragment(sourceText, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parserErrors.push(error),
  });
  if (parserErrors.length > 0) {
    fail("HS005", `HTML parse error: ${parserErrors[0]!.code}.`, source);
  }

  const roots = significant(fragment.childNodes).filter(isElement);
  if (
    roots.length !== 1 ||
    roots[0]!.tagName !== "template" ||
    attr(roots[0]!, "component") === undefined
  ) {
    fail("HS001", "A source must contain exactly one top-level <template component>.", source);
  }
  if (significant(fragment.childNodes).length !== 1) {
    fail("HS001", "A source must contain only one top-level component definition.", source);
  }
  const wrapper = roots[0]! as Template;
  const tag = attr(wrapper, "component")!;

  // A <template>'s children live in its content fragment, inert and unrendered.
  const content = wrapper.content.childNodes;
  const contentElement = (name: string): Element[] =>
    content.filter((node): node is Element => isElement(node) && node.tagName === name);
  const propGroups = contentElement("props");
  const defGroups = contentElement("defs");
  const styles = contentElement("style");
  if (propGroups.length + defGroups.length > 1 || styles.length > 1) {
    fail("HS002", "A component has one optional declaration group, one markup root, and one optional <style>.", source);
  }

  // Everything that is not the props group or a style is the component markup.
  const known = new Set<Element>([...propGroups, ...defGroups, ...styles]);
  const markup = significant(content).filter((node) => !known.has(node as Element));
  if (markup.length !== 1 || !isElement(markup[0]!)) {
    fail("HT001", "A component's markup must be exactly one element root.", source);
  }
  const root = markup[0] as Element;
  const rootChoices = (attr(root, "as") ?? root.tagName)
    .split("|")
    .map((choice) => choice.trim())
    .filter((choice) => choice !== "");
  const delegatedRoot = getDomInterface(root.tagName) === undefined;
  if (delegatedRoot && attr(root, "as") !== undefined) {
    fail("HT021", "A delegated component root cannot also declare native `as` choices.", source);
  }
  if (
    !delegatedRoot &&
    (rootChoices.length === 0 ||
      !rootChoices.includes(root.tagName) ||
      new Set(rootChoices).size !== rootChoices.length ||
      rootChoices.some((choice) => getDomInterface(choice) === undefined))
  ) {
    fail("HT021", "A polymorphic root must list unique native choices including its markup root.", source);
  }

  const targets = collectTargets(root, source);
  const rawContract = {
    status: attr(wrapper, "status"),
    summary: attr(wrapper, "summary"),
    nativeElement: root.tagName,
    props: readProps(propGroups[0] ?? defGroups[0], targets, source, defGroups.length === 0),
  };
  const contract = defineContract(rawContract, { source, tag });

  const forms = enhancedForms(root, source);
  const formNames = new Set(forms.map((form) => attr(form, "name")!));
  const declarations = readDeclarations(defGroups[0], contract, source, formNames);
  const declaredEvents = new Set(
    declarations.filter((declaration) => declaration.kind === "event").map((declaration) => declaration.name),
  );
  for (const declaration of declarations) {
    if (declaration.kind !== "handler") continue;
    for (const step of declaration.steps) {
      if (step.kind === "dispatch" && !declaredEvents.has(step.event)) {
        fail("HC023", `Handler \`${declaration.name}\` dispatches undeclared component event \`${step.event}\`.`, source);
      }
    }
  }
  const rootsInScope = new Set([
    ...Object.keys(contract.props),
    ...declarations.map((declaration) => declaration.name),
    ...formNames,
  ]);
  const scope: ParseScope = {
    roots: rootsInScope,
    writableRoots: new Set(
      declarations
        .filter((declaration) => declaration.kind === "state")
        .map((declaration) => declaration.name),
    ),
    handlers: new Set(
      declarations
        .filter((declaration) => declaration.kind === "handler")
        .map((declaration) => declaration.name),
    ),
  };
  for (const declaration of declarations) {
    if (
      (declaration.kind === "state" || declaration.kind === "computed") &&
      declaration.expression !== undefined
    ) {
      validateCompiledExpression(declaration.expression, scope, source);
    }
  }
  declarations.push(...readFormDeclarations(forms, scope, source));
  const slotState = {
    defaults: 0,
    names: new Set<string>(),
    contracts: [] as SlotContract[],
    refs: new Set<string>(),
  };
  const template = parseElement(root, contract, scope, source, slotState);
  const controller = attr(wrapper, "controller");
  if (controller === "") fail("HC022", "A controller specifier cannot be empty.", source);

  return Object.freeze({
    source: Object.freeze({ file: source }),
    contract,
    template,
    css: styles.length === 0 ? "" : textContent(styles[0]!).trim(),
    ...(controller === undefined ? {} : { controller }),
    declarations: Object.freeze(declarations),
    slots: Object.freeze(slotState.contracts),
    root: delegatedRoot
      ? Object.freeze({ kind: "component" as const, tag: root.tagName })
      : Object.freeze({
          kind: "native" as const,
          element: root.tagName,
          choices: Object.freeze(rootChoices),
        }),
  });
}
