import { coerceDefault, defineContract, parseTypeAttribute, serializePropTarget } from "./contract.js";
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
import type {
  ComponentContract,
  PropContract,
  PropTarget,
  PropValue,
  SerializedPropTarget,
} from "./types.js";

interface LiveDefinition {
  readonly wrapper: Element;
  readonly style: HTMLStyleElement | undefined;
  readonly definition: ComponentDefinition;
}

interface PreparedInvocation {
  readonly invocation: Element;
  readonly nativeRoot: Element;
  readonly slotContainers: readonly Element[];
  readonly children: readonly Node[];
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
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith(":")) {
        record(attribute.value, { attribute: attribute.name.slice(1).toLowerCase() });
      } else if (attribute.name.startsWith(".")) {
        const key = attribute.name.slice(1).toLowerCase();
        record(attribute.value, { property: resolveDomProperty(element.localName, key) ?? key });
      }
    }
    for (const child of Array.from(element.children)) {
      if (child.localName !== "slot") visit(child);
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
    const name = element.getAttribute("name");
    if (name === null || name === "") {
      fail("H7C010", "A <prop> requires a `name` attribute.", source);
    }
    const typeAttribute = element.getAttribute("type");
    if (typeAttribute === null || typeAttribute === "") {
      fail("H7C013", `Prop \`${name}\` requires a \`type\` attribute.`, source);
    }
    const target = targets[name];
    if (target === undefined) {
      fail("H7C018", `Prop \`${name}\` is declared but never bound in the markup.`, source);
    }
    const type = parseTypeAttribute(typeAttribute);
    const spec: Record<string, unknown> = {
      type,
      target,
      description: (element.textContent ?? "").trim(),
    };
    if (element.hasAttribute("required")) spec.required = true;
    const defaultValue = element.getAttribute("default");
    if (defaultValue !== null) spec.default = coerceDefault(type, defaultValue);
    props[name] = spec;
  }
  return props;
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

function parseDefinition(wrapper: HTMLTemplateElement, index: number): LiveDefinition {
  const tag = wrapper.getAttribute("component") ?? "";
  const source = `${wrapper.ownerDocument.URL}#template[component="${tag}"][${index + 1}]`;

  // A <template>'s children live in its inert content fragment.
  const content = Array.from(wrapper.content.childNodes);
  const contentElement = (name: string): Element[] =>
    content.filter(
      (node): node is Element => node instanceof Element && node.localName === name,
    );
  const propGroups = contentElement("props");
  const styles = contentElement("style");
  if (propGroups.length > 1 || styles.length > 1) {
    fail("H7S002", "A component has an optional <props> group, one markup root, and an optional <style>.", source);
  }

  const known = new Set<Element>([...propGroups, ...styles]);
  const markup = significant(content).filter(
    (node) => !(node instanceof Element) || !known.has(node),
  );
  if (markup.length !== 1 || !(markup[0] instanceof Element)) {
    fail("H7T001", "A component's markup must be exactly one element root.", source);
  }
  const root = markup[0] as Element;

  const targets = collectTargets(root, source);
  const contract = defineContract(
    {
      status: wrapper.getAttribute("status") ?? undefined,
      summary: wrapper.getAttribute("summary") ?? undefined,
      nativeElement: root.localName,
      props: readProps(propGroups[0], targets, source),
    },
    { source, tag },
  );

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
  slotContainers: Element[] = [],
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
      slotContainers.push(element);
      element.append(...slotChildren);
    } else {
      element.append(renderElement(child, targets, slotChildren, document, [], slotContainers));
    }
  }
  return element;
}

/**
 * Performs one explicit lowering pass over the document's current HTML7 definitions
 * and invocations. It does not observe later mutations or register Custom Elements.
 */
export function lowerDocument(root: Document = document): number {
  const wrappers = Array.from(
    root.querySelectorAll("template[component]"),
  ) as HTMLTemplateElement[];
  const definitions = wrappers.map(parseDefinition);
  const tags = new Set<string>();
  for (const { definition } of definitions) {
    if (tags.has(definition.contract.tag)) {
      fail("H7R001", `More than one definition declares <${definition.contract.tag}>.`);
    }
    tags.add(definition.contract.tag);
  }

  const prepared: PreparedInvocation[] = [];
  for (const { definition } of definitions) {
    // A <template>'s content is inert, so querySelectorAll never returns definition-internal
    // markup; every match is a live invocation to lower.
    const invocations = Array.from(root.querySelectorAll(definition.contract.tag));
    for (const invocation of invocations) {
      const { targets, passThrough } = readInvocation(invocation, definition.contract);
      const children = Array.from(invocation.childNodes);
      const slotContainers: Element[] = [];
      const nativeRoot = renderElement(
        definition.template,
        targets,
        children.map((child) => child.cloneNode(true)),
        invocation.ownerDocument,
        passThrough,
        slotContainers,
      );
      prepared.push({ invocation, nativeRoot, slotContainers, children });
    }
  }

  for (const live of definitions) {
    if (live.style !== undefined) live.wrapper.ownerDocument.head.append(live.style);
    live.wrapper.remove();
  }

  for (const invocation of prepared) {
    for (const slotContainer of invocation.slotContainers) {
      slotContainer.replaceChildren(...invocation.children);
    }
    invocation.invocation.replaceWith(invocation.nativeRoot);
  }
  return prepared.length;
}
