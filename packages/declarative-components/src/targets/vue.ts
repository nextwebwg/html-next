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

function access(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `props.${name}` : `props['${name}']`;
}

function renderNode(
  node: TemplateNode,
  definition: ComponentDefinition,
  depth: number,
  reactive?: NativeReactivePlan,
): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    const attributes = node.name === undefined ? "" : ` name=${literalAttribute(node.name)}`;
    const dynamic = node.nameExpression === undefined ? "" : ` :name=${quote("''")}`;
    const fallback = node.fallback?.map((child) => renderNode(child, definition, depth + 1, reactive)).join("\n") ?? "";
    return fallback === ""
      ? `<slot${attributes}${dynamic}></slot>`
      : `<slot${attributes}${dynamic}>${fallback}</slot>`;
  }
  const indent = "  ".repeat(depth);
  const attributes = node.attributes.map((attribute) => {
    if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
    if (attribute.kind === "directive") return "";
    const value = reactive?.values.get(attribute.expression) ?? (
      definition.contract.props[attribute.expression] === undefined
        ? "undefined"
        : access(attribute.expression)
    );
    const expression = frameworkBindingExpression(
      attribute,
      definition.contract.props,
      node.name,
      value,
      "''",
    );
    return `:${attribute.name}=${quote(expression)}`;
  });
  if (reactive !== undefined) {
    attributes.push(...(node.events ?? []).map((event) => {
      const handler = reactive.handlers.find(({ name }) => name === event.handler)!;
      return `@${event.name}=${quote(handler.variable)}`;
    }));
  }
  attributes.push(...provenanceAttributes(definition.contract.tag));
  const open = `<${node.name}${attributes.filter(Boolean).length === 0 ? "" : ` ${attributes.filter(Boolean).join(" ")}`}>`;
  if (isVoidElement(node.name)) return open;
  const value = node.attributes.find((attribute) => attribute.kind === "directive" && attribute.name === "value");
  const valueChild = value?.kind === "directive" && value.expressionPlan !== undefined
    ? `{{ ${nativeExpression(value.expressionPlan.ast, reactive?.values ?? new Map())} }}`
    : "";
  const children = [
    valueChild,
    ...node.children.map((child) => renderNode(child, definition, depth + 1, reactive)),
  ].filter(Boolean).join("\n");
  return children === "" ? `${open}</${node.name}>` : `${open}\n${indent}  ${children}\n${indent}</${node.name}>`;
}

export function generateVue(definition: ComponentDefinition, version: string): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const props = target.props.map(({ name, contract }) => [name, contract] as const);
  const defaults = props.filter(([, prop]) => "default" in prop);
  const polymorphic = target.polymorphic;
  const reactive = nativeReactivePlan(
    definition,
    new Map(props.map(([name]) => [name, access(name)])),
  );
  const needsBridge = ((definition.declarations?.length ?? 0) > 0 && reactive === undefined) || definition.controller !== undefined;
  const define = [
    "defineProps<{",
    ...props.map(([name, prop]) => `  ${propKey(name)}${prop.required ? "" : "?"}: ${typeSource(prop.type)}${prop.required ? "" : " | null"};`),
    ...(polymorphic ? [`  as?: ${definition.root!.kind === "native" ? definition.root!.choices.map(quote).join(" | ") : "never"};`] : []),
    "}>()",
  ].join("\n");
  const declaration = defaults.length === 0
    ? `const props = ${define};`
    : `const props = withDefaults(${define}, {\n${defaults.map(([name, prop]) => `  ${propKey(name)}: ${JSON.stringify(prop.default)},`).join("\n")}\n});`;
  const rootAttributes = [...provenanceAttributes(contract.tag, true), ...template.attributes.map((attribute) => {
    if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
    if (attribute.kind === "directive") return "";
    const value = reactive?.values.get(attribute.expression) ?? (
      contract.props[attribute.expression] === undefined
        ? "undefined"
        : access(attribute.expression)
    );
    const expression = frameworkBindingExpression(
      attribute,
      contract.props,
      template.name,
      value,
      "''",
    );
    return `:${attribute.name}=${quote(expression)}`;
  }),
  ...(reactive === undefined ? [] : (template.events ?? []).map((event) => {
    const handler = reactive.handlers.find(({ name }) => name === event.handler)!;
    return `@${event.name}=${quote(handler.variable)}`;
  })),
  'ref="root"'].filter(Boolean);
  const rootValue = template.attributes.find(
    (attribute) => attribute.kind === "directive" && attribute.name === "value",
  );
  const children = [
    rootValue?.kind === "directive" && rootValue.expressionPlan !== undefined
      ? `{{ ${nativeExpression(rootValue.expressionPlan.ast, reactive?.values ?? new Map())} }}`
      : "",
    ...template.children.map((child) => renderNode(child, definition, 1, reactive)),
  ].filter(Boolean).join("\n");
  const emitDeclaration = target.events.length === 0 ? [] : [
    "const emit = defineEmits<{",
    ...target.events.map((event) => `  ${quote(event.name)}: [detail: ${event.detailType}];`),
    "}>();",
  ];
  const eventListeners = target.events.map((event, index) =>
    `const eventListener${index} = (event: Event) => emit(${quote(event.name)}, (event as CustomEvent<${event.detailType}>).detail);`
  );
  const expose = target.methods.length === 0 ? [] : [
    "defineExpose({",
    ...target.methods.map((method) =>
      `  ${propKey(method.name)}: (): ${method.returnType} => (root.value as unknown as Record<string, () => ${method.returnType}>)[${quote(method.name)}](),`
    ),
    "});",
  ];

  return [
    `<!-- Generated by HTML Next ${version} for Vue 3.5. Do not edit. -->`,
    '<script setup lang="ts">',
    `import { ${reactive === undefined ? "" : "computed, "}${needsBridge ? "onMounted, onUnmounted, " : ""}ref, watchEffect } from "vue";`,
    ...(needsBridge ? [
      'import { attachComponent } from "@nextwebwg/declarative-components/runtime";',
      'import type { ComponentDefinition } from "@nextwebwg/declarative-components";',
    ] : []),
    ...(definition.controller === undefined ? [] : [`import * as controller from ${quote(definition.controller)};`]),
    `import "../styles/${contract.tag}.css";`,
    "",
    "defineOptions({ inheritAttrs: false });",
    "",
    declaration,
    ...emitDeclaration,
    ...(reactive === undefined ? [] : [
      ...reactive.states.map((state) => `const ${state.variable} = ref(${state.initial});`),
      ...reactive.computed.map((value) =>
        `const ${value.variable} = computed(() => ${value.expression.replace(/\b(?:state|computed)\d+\b/g, "$&.value")});`
      ),
      ...reactive.handlers.flatMap((handler) => {
        const lines = [`const ${handler.variable} = () => {`];
        const values = new Map(reactive.values);
        for (const state of reactive.states) values.set(state.name, `${state.variable}.value`);
        for (const value of reactive.computed) values.set(value.name, `${value.variable}.value`);
        for (const step of handler.declaration.steps) {
          if (step.kind !== "set" || typeof step.writablePath[0] !== "string") continue;
          const state = reactive.states.find(({ name }) => name === step.writablePath[0])!;
          lines.push(`  ${state.variable}.value = ${nativeExpression(step.value.ast, values)};`);
        }
        lines.push("};");
        return lines;
      }),
    ]),
    ...(needsBridge
      ? [`const definition = ${serializedDefinition(definition)} as unknown as ComponentDefinition;`]
      : []),
    "const root = ref<Element>();",
    ...eventListeners,
    ...(needsBridge ? [
      "let detach: undefined | (() => void);",
      "onMounted(() => {",
      "  if (root.value == null) return;",
      "  detach = attachComponent(root.value, definition, { props,",
      ...(definition.controller === undefined ? [] : ["    controller,"]),
      "  });",
      ...target.events.map((event, index) =>
        `  root.value.addEventListener(${quote(event.name)}, eventListener${index});`
      ),
      "});",
    ] : []),
    "watchEffect(() => {",
    "  if (root.value == null) return;",
    `  for (const name of ${JSON.stringify(props.map(([name]) => name))}) (root.value as unknown as Record<string, unknown>)[name] = props[name as keyof typeof props];`,
    "});",
    ...expose,
    ...(needsBridge ? [
      "onUnmounted(() => {",
      ...target.events.map((event, index) =>
        `  root.value?.removeEventListener(${quote(event.name)}, eventListener${index});`
      ),
      "  detach?.();",
      "});",
    ] : []),
    "</script>",
    "",
    `<template>`,
    ...(isVoidElement(template.name) && !polymorphic
      ? [`  <${template.name} v-bind="$attrs"${rootAttributes.length === 0 ? "" : ` ${rootAttributes.join(" ")}`}>`]
      : [
        `  <${polymorphic ? `component :is="props.as ?? '${template.name}'"` : template.name} v-bind="$attrs"${rootAttributes.length === 0 ? "" : ` ${rootAttributes.join(" ")}`}>`,
        children === "" ? "" : `    ${children}`,
        `  </${polymorphic ? "component" : template.name}>`,
      ]),
    `</template>`,
    "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}
