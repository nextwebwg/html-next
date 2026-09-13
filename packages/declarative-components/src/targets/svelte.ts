import type { ComponentDefinition, TemplateNode } from "../template.js";
import {
  escapeHtml,
  frameworkBindingExpression,
  isVoidElement,
  literalAttribute,
  provenanceAttributes,
  propKey,
  quote,
  serializedDefinition,
  typeSource,
} from "./shared.js";
import { targetComponent } from "./backend.js";
import { nativeExpression, nativeReactivePlan, type NativeReactivePlan } from "./native-reactive.js";

function renderNode(
  node: TemplateNode,
  aliases: ReadonlyMap<string, string>,
  definition: ComponentDefinition,
  depth: number,
  reactive?: NativeReactivePlan,
): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    const fallback = node.fallback?.map((child) => renderNode(child, aliases, definition, depth + 1, reactive)).join("\n") ?? "";
    const render = node.name === undefined
      ? "{@render children?.()}"
      : `{@render slots?.[${quote(node.name)}]?.()}`;
    return fallback === "" ? render : `{#if ${node.name === undefined ? "children" : `slots?.[${quote(node.name)}]`}}${render}{:else}${fallback}{/if}`;
  }
  const indent = "  ".repeat(depth);
  const attributes = node.attributes.map((attribute) => {
    if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
    if (attribute.kind === "directive") return "";
    const value = aliases.get(attribute.expression) ?? "undefined";
    const expression = frameworkBindingExpression(
      attribute,
      definition.contract.props,
      node.name,
      value,
      '""',
    );
    return `${attribute.name}={${expression}}`;
  });
  if (reactive !== undefined) {
    attributes.push(...(node.events ?? []).map((event) => {
      const handler = reactive.handlers.find(({ name }) => name === event.handler)!;
      return `on${event.name}={${handler.variable}}`;
    }));
  }
  attributes.push(...provenanceAttributes(definition.contract.tag));
  const open = `<${node.name}${attributes.filter(Boolean).length === 0 ? "" : ` ${attributes.filter(Boolean).join(" ")}`}>`;
  if (isVoidElement(node.name)) return open;
  const value = node.attributes.find((attribute) => attribute.kind === "directive" && attribute.name === "value");
  const valueChild = value?.kind === "directive" && value.expressionPlan !== undefined
    ? `{${nativeExpression(value.expressionPlan.ast, aliases)}}`
    : "";
  const children = [
    valueChild,
    ...node.children.map((child) => renderNode(child, aliases, definition, depth + 1, reactive)),
  ].filter(Boolean).join("\n");
  return children === "" ? `${open}</${node.name}>` : `${open}\n${indent}  ${children}\n${indent}</${node.name}>`;
}

export function generateSvelte(definition: ComponentDefinition, version: string): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const props = target.props.map(({ name, contract }) => [name, contract] as const);
  const aliases = new Map(target.props.map(({ name, local }) => [name, local]));
  const polymorphic = target.polymorphic;
  const reactive = nativeReactivePlan(definition);
  const needsBridge = ((definition.declarations?.length ?? 0) > 0 && reactive === undefined) || definition.controller !== undefined;
  if (reactive !== undefined) {
    for (const [name, variable] of reactive.values) aliases.set(name, variable);
  }
  const nativeElement = quote(contract.nativeElement);
  const destructured = props.map(([name, prop], index) =>
    `${quote(name)}: prop${index}${"default" in prop ? ` = ${JSON.stringify(prop.default)}` : ""}`,
  );
  const rootAttributes = [
    "{...nativeProps}",
    ...provenanceAttributes(contract.tag, true),
    ...template.attributes.map((attribute) => {
      if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
      if (attribute.kind === "directive") return "";
      const value = aliases.get(attribute.expression) ?? "undefined";
      const expression = frameworkBindingExpression(
        attribute,
        contract.props,
        template.name,
        value,
        '""',
      );
      return `${attribute.name}={${expression}}`;
    }),
    ...(reactive === undefined ? [] : (template.events ?? []).map((event) => {
      const handler = reactive.handlers.find(({ name }) => name === event.handler)!;
      return `on${event.name}={${handler.variable}}`;
    })),
    `use:htmlNext={{ ${props.map(([name], index) => `${quote(name)}: prop${index}`).join(", ")} }}`,
    "bind:this={root}",
  ].filter(Boolean);
  const rootValue = template.attributes.find(
    (attribute) => attribute.kind === "directive" && attribute.name === "value",
  );
  const children = [
    rootValue?.kind === "directive" && rootValue.expressionPlan !== undefined
      ? `{${nativeExpression(rootValue.expressionPlan.ast, aliases)}}`
      : "",
    ...template.children.map((child) => renderNode(child, aliases, definition, 0, reactive)),
  ].filter(Boolean).join("\n");

  return [
    `<!-- Generated by HTML Next ${version} for Svelte 5. Do not edit. -->`,
    '<script lang="ts">',
    '  import type { Snippet } from "svelte";',
    '  import type { SvelteHTMLElements } from "svelte/elements";',
    ...(needsBridge ? [
      '  import { attachComponent } from "@nextwebwg/declarative-components/runtime";',
      '  import type { ComponentDefinition } from "@nextwebwg/declarative-components";',
    ] : []),
    ...(definition.controller === undefined ? [] : [`  import * as controller from ${quote(definition.controller)};`]),
    `  import "../styles/${contract.tag}.css";`,
    "",
    `  interface OwnProps {`,
    ...props.map(([name, prop]) => `    ${propKey(name)}${prop.required ? "" : "?"}: ${typeSource(prop.type)}${prop.required ? "" : " | null"};`),
    ...target.events.map((event) =>
      `    ${event.callbackName}?: (detail: ${event.detailType}, event: CustomEvent<${event.detailType}>) => void;`
    ),
    ...(polymorphic ? [`    as?: ${definition.root!.kind === "native" ? definition.root!.choices.map(quote).join(" | ") : "never"};`] : []),
    "    slots?: Readonly<Record<string, Snippet>>;",
    "  }",
    `  type Props = Omit<SvelteHTMLElements[${nativeElement}], keyof OwnProps | "children"> & OwnProps & { children?: Snippet };`,
    "",
    `  let { ${[...destructured, ...target.events.map((event) => event.callbackName), ...(polymorphic ? ["as"] : []), "slots", "children", "...nativeProps"].join(", ")} }: Props = $props();`,
    ...(reactive === undefined ? [] : [
      ...reactive.states.map((state) => `  let ${state.variable} = $state(${state.initial});`),
      ...reactive.computed.map((value) => `  let ${value.variable} = $derived(${value.expression});`),
      ...reactive.handlers.flatMap((handler) => {
        const lines = [`  const ${handler.variable} = () => {`];
        for (const step of handler.declaration.steps) {
          if (step.kind !== "set" || typeof step.writablePath[0] !== "string") continue;
          const state = reactive.states.find(({ name }) => name === step.writablePath[0])!;
          lines.push(`    ${state.variable} = ${nativeExpression(step.value.ast, reactive.values)};`);
        }
        lines.push("  };");
        return lines;
      }),
    ]),
    ...(needsBridge
      ? [`  const definition = ${serializedDefinition(definition)} as unknown as ComponentDefinition;`]
      : []),
    "  let root: Element;",
    "  function htmlNext(node: Element, props: Record<string, unknown>) {",
    ...(needsBridge ? [
      "    const detach = attachComponent(node, definition, { props,",
      ...(definition.controller === undefined ? [] : ["      controller,"]),
      "    });",
    ] : ["    Object.assign(node, props);"]),
    ...target.events.flatMap((event, index) => [
      `    const listener${index} = (event: Event) => ${event.callbackName}?.((event as CustomEvent<${event.detailType}>).detail, event as CustomEvent<${event.detailType}>);`,
      `    node.addEventListener(${quote(event.name)}, listener${index});`,
    ]),
    "    return {",
    "      update(next: Record<string, unknown>) { Object.assign(node, next); },",
    "      destroy() {",
    ...target.events.map((event, index) =>
      `        node.removeEventListener(${quote(event.name)}, listener${index});`
    ),
    ...(needsBridge ? ["        detach();"] : []),
    "      },",
    "    };",
    "  }",
    ...target.methods.map((method) =>
      `  export function ${method.name}(): ${method.returnType} { return (root as unknown as Record<string, () => ${method.returnType}>)[${quote(method.name)}](); }`
    ),
    "</script>",
    "",
    ...(isVoidElement(template.name) && !polymorphic
      ? [`<${template.name} ${rootAttributes.join(" ")}>`]
      : [
        `<${polymorphic ? "svelte:element this={as ?? " + quote(template.name) + "}" : template.name} ${rootAttributes.join(" ")}>`,
        children === "" ? "" : `  ${children}`,
        `</${polymorphic ? "svelte:element" : template.name}>`,
      ]),
    "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}
