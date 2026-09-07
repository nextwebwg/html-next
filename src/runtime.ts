import { defineContract, serializePropTarget } from "./contract.js";
import { fail } from "./diagnostics.js";
import {
  CONTRACT_TYPE,
  isReservedElement,
  validateSimplePropExpression,
} from "./language.js";
import { resolveDomProperty } from "./platform.js";
import type {
  ComponentDefinition,
  ElementNode,
  TemplateAttribute,
  TemplateNode,
} from "./template.js";
import type {
  ComponentContract,
  PropContract,
  PropValue,
  SerializedPropTarget,
} from "./types.js";

interface LiveDefinition {
  readonly wrapper: Element;
  readonly style: HTMLStyleElement | undefined;
  readonly definition: ComponentDefinition;
}

function significant(nodes: ArrayLike<Node>): Node[] {
  return Array.from(nodes).filter((node) => {
    if (node.nodeType === Node.COMMENT_NODE) return false;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() !== "";
    return true;
  });
}

function directElements(wrapper: Element, name: string): Element[] {
  return Array.from(wrapper.children).filter((element) => element.localName === name);
}

function parseAttributes(
  element: Element,
  contract: ComponentContract,
  source: string,
): TemplateAttribute[] {
  return Array.from(element.attributes).map((attribute) => {
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
      const name = resolveDomProperty(element.localName, key);
      if (name === undefined) {
        fail("H7P001", `\`${key}\` is not a known property of <${element.localName}>.`, source);
      }
      if (name === "innerHTML") {
        fail("H7T007", "Dynamic innerHTML requires a future trusted-HTML type.", source);
      }
      return { kind: "property", key, name, expression };
    }

    return { kind: "literal", name: attribute.name, value: attribute.value };
  });
}

function parseElement(
  element: Element,
  contract: ComponentContract,
  source: string,
  slotCount: { value: number },
): ElementNode {
  if (isReservedElement(element.localName)) {
    fail("H7T009", `<${element.localName}> is reserved but not supported by the component MVP.`, source);
  }

  const attributes = parseAttributes(element, contract, source);
  const children: TemplateNode[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim() !== "") {
        children.push({ kind: "text", value: child.textContent ?? "" });
      }
      continue;
    }
    if (!(child instanceof Element)) continue;
    if (child.localName === "slot") {
      slotCount.value += 1;
      if (
        slotCount.value > 1 ||
        child.attributes.length > 0 ||
        significant(child.childNodes).length > 0
      ) {
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

  return { kind: "element", name: element.localName, attributes, children };
}

function parseDefinition(wrapper: Element, index: number): LiveDefinition {
  const source = `${wrapper.ownerDocument.URL}#html7-component[${index + 1}]`;
  const contractScripts = directElements(wrapper, "script").filter(
    (element) => element.getAttribute("type")?.toLowerCase() === CONTRACT_TYPE,
  );
  const templates = directElements(wrapper, "template");
  const styles = directElements(wrapper, "style");
  if (contractScripts.length !== 1 || templates.length !== 1 || styles.length > 1) {
    fail("H7S002", "A component requires one contract, one template, and at most one style.", source);
  }

  const allowed = new Set<Element>([contractScripts[0]!, templates[0]!, ...styles]);
  if (
    significant(wrapper.childNodes).some(
      (node) => !(node instanceof Element) || !allowed.has(node),
    )
  ) {
    fail("H7S003", "A component contains an unknown definition block.", source);
  }

  let rawContract: unknown;
  try {
    rawContract = JSON.parse(contractScripts[0]!.textContent ?? "");
  } catch {
    fail("H7S004", "The component contract is not valid JSON.", source);
  }
  const contract = defineContract(rawContract, { source });

  const template = templates[0]!;
  if (!(template instanceof HTMLTemplateElement)) {
    fail("H7S002", "The component template is not an HTML template element.", source);
  }
  const roots = significant(template.content.childNodes);
  if (roots.length !== 1 || !(roots[0] instanceof Element)) {
    fail("H7T001", "The MVP template must contain exactly one element root.", source);
  }
  const root = roots[0];
  if (root.localName !== contract.nativeElement) {
    fail(
      "H7T002",
      `Template root <${root.localName}> does not match nativeElement <${contract.nativeElement}>.`,
      source,
    );
  }
  const normalizedTemplate = parseElement(root, contract, source, { value: 0 });
  const style = styles[0] as HTMLStyleElement | undefined;

  return {
    wrapper,
    style,
    definition: Object.freeze({
      source: Object.freeze({ file: source }),
      contract,
      template: normalizedTemplate,
      css: style?.textContent?.trim() ?? "",
    }),
  };
}

function invocationValue(prop: PropContract, attributeValue: string): PropValue {
  if (prop.type === "boolean") return true;
  if (prop.type === "number") {
    if (attributeValue.trim() === "") {
      fail("H7R002", "A number prop invocation value must not be empty.");
    }
    const value = Number(attributeValue);
    if (!Number.isFinite(value)) {
      fail("H7R002", `\`${attributeValue}\` is not a finite number prop value.`);
    }
    return value;
  }
  return attributeValue;
}

function readInvocation(
  invocation: Element,
  contract: ComponentContract,
): {
  readonly targets: Readonly<Record<string, SerializedPropTarget>>;
  readonly passThrough: readonly Attr[];
} {
  const names = new Map<string, string>();
  for (const name of Object.keys(contract.props)) names.set(name.toLowerCase(), name);

  const values: Record<string, PropValue | undefined> = {};
  const passThrough: Attr[] = [];
  for (const attribute of Array.from(invocation.attributes)) {
    const propName = names.get(attribute.name.toLowerCase());
    if (propName === undefined) {
      passThrough.push(attribute);
      continue;
    }
    values[propName] = invocationValue(contract.props[propName]!, attribute.value);
  }

  const targets: Record<string, SerializedPropTarget> = {};
  for (const [name, prop] of Object.entries(contract.props)) {
    targets[name] = serializePropTarget(prop, values[name]);
  }
  return { targets, passThrough };
}

function setAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function renderElement(
  node: ElementNode,
  targets: Readonly<Record<string, SerializedPropTarget>>,
  slotChildren: readonly Node[],
  document: Document,
  passThrough: readonly Attr[] = [],
): Element {
  const element = document.createElement(node.name);
  for (const attribute of passThrough) {
    element.setAttribute(attribute.name, attribute.value);
  }

  for (const attribute of node.attributes) {
    if (attribute.kind === "literal") {
      element.setAttribute(attribute.name, attribute.value);
      continue;
    }

    const target = targets[attribute.expression]!;
    if (attribute.kind === "attribute") {
      if (target.kind !== "attribute") {
        fail("H7R003", `Binding \`${attribute.expression}\` did not resolve to an attribute.`);
      }
      setAttribute(element, attribute.name, target.value);
      continue;
    }

    const propertyName = resolveDomProperty(node.name, attribute.key);
    if (propertyName === undefined || propertyName !== attribute.name || target.kind !== "property") {
      fail("H7R003", `Binding \`${attribute.expression}\` did not resolve to a known DOM property.`);
    }
    (element as unknown as Record<string, unknown>)[propertyName] = target.value;
  }

  for (const child of node.children) {
    if (child.kind === "text") {
      element.append(document.createTextNode(child.value));
    } else if (child.kind === "slot") {
      element.append(...slotChildren);
    } else {
      element.append(renderElement(child, targets, slotChildren, document));
    }
  }
  return element;
}

/**
 * Performs one explicit lowering pass over the document's current HTML7 definitions
 * and invocations. It does not observe later mutations or register Custom Elements.
 */
export function lowerDocument(root: Document = document): number {
  const wrappers = Array.from(root.querySelectorAll("html7-component"));
  for (const wrapper of wrappers) wrapper.setAttribute("hidden", "");

  const definitions = wrappers.map(parseDefinition);
  const tags = new Set<string>();
  for (const { definition } of definitions) {
    if (tags.has(definition.contract.tag)) {
      fail("H7R001", `More than one definition declares <${definition.contract.tag}>.`);
    }
    tags.add(definition.contract.tag);
  }

  const invocations = definitions.map(({ definition }) => ({
    definition,
    elements: Array.from(root.querySelectorAll(definition.contract.tag)).filter(
      (element) => element.closest("html7-component") === null,
    ),
  }));

  for (const live of definitions) {
    if (live.style !== undefined) live.wrapper.ownerDocument.head.append(live.style);
    live.wrapper.remove();
  }

  let lowered = 0;
  for (const { definition, elements } of invocations) {
    for (const invocation of elements) {
      const { targets, passThrough } = readInvocation(invocation, definition.contract);
      const children = Array.from(invocation.childNodes);
      const nativeRoot = renderElement(
        definition.template,
        targets,
        children,
        invocation.ownerDocument,
        passThrough,
      );
      invocation.replaceWith(nativeRoot);
      lowered += 1;
    }
  }
  return lowered;
}
