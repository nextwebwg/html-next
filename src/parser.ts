import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

import { coerceDefault, defineContract, parseTypeAttribute } from "./contract.js";
import { fail } from "./diagnostics.js";
import { compileExpression } from "./expression.js";
import {
  isReservedElement,
  validateLiteralAttributeName,
  validateMvpDomProperty,
  validateSimplePropExpression,
} from "./language.js";
import { resolveDomProperty } from "./platform.js";
import type {
  ComponentDefinition,
  ComponentDeclaration,
  ElementNode,
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
        record(attribute.value, { attribute: attribute.name.slice(1).toLowerCase() });
      } else if (attribute.name.startsWith(".")) {
        const key = attribute.name.slice(1).toLowerCase();
        record(attribute.value, { property: resolveDomProperty(element.tagName, key) ?? key });
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

function readDeclarations(group: Element | undefined, source: string): ComponentDeclaration[] {
  if (group === undefined) return [];
  const declarations: ComponentDeclaration[] = [];
  const names = new Set<string>();
  for (const element of group.childNodes.filter(isElement)) {
    const kind = element.tagName;
    if (kind === "prop") {
      const name = attr(element, "name") ?? "";
      if (name !== "" && names.has(name)) {
        fail("HC020", `Declaration \`${name}\` collides in the flat component scope.`, source);
      }
      if (name !== "") names.add(name);
      continue;
    }
    if (!new Set(["state", "computed", "data", "handler", "event", "method"]).has(kind)) {
      fail("HC021", `<${kind}> is not a recognized definition declaration.`, source);
    }
    const name = attr(element, "name") ?? "";
    if (name === "") fail("HC010", `A <${kind}> requires a \`name\` attribute.`, source);
    if (names.has(name)) {
      fail("HC020", `Declaration \`${name}\` collides in the flat component scope.`, source);
    }
    names.add(name);

    if (kind === "state" || kind === "computed") {
      const raw = kind === "state" ? attr(element, ":value") : attr(element, "from");
      if (kind === "computed" && (raw === undefined || raw === "")) {
        fail("HC013", `<computed name="${name}"> requires a \`from\` expression.`, source);
      }
      declarations.push({
        kind,
        name,
        ...(raw === undefined ? {} : { expression: compileDeclarationExpression(raw, source) }),
      });
      continue;
    }
    if (kind === "data") {
      const dataSource = attr(element, "src");
      declarations.push({ kind, name, ...(dataSource === undefined ? {} : { source: dataSource }) });
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
    declarations.push({ kind: "handler", name, source: textContent(element).trim() });
  }
  return declarations;
}

function parseAttributes(
  element: Element,
  contract: ComponentContract,
  source: string,
): TemplateAttribute[] {
  return element.attrs.map((attribute) => {
    if (attribute.name.startsWith("bind:")) {
      fail("HT005", "Two-way bindings are reserved but not supported by the component MVP.", source);
    }

    if (attribute.name.startsWith(":")) {
      const name = attribute.name.slice(1).toLowerCase();
      const expression = validateSimplePropExpression(attribute.value, contract, source);
      const target = contract.props[expression]!.target;
      if (!("attribute" in target) || target.attribute !== name) {
        fail("HT004", `Binding \`:${name}\` does not match prop \`${expression}\`'s target.`, source);
      }
      return { kind: "attribute", name, expression };
    }

    if (attribute.name.startsWith(".")) {
      const key = attribute.name.slice(1).toLowerCase();
      const expression = validateSimplePropExpression(attribute.value, contract, source);
      const target = contract.props[expression]!.target;
      if (!("property" in target) || target.property.toLowerCase() !== key) {
        fail("HT004", `Property binding \`.${key}\` does not match prop \`${expression}\`'s target.`, source);
      }
      const name = resolveDomProperty(element.tagName, key);
      if (name === undefined) {
        fail("HP001", `\`${key}\` is not a known property of <${element.tagName}>.`, source);
      }
      validateMvpDomProperty(name, source);
      return { kind: "property", key, name, expression };
    }

    validateLiteralAttributeName(attribute.name, source);
    return { kind: "literal", name: attribute.name, value: attribute.value };
  });
}

function parseElement(
  element: Element,
  contract: ComponentContract,
  source: string,
  slotState: { defaults: number; names: Set<string>; contracts: SlotContract[] },
): ElementNode {
  if (isReservedElement(element.tagName)) {
    fail("HT009", `<${element.tagName}> is reserved but not supported by the component MVP.`, source);
  }

  const attributes = parseAttributes(element, contract, source);
  const children: TemplateNode[] = [];
  for (const child of element.childNodes) {
    if (child.nodeName === "#comment") continue;
    if (isText(child)) {
      if (child.value.trim() !== "") children.push({ kind: "text", value: child.value });
      continue;
    }
    if (!isElement(child)) continue;
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
          fallback.push(parseElement(fallbackNode, contract, source, slotState));
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
            : { nameExpression: compileDeclarationExpression(nameExpression, source) }),
          fallback: Object.freeze(fallback),
        });
      }
      continue;
    }
    children.push(parseElement(child, contract, source, slotState));
  }

  if (
    attributes.some(
      (binding) => binding.kind === "property" && binding.name === "textContent",
    ) &&
    children.length > 0
  ) {
    fail("HT006", "A content-replacing property binding cannot coexist with children.", source);
  }

  return { kind: "element", name: element.tagName, attributes, children };
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

  const targets = collectTargets(root, source);
  const rawContract = {
    status: attr(wrapper, "status"),
    summary: attr(wrapper, "summary"),
    nativeElement: root.tagName,
    props: readProps(propGroups[0] ?? defGroups[0], targets, source, defGroups.length === 0),
  };
  const contract = defineContract(rawContract, { source, tag });

  const slotState = { defaults: 0, names: new Set<string>(), contracts: [] as SlotContract[] };
  const template = parseElement(root, contract, source, slotState);
  const declarations = readDeclarations(defGroups[0], source);
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
  });
}
