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
import { kebabCase } from "../names.js";
import { targetComponent } from "./backend.js";
import {
  hasNativeDispatch,
  nativeDispatch,
  nativeEventDispatch,
  nativeExpression,
  nativeReactivePlan,
  type NativeReactivePlan,
} from "./native-reactive.js";

/** Template names for expression roots: the reactive plan's, or each prop's template access. */
function templateValues(definition: ComponentDefinition, reactive: NativeReactivePlan | undefined): ReadonlyMap<string, string> {
  return reactive?.values ?? new Map(Object.keys(definition.contract.props).map((name) => [name, access(name)]));
}

function access(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `props.${name}` : `props['${name}']`;
}

function renderNode(
  node: TemplateNode,
  definition: ComponentDefinition,
  depth: number,
  reactive?: NativeReactivePlan,
  omitPropertyBindings = false,
): string {
  if (node.kind === "text") return escapeHtml(node.value);
  if (node.kind === "slot") {
    const attributes = node.name === undefined ? "" : ` name=${literalAttribute(node.name)}`;
    const dynamic = node.nameExpression === undefined ? "" : ` :name=${quote("''")}`;
    const fallback = node.fallback?.map((child) =>
      renderNode(child, definition, depth + 1, reactive, omitPropertyBindings)
    ).join("\n") ?? "";
    return fallback === ""
      ? `<slot${attributes}${dynamic}></slot>`
      : `<slot${attributes}${dynamic}>${fallback}</slot>`;
  }
  const indent = "  ".repeat(depth);
  const attributes = node.attributes.map((attribute) => {
    if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
    if (attribute.kind === "directive") return "";
    if (omitPropertyBindings && attribute.kind === "property") return "";
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
    ? `{{ ${nativeExpression(value.expressionPlan.ast, templateValues(definition, reactive))} }}`
    : "";
  // `<template $value>` produces its text with no wrapper element, as in the live runtime.
  if (node.name === "template" && valueChild !== "") return valueChild;
  const children = [
    valueChild,
    ...node.children.map((child) =>
      renderNode(child, definition, depth + 1, reactive, omitPropertyBindings)
    ),
  ].filter(Boolean).join("\n");
  return children === "" ? `${open}</${node.name}>` : `${open}\n${indent}  ${children}\n${indent}</${node.name}>`;
}

export function generateVue(definition: ComponentDefinition, version: string): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const props = target.props.map(({ name, contract }) => [name, contract] as const);
  const defaults = props.filter(([, prop]) => "default" in prop);
  const polymorphic = target.polymorphic;
  const generatedProps = props.map(([name, prop]) =>
    generatedPropDescriptor(name, prop, `explicit[${quote(name)}]`, template)
  );
  const supportsGeneratedProps = !hasUnsupportedPropertyBindings(template) &&
    generatedProps.every((prop) => prop !== undefined);
  const reactive = supportsGeneratedProps
    ? nativeReactivePlan(definition, new Map(props.map(([name]) => [name, access(name)])))
    : undefined;
  const dispatchesEvents = hasNativeDispatch(reactive);
  const needsBridge = !supportsGeneratedProps ||
    ((definition.declarations?.length ?? 0) > 0 && reactive === undefined) ||
    definition.controller !== undefined;
  const usesGeneratedProps = props.length > 0 && !needsBridge;
  const needsLifecycle = needsBridge || usesGeneratedProps || target.events.length > 0;
  const define = [
    "defineProps<{",
    ...props.map(([name, prop]) => `  ${propKey(name)}${prop.required ? "" : "?"}: ${propTypeSource(prop)};`),
    ...(polymorphic ? [`  as?: ${definition.root!.kind === "native" ? definition.root!.choices.map(quote).join(" | ") : "never"};`] : []),
    "}>()",
  ].join("\n");
  const declaration = defaults.length === 0
    ? `const props = ${define};`
    : `const props = withDefaults(${define}, {\n${defaults.map(([name, prop]) => `  ${propKey(name)}: ${JSON.stringify(prop.default)},`).join("\n")}\n});`;
  const rootAttributes = [...provenanceAttributes(contract.tag, true), ...template.attributes.map((attribute) => {
    if (attribute.kind === "literal") return `${attribute.name}=${literalAttribute(attribute.value)}`;
    if (attribute.kind === "directive") return "";
    if (needsBridge && attribute.kind === "property") return "";
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
      ? `{{ ${nativeExpression(rootValue.expressionPlan.ast, templateValues(definition, reactive))} }}`
      : "",
    ...template.children.map((child) => renderNode(child, definition, 1, reactive, needsBridge)),
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
    `import { ${reactive === undefined ? "" : "computed, "}getCurrentInstance, ${needsLifecycle ? "onMounted, onUnmounted, " : ""}ref, watchEffect } from "vue";`,
    ...(dispatchesEvents || usesGeneratedProps
      ? [`import { ${[
        ...(dispatchesEvents ? ["dispatchGeneratedEvent"] : []),
        ...(usesGeneratedProps ? ["manageGeneratedProps", "updateGeneratedProps"] : []),
      ].join(", ")} } from "@nextwebwg/declarative-components/generated-runtime";`]
      : []),
    ...(needsBridge ? [
      'import { attachComponent, updateComponentProps } from "@nextwebwg/declarative-components/runtime";',
      'import type { ComponentDefinition } from "@nextwebwg/declarative-components";',
    ] : []),
    ...(definition.controller === undefined ? [] : [`import * as controller from ${quote(definition.controller)};`]),
    `import "../styles/${contract.tag}.css";`,
    "",
    "defineOptions({ inheritAttrs: false });",
    "",
    declaration,
    ...emitDeclaration,
    // Vue fills in declared defaults, so read which props the parent actually passed: only those are
    // the author's explicit props. Each value is read unconditionally to keep it a tracked dependency.
    "const instance = getCurrentInstance();",
    "const passed = (name: string, attribute: string): boolean => {",
    "  const raw = instance?.vnode.props ?? {};",
    "  return Object.hasOwn(raw, name) || Object.hasOwn(raw, attribute);",
    "};",
    "const explicitProps = (): Record<string, unknown> => {",
    ...props.map(([name]) => `  const value${propKey(name).replace(/[^A-Za-z0-9_]/g, "_")} = ${access(name)};`),
    `  return { ${props.map(([name]) => `${quote(name)}: passed(${quote(name)}, ${quote(kebabCase(name))}) ? value${propKey(name).replace(/[^A-Za-z0-9_]/g, "_")} : undefined`).join(", ")} };`,
    "};",
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
          if (step.kind === "set" && typeof step.writablePath[0] === "string") {
            const state = reactive.states.find(({ name }) => name === step.writablePath[0])!;
            lines.push(`  ${state.variable}.value = ${nativeExpression(step.value.ast, values)};`);
          } else if (step.kind === "dispatch") {
            const dispatch = nativeDispatch(step, target.events, values)!;
            lines.push(`  ${nativeEventDispatch("root.value", dispatch)};`);
          }
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
    ...(needsLifecycle ? [
      ...(needsBridge || usesGeneratedProps ? ["let detach: undefined | (() => void);"] : []),
      "onMounted(() => {",
      "  if (root.value == null) return;",
      ...(needsBridge ? [
        "  detach = attachComponent(root.value, definition, { props: explicitProps(),",
        ...(definition.controller === undefined ? [] : ["    controller,"]),
        "  });",
      ] : []),
      ...(usesGeneratedProps ? [
        "  const explicit = explicitProps();",
        "  detach = manageGeneratedProps(root.value, [",
        ...generatedProps.map((prop) => `    ${prop},`),
        "  ]);",
      ] : []),
      ...target.events.map((event, index) =>
        `  root.value.addEventListener(${quote(event.name)}, eventListener${index});`
      ),
      "});",
    ] : []),
    ...(needsBridge || usesGeneratedProps ? [
      "watchEffect(() => {",
      "  const next = explicitProps();",
      "  if (root.value == null) return;",
      `  ${needsBridge ? "updateComponentProps" : "updateGeneratedProps"}(root.value, next);`,
      "});",
    ] : []),
    ...expose,
    ...(needsLifecycle ? [
      "onUnmounted(() => {",
      ...target.events.map((event, index) =>
        `  root.value?.removeEventListener(${quote(event.name)}, eventListener${index});`
      ),
      ...(needsBridge || usesGeneratedProps ? ["  detach?.();"] : []),
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
