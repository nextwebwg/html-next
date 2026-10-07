/**
 * The reference every compiled module is held to: the live runtime rendering the same definition.
 * A single component attaches to a fresh root through the factory-attachment API, with the factory's
 * props, attributes and projection; a graph (or a root delegated to another component) is lowered
 * from its invocation, as a live document lowers it. Exports `createReference` and `update`.
 */
import type { ComponentDefinition } from "../src/template.js";
import { serializedDefinition } from "../src/targets/shared.js";

export function liveReference(definition: ComponentDefinition, others: readonly ComponentDefinition[] = []): string {
  const controlled = definition.controller !== undefined;
  const named = definition;
  const root = definition.template.name;
  return [
    'import { componentRootIndex, getComponentHost, manageComponentLifecycle, observeDocument, registerComponentDefinitions } from "@nextwebwg/html-next/runtime";',
    'export { updateComponentProps as update } from "@nextwebwg/html-next/runtime";',
    ...controlled ? [`import * as controller from ${JSON.stringify(named.controller)};`] : [],
    ...others.flatMap((other, index) => other.controller === undefined ? [] : [`import * as controller${index} from ${JSON.stringify(other.controller)};`]),
    // Registered as a live document registers it, with its styles and their `:host-state()` names.
    `const definition = { ...${serializedDefinition(named)}, css: ${JSON.stringify(definition.css)} };`,
    `registerComponentDefinitions([definition${others.map((other) => `, { ...${serializedDefinition(other)}, css: ${JSON.stringify(other.css)} }`).join("")}]);`,
    // A live document is observed, so an invocation a region renders later lowers too. A root lowered
    // from its invocation gets its controller as the browser loader gives one: once per host, on connect.
    ...others.length > 0 ? [controlled || others.some((other) => other.controller !== undefined) ? [
      `const controllers = { ${[...controlled ? [`${JSON.stringify(definition.contract.tag)}: controller`] : [],
        ...others.flatMap((other, index) => other.controller === undefined ? [] : [`${JSON.stringify(other.contract.tag)}: controller${index}`])].join(", ")} };`,
      "const initialized = new WeakSet();",
      "observeDocument(document, { onConnect(element, connected) {",
      "  const controller = controllers[connected.contract.tag];",
      "  if (controller === undefined) return;",
      "  const host = getComponentHost(element);",
      "  if (initialized.has(host)) return;",
      "  initialized.add(host);",
      "  let cleanup; let disconnected = false;",
      "  void Promise.resolve(controller.default(host)).then((result) => { if (typeof result !== \"function\") return; if (disconnected) result(); else cleanup = result; });",
      "  return () => { disconnected = true; cleanup?.(); };",
      "} });",
    ].join("\n") : "observeDocument(document);"] : [],
    "export function createReference(options = {}) {",
    "  const { attributes = {}, children = [], slots = {}, ...props } = options;",
    // A graph (and a root delegated to another component) is lowered from its invocation, as a live
    // document lowers it.
    ...others.length > 0 ? [
      `  const invocation = document.createElement(${JSON.stringify(definition.contract.tag)});`,
      "  for (const [name, value] of Object.entries(attributes)) invocation.setAttribute(name, String(value));",
      "  for (const [name, value] of Object.entries(props)) if (value !== undefined && value !== null && value !== false) invocation.setAttribute(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value === true ? \"\" : typeof value === \"string\" ? value : JSON.stringify(value));",
      "  for (const child of children) invocation.append(child);",
      "  for (const [name, nodes] of Object.entries(slots)) for (const child of nodes) { if (typeof child !== \"string\") child.setAttribute(\"slot\", name); invocation.append(child); }",
      "  return invocation;",
      "}",
    ] : [

    // A root `$match` starts on the arm the props choose, as the general runtime's factories chose it.
    root === "template" ? "  const arm = definition.template.children[componentRootIndex(definition, props)], element = document.createElement(arm.name);"
      : root === "svg" ? '  const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");' : `  const element = document.createElement(${JSON.stringify(root)});`,
    "  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));",
    // Then the root's literals, as generated factories merge them: class and style combine, else the factory's win.
    `  const node = ${root === "template" ? "arm" : "definition.template"};`,
    "  for (const attribute of node.attributes) {",
    "    if (attribute.kind !== \"literal\") continue;",
    "    if (attribute.name === \"class\" || attribute.name === \"style\") element.setAttribute(attribute.name, [attribute.value, element.getAttribute(attribute.name)].filter(Boolean).join(attribute.name === \"class\" ? \" \" : \"; \"));",
    "    else if (!element.hasAttribute(attribute.name)) element.setAttribute(attribute.name, attribute.value);",
    "  }",
    `  element.setAttribute("data-component", ${JSON.stringify(definition.contract.tag)});`,
    // A factory's children and named slots, as the general runtime's factories projected them.
    "  const projected = [];",
    "  for (const [name, nodes] of [[\"\", children], ...Object.entries(slots)]) for (const child of nodes) projected.push([typeof child === \"string\" ? document.createTextNode(child) : child, name]);",
    `  manageComponentLifecycle(element, definition, { props, projected${controlled ? ", controller" : ""} });`,
    "  return element;",
    "}",
    ],
  ].join("\n");
}

