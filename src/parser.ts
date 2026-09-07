import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

import { defineContract } from "./contract.js";
import { fail } from "./diagnostics.js";
import {
  CONTRACT_TYPE,
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
import type { ComponentContract } from "./types.js";

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
  if (roots.length !== 1 || roots[0]!.tagName !== "html7-component") {
    fail("H7S001", "A source must contain exactly one top-level <html7-component>.", source);
  }
  const wrapper = roots[0]!;
  if (significant(fragment.childNodes).length !== 1) {
    fail("H7S001", "A source must contain only one top-level component definition.", source);
  }

  const contractScripts = directElements(wrapper, "script").filter(
    (element) => attr(element, "type")?.toLowerCase() === CONTRACT_TYPE,
  );
  const templates = directElements(wrapper, "template") as Template[];
  const styles = directElements(wrapper, "style");
  if (contractScripts.length !== 1 || templates.length !== 1 || styles.length > 1) {
    fail("H7S002", "A component requires one contract, one template, and at most one style.", source);
  }

  const allowed = new Set<Element>([contractScripts[0]!, templates[0]!, ...styles]);
  const unknown = significant(wrapper.childNodes).filter(
    (node) => !isElement(node) || !allowed.has(node),
  );
  if (unknown.length > 0) {
    fail("H7S003", "A component contains an unknown definition block.", source);
  }

  let rawContract: unknown;
  try {
    rawContract = JSON.parse(textContent(contractScripts[0]!));
  } catch {
    fail("H7S004", "The component contract is not valid JSON.", source);
  }
  const contract = defineContract(rawContract, { source });
  const templateChildren = significant(templates[0]!.content.childNodes);
  if (templateChildren.length !== 1 || !isElement(templateChildren[0]!)) {
    fail("H7T001", "The MVP template must contain exactly one element root.", source);
  }
  const root = templateChildren[0]!;
  if (root.tagName !== contract.nativeElement) {
    fail("H7T002", `Template root <${root.tagName}> does not match nativeElement <${contract.nativeElement}>.`, source);
  }
  const slotCount = { value: 0 };
  const template = parseElement(root, contract, source, slotCount);

  return Object.freeze({
    source: Object.freeze({ file: source }),
    contract,
    template,
    css: styles.length === 0 ? "" : textContent(styles[0]!).trim(),
  });
}
