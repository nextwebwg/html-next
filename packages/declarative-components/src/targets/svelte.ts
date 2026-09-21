import type { ComponentDefinition, TemplateNode } from "../template.js";
import {
  escapeHtml,
  frameworkBindingExpression,
  generatedPropDescriptor,
  hasUnsupportedPropertyBindings,
  isVoidElement,
  literalAttribute,
  provenanceAttributes,
  propKey,
  propTypeSource,
  quote,
  serializedDefinition,
} from "./shared.js";
import { targetComponent } from "./backend.js";
import {
  hasNativeDispatch,
  nativeDispatch,
  nativeEventDispatch,
  nativeExpression,
  nativeReactivePlan,
  type NativeReactivePlan,
} from "./native-reactive.js";

function renderNode(
  node: TemplateNode,
  aliases: ReadonlyMap<string, string>,
  definition: ComponentDefinition,
  depth: number,
  reactive?: NativeReactivePlan,
  omitPropertyBindings = false,
): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    const fallback = node.fallback?.map((child) =>
      renderNode(child, aliases, definition, depth + 1, reactive, omitPropertyBindings)
    ).join("\n") ?? "";
    const render = node.name === undefined
      ? "{@render children?.()}"
      : `{@render slots?.[${quote(node.name)}]?.()}`;
    return fallback === "" ? render : `{#if ${node.name === undefined ? "children" : `slots?.[${quote(node.name)}]`}}${render}{:else}${fallback}{/if}`;
  }
  const indent = "  ".repeat(depth);
  const attributes = node.attributes.map((attribute) => {
    if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
    if (attribute.kind === "directive") return "";
    if (omitPropertyBindings && attribute.kind === "property") return "";
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
    ...node.children.map((child) =>
      renderNode(child, aliases, definition, depth + 1, reactive, omitPropertyBindings)
    ),
  ].filter(Boolean).join("\n");
  return children === "" ? `${open}</${node.name}>` : `${open}\n${indent}  ${children}\n${indent}</${node.name}>`;
}

export function generateSvelte(definition: ComponentDefinition, version: string): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const props = target.props.map(({ name, contract }) => [name, contract] as const);
  const aliases = new Map(target.props.map(({ name, local }) => [name, local]));
  const polymorphic = target.polymorphic;
  const generatedProps = props.map(([name, prop]) =>
    generatedPropDescriptor(name, prop, `props[${quote(name)}]`, template)
  );
  const supportsGeneratedProps = !hasUnsupportedPropertyBindings(template) &&
    generatedProps.every((prop) => prop !== undefined);
  const reactive = supportsGeneratedProps ? nativeReactivePlan(definition) : undefined;
  const dispatchesEvents = hasNativeDispatch(reactive);
  const needsBridge = !supportsGeneratedProps ||
    ((definition.declarations?.length ?? 0) > 0 && reactive === undefined) ||
    definition.controller !== undefined;
  const usesGeneratedProps = props.length > 0 && !needsBridge;
  if (reactive !== undefined) {
    for (const [name, variable] of reactive.values) aliases.set(name, variable);
  }
  const nativeElement = quote(contract.nativeElement);
  // Props are destructured raw so an omitted prop stays undefined (it is not the author's explicit
  // value); the rendered value adds the declared default.
  const destructured = props.map(([name], index) => `${quote(name)}: raw${index}`);
  const defaulted = props.map(([, prop], index) =>
    `  let prop${index} = $derived(${"default" in prop ? `raw${index} ?? ${JSON.stringify(prop.default)}` : `raw${index}`});`
  );
  const rootAttributes = [
    "{...nativeProps}",
    ...provenanceAttributes(contract.tag, true),
    ...template.attributes.map((attribute) => {
      if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
      if (attribute.kind === "directive") return "";
      if (needsBridge && attribute.kind === "property") return "";
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
    `use:htmlNext={{ ${props.map(([name], index) => `${quote(name)}: raw${index}`).join(", ")} }}`,
    "bind:this={root}",
  ].filter(Boolean);
  const rootValue = template.attributes.find(
    (attribute) => attribute.kind === "directive" && attribute.name === "value",
  );
  const children = [
    rootValue?.kind === "directive" && rootValue.expressionPlan !== undefined
      ? `{${nativeExpression(rootValue.expressionPlan.ast, aliases)}}`
      : "",
    ...template.children.map((child) =>
      renderNode(child, aliases, definition, 0, reactive, needsBridge)
    ),
  ].filter(Boolean).join("\n");

  return [
    `<!-- Generated by HTML Next ${version} for Svelte 5. Do not edit. -->`,
    '<script lang="ts">',
    '  import type { Snippet } from "svelte";',
    '  import type { SvelteHTMLElements } from "svelte/elements";',
    ...(dispatchesEvents || usesGeneratedProps
      ? [`  import { ${[
        ...(dispatchesEvents ? ["dispatchGeneratedEvent"] : []),
        ...(usesGeneratedProps ? ["manageGeneratedProps", "updateGeneratedProps"] : []),
      ].join(", ")} } from "@nextwebwg/declarative-components/generated-runtime";`]
      : []),
    ...(needsBridge ? [
      '  import { attachComponent, updateComponentProps } from "@nextwebwg/declarative-components/runtime";',
      '  import type { ComponentDefinition } from "@nextwebwg/declarative-components";',
    ] : []),
    ...(definition.controller === undefined ? [] : [`  import * as controller from ${quote(definition.controller)};`]),
    `  import "../styles/${contract.tag}.css";`,
    "",
    `  interface OwnProps {`,
    ...props.map(([name, prop]) => `    ${propKey(name)}${prop.required ? "" : "?"}: ${propTypeSource(prop)};`),
    ...target.events.map((event) =>
      `    ${event.callbackName}?: (detail: ${event.detailType}, event: CustomEvent<${event.detailType}>) => void;`
    ),
    ...(polymorphic ? [`    as?: ${definition.root!.kind === "native" ? definition.root!.choices.map(quote).join(" | ") : "never"};`] : []),
    "    slots?: Readonly<Record<string, Snippet>>;",
    "  }",
    `  type Props = Omit<SvelteHTMLElements[${nativeElement}], keyof OwnProps | "children"> & OwnProps & { children?: Snippet };`,
    "",
    `  let { ${[...destructured, ...target.events.map((event) => event.callbackName), ...(polymorphic ? ["as"] : []), "slots", "children", "...nativeProps"].join(", ")} }: Props = $props();`,
    ...defaulted,
    ...(reactive === undefined ? [] : [
      ...reactive.states.map((state) => `  let ${state.variable} = $state(${state.initial});`),
      ...reactive.computed.map((value) => `  let ${value.variable} = $derived(${value.expression});`),
      ...reactive.handlers.flatMap((handler) => {
        const lines = [`  const ${handler.variable} = () => {`];
        for (const step of handler.declaration.steps) {
          if (step.kind === "set" && typeof step.writablePath[0] === "string") {
            const state = reactive.states.find(({ name }) => name === step.writablePath[0])!;
            lines.push(`    ${state.variable} = ${nativeExpression(step.value.ast, reactive.values)};`);
          } else if (step.kind === "dispatch") {
            const dispatch = nativeDispatch(step, target.events, reactive.values)!;
            lines.push(`    ${nativeEventDispatch("root", dispatch)};`);
          }
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
    ] : usesGeneratedProps ? [
      "    const detach = manageGeneratedProps(node, [",
      ...generatedProps.map((prop) => `      ${prop},`),
      "    ]);",
    ] : []),
    ...target.events.flatMap((event, index) => [
      `    const listener${index} = (event: Event) => ${event.callbackName}?.((event as CustomEvent<${event.detailType}>).detail, event as CustomEvent<${event.detailType}>);`,
      `    node.addEventListener(${quote(event.name)}, listener${index});`,
    ]),
    "    return {",
    ...(needsBridge
      ? ["      update(next: Record<string, unknown>) { updateComponentProps(node, next); },"]
      : usesGeneratedProps
        ? ["      update(next: Record<string, unknown>) { updateGeneratedProps(node, next); },"]
        : []),
    "      destroy() {",
    ...target.events.map((event, index) =>
      `        node.removeEventListener(${quote(event.name)}, listener${index});`
    ),
    ...(needsBridge || usesGeneratedProps ? ["        detach();"] : []),
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
