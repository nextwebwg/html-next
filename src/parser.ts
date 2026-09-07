import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

import { coerceDefault, defineContract, parseTypeAttribute } from "./contract.js";
import { fail } from "./diagnostics.js";
import {
  isReservedElement,
  validateLiteralAttributeName,
  validateMvpDomProperty,
  validateSimplePropExpression,
} from "./language.js";
import { resolveDomProperty } from "./platform.js";
import type {
  ComponentDefinition,
  ElementNode,
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
      fail("H7T004", `Prop \`${name}\` is bound to conflicting targets.`, source);
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
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (group === undefined) return props;
  for (const element of directElements(group, "prop")) {
    const name = attr(element, "name");
    if (name === undefined || name === "") {
      fail("H7C010", "A <prop> requires a `name` attribute.", source);
    }
    const typeAttribute = attr(element, "type");
    if (typeAttribute === undefined || typeAttribute === "") {
      fail("H7C013", `Prop \`${name}\` requires a \`type\` attribute.`, source);
    }
    const target = targets[name];
    if (target === undefined) {
      fail("H7C018", `Prop \`${name}\` is declared but never bound in the markup.`, source);
    }
    const type = parseTypeAttribute(typeAttribute);
    const spec: Record<string, unknown> = { type, target, description: textContent(element).trim() };
    if (element.attrs.some((item) => item.name === "required")) spec.required = true;
    const defaultValue = attr(element, "default");
    if (defaultValue !== undefined) spec.default = coerceDefault(type, defaultValue);
    props[name] = spec;
  }
  return props;
}

function parseAttributes(
  element: Element,
  contract: ComponentContract,
  source: string,
): TemplateAttribute[] {
  return element.attrs.map((attribute) => {
    if (attribute.name.startsWith("bind:")) {
      fail("H7T005", "Two-way bindings are reserved but not supported by the component MVP.", source);
    }

    if (attribute.name.startsWith(":")) {
      const name = attribute.name.slice(1).toLowerCase();
      const expression = validateSimplePropExpression(attribute.value, contract, source);
      const target = contract.props[expression]!.target;
      if (!("attribute" in target) || target.attribute !== name) {
        fail("H7T004", `Binding \`:${name}\` does not match prop \`${expression}\`'s target.`, source);
      }
      return { kind: "attribute", name, expression };
    }

    if (attribute.name.startsWith(".")) {
      const key = attribute.name.slice(1).toLowerCase();
      const expression = validateSimplePropExpression(attribute.value, contract, source);
      const target = contract.props[expression]!.target;
      if (!("property" in target) || target.property.toLowerCase() !== key) {
        fail("H7T004", `Property binding \`.${key}\` does not match prop \`${expression}\`'s target.`, source);
      }
      const name = resolveDomProperty(element.tagName, key);
      if (name === undefined) {
        fail("H7P001", `\`${key}\` is not a known property of <${element.tagName}>.`, source);
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
  slotCount: { value: number },
): ElementNode {
  if (isReservedElement(element.tagName)) {
    fail("H7T009", `<${element.tagName}> is reserved but not supported by the component MVP.`, source);
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
      slotCount.value += 1;
      if (slotCount.value > 1 || child.attrs.length > 0 || significant(child.childNodes).length > 0) {
        fail("H7T008", "The MVP supports exactly one empty default slot.", source);
      }
      children.push({ kind: "slot" });
      continue;
    }
    children.push(parseElement(child, contract, source, slotCount));
  }

  if (
    attributes.some(
      (binding) => binding.kind === "property" && binding.name === "textContent",
    ) &&
    children.length > 0
  ) {
    fail("H7T006", "A content-replacing property binding cannot coexist with children.", source);
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
    fail("H7S005", `HTML parse error: ${parserErrors[0]!.code}.`, source);
  }

  const roots = significant(fragment.childNodes).filter(isElement);
  if (
    roots.length !== 1 ||
    roots[0]!.tagName !== "template" ||
    attr(roots[0]!, "component") === undefined
  ) {
    fail("H7S001", "A source must contain exactly one top-level <template component>.", source);
  }
  if (significant(fragment.childNodes).length !== 1) {
    fail("H7S001", "A source must contain only one top-level component definition.", source);
  }
  const wrapper = roots[0]! as Template;
  const tag = attr(wrapper, "component")!;

  // A <template>'s children live in its content fragment, inert and unrendered.
  const content = wrapper.content.childNodes;
  const contentElement = (name: string): Element[] =>
    content.filter((node): node is Element => isElement(node) && node.tagName === name);
  const propGroups = contentElement("props");
  const styles = contentElement("style");
  if (propGroups.length > 1 || styles.length > 1) {
    fail("H7S002", "A component has an optional <props> group, one markup root, and an optional <style>.", source);
  }

  // Everything that is not the props group or a style is the component markup.
  const known = new Set<Element>([...propGroups, ...styles]);
  const markup = significant(content).filter((node) => !known.has(node as Element));
  if (markup.length !== 1 || !isElement(markup[0]!)) {
    fail("H7T001", "A component's markup must be exactly one element root.", source);
  }
  const root = markup[0] as Element;

  const targets = collectTargets(root, source);
  const rawContract = {
    status: attr(wrapper, "status"),
    summary: attr(wrapper, "summary"),
    nativeElement: root.tagName,
    props: readProps(propGroups[0], targets, source),
  };
  const contract = defineContract(rawContract, { source, tag });

  const slotCount = { value: 0 };
  const template = parseElement(root, contract, source, slotCount);

  return Object.freeze({
    source: Object.freeze({ file: source }),
    contract,
    template,
    css: styles.length === 0 ? "" : textContent(styles[0]!).trim(),
  });
}
