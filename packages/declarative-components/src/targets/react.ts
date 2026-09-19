import type { ComponentDefinition, TemplateNode } from "../template.js";
import type { PropContract } from "../types.js";
import { targetComponent } from "./backend.js";
import {
  hasNativeDispatch,
  nativeDispatch,
  nativeEventDispatch,
  nativeExpression,
  nativeReactivePlan,
  type NativeReactivePlan,
} from "./native-reactive.js";
import {
  frameworkBindingExpression,
  generatedPropDescriptor,
  hasUnsupportedPropertyBindings,
  isVoidElement,
  provenanceAttributes,
  propKey,
  quote,
  serializedDefinition,
  typeSource,
} from "./shared.js";

function htmlAttributeName(name: string): string {
  if (name === "class") return "className";
  if (name === "for") return "htmlFor";
  return name;
}

function textExpression(value: string): string {
  return `{${quote(value)}}`;
}

function reactEventName(name: string): string {
  return `on${name.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("")}`;
}

function renderNode(
  node: TemplateNode,
  aliases: ReadonlyMap<string, string>,
  props: Readonly<Record<string, PropContract>>,
  owner: string,
  depth: number,
  reactive?: NativeReactivePlan,
  omitPropertyBindings = false,
): string {
  if (node.kind === "text") return textExpression(node.value);
  if (node.kind === "slot") {
    const fallbackNodes = node.fallback?.map(
      (child) => renderNode(child, aliases, props, owner, depth, reactive, omitPropertyBindings),
    ).join("\n") ?? "";
    const fallback = fallbackNodes === "" ? "null" : `<>${fallbackNodes}</>`;
    if (node.name !== undefined) return `{slots?.[${quote(node.name)}] ?? (${fallback})}`;
    if (node.nameExpression !== undefined) return `{(${fallback})}`;
    return `{children ?? (${fallback})}`;
  }
  const indent = "  ".repeat(depth);
  const attributes = node.attributes.map((attribute) => {
    if (attribute.kind === "literal") {
      return `${htmlAttributeName(attribute.name)}=${quote(attribute.value)}`;
    }
    if (attribute.kind === "directive") return "";
    if (omitPropertyBindings && attribute.kind === "property") return "";
    const value = aliases.get(attribute.expression) ?? "undefined";
    const expression = frameworkBindingExpression(
      attribute,
      props,
      node.name,
      value,
      '""',
    );
    return `${htmlAttributeName(attribute.name)}={${expression}}`;
  });
  if (reactive !== undefined) {
    attributes.push(...(node.events ?? []).map((event) => {
      const handler = reactive.handlers.find(({ name }) => name === event.handler)!;
      return `${reactEventName(event.name)}={${handler.variable}}`;
    }));
  }
  attributes.push(...provenanceAttributes(owner));
  const open = `<${node.name}${attributes.filter(Boolean).length === 0 ? "" : ` ${attributes.filter(Boolean).join(" ")}`}>`;
  if (isVoidElement(node.name)) return open.slice(0, -1) + " />";
  const value = node.attributes.find((attribute) => attribute.kind === "directive" && attribute.name === "value");
  const valueChild = value?.kind === "directive" && value.expressionPlan !== undefined
    ? `{${nativeExpression(value.expressionPlan.ast, aliases)}}`
    : "";
  if (node.children.length === 0 && valueChild === "") return `${open}</${node.name}>`;
  const children = [
    valueChild,
    ...node.children.map((child) =>
      renderNode(child, aliases, props, owner, depth + 1, reactive, omitPropertyBindings)
    ),
  ].filter(Boolean).join("\n");
  return `${open}\n${indent}  ${children}\n${indent}</${node.name}>`;
}

export function generateReact(definition: ComponentDefinition, version: string): string {
  const { contract, template } = definition;
  const target = targetComponent(definition);
  const props = target.props.map(({ name, contract }) => [name, contract] as const);
  const aliases = new Map(target.props.map(({ name, local }) => [name, local]));
  const nativeElement = quote(contract.nativeElement);
  const destructured = props.map(([name, prop], index) => {
    const defaultValue = "default" in prop ? ` = ${JSON.stringify(prop.default)}` : "";
    return `${quote(name)}: prop${index}${defaultValue}`;
  });
  const polymorphic = target.polymorphic;
  const generatedProps = props.map(([name, prop], index) =>
    generatedPropDescriptor(name, prop, `prop${index}`)
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
  const controllerImport = definition.controller === undefined
    ? []
    : [`import * as controller from ${quote(definition.controller)};`];
  const rootAttributes = [
    "{...nativeProps}",
    ...provenanceAttributes(contract.tag, true),
    ...template.attributes.map((attribute) => {
      if (attribute.kind === "literal") return `${htmlAttributeName(attribute.name)}=${quote(attribute.value)}`;
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
      return `${htmlAttributeName(attribute.name)}={${expression}}`;
    }),
    ...(reactive === undefined ? [] : (template.events ?? []).map((event) => {
      const handler = reactive.handlers.find(({ name }) => name === event.handler)!;
      return `${reactEventName(event.name)}={${handler.variable}}`;
    })),
    "ref={setRoot}",
  ].filter(Boolean).join(" ");
  const rootValue = template.attributes.find(
    (attribute) => attribute.kind === "directive" && attribute.name === "value",
  );
  const children = [
    rootValue?.kind === "directive" && rootValue.expressionPlan !== undefined
      ? `{${nativeExpression(rootValue.expressionPlan.ast, aliases)}}`
      : "",
    ...template.children.map((child) =>
      renderNode(child, aliases, contract.props, contract.tag, 2, reactive, needsBridge)
    ),
  ].filter(Boolean).join("\n");
  const handleName = `${contract.name}Handle`;
  const eventEffects = target.events.flatMap((event, index) => [
    "  useLayoutEffect(() => {",
    "    const node = root.current;",
    `    if (node == null || ${event.callbackName} == null) return;`,
    `    const listener${index} = (event: Event) => ${event.callbackName}((event as CustomEvent<${event.detailType}>).detail, event as CustomEvent<${event.detailType}>);`,
    `    node.addEventListener(${quote(event.name)}, listener${index});`,
    `    return () => node.removeEventListener(${quote(event.name)}, listener${index});`,
    `  }, [${event.callbackName}]);`,
  ]);

  return [
    `// Generated by HTML Next ${version} for React 19. Do not edit.`,
    `import { useLayoutEffect, useRef${reactive === undefined ? "" : ", useState"} } from "react";`,
    'import type { ComponentPropsWithoutRef, ComponentRef, ElementType, ReactNode, Ref } from "react";',
    ...(dispatchesEvents || usesGeneratedProps
      ? [`import { ${[
        ...(dispatchesEvents ? ["dispatchGeneratedEvent"] : []),
        ...(usesGeneratedProps ? ["manageGeneratedProps"] : []),
      ].join(", ")} } from "@nextwebwg/declarative-components/generated-runtime";`]
      : []),
    ...(needsBridge ? [
      'import { attachComponent } from "@nextwebwg/declarative-components/runtime";',
      'import type { ComponentDefinition } from "@nextwebwg/declarative-components";',
    ] : []),
    ...controllerImport,
    `import "../styles/${contract.tag}.css";`,
    "",
    ...(needsBridge
      ? [`const definition = ${serializedDefinition(definition)} as unknown as ComponentDefinition;`, ""]
      : []),
    `interface ${contract.name}OwnProps {`,
    ...props.map(([name, prop]) =>
      `  ${propKey(name)}${prop.required ? "" : "?"}: ${typeSource(prop.type)}${prop.required ? "" : " | null"};`,
    ),
    ...target.events.map((event) =>
      `  ${event.callbackName}?: (detail: ${event.detailType}, event: CustomEvent<${event.detailType}>) => void;`
    ),
    ...(polymorphic ? [`  as?: ${definition.root!.kind === "native" ? definition.root!.choices.map(quote).join(" | ") : "never"};`] : []),
    "  slots?: Readonly<Record<string, ReactNode>>;",
    "}",
    "",
    `export type ${handleName} = ComponentRef<${nativeElement}> & {`,
    ...target.methods.map((method) => `  ${propKey(method.name)}(): ${method.returnType};`),
    "};",
    "",
    `export type ${contract.name}Props = Omit<ComponentPropsWithoutRef<${nativeElement}>, keyof ${contract.name}OwnProps | "children"> &`,
    `  ${contract.name}OwnProps & { children?: ReactNode; ref?: Ref<${handleName}> };`,
    "",
    `export function ${contract.name}(props: ${contract.name}Props) {`,
    `  const { ${[...destructured, ...target.events.map((event) => event.callbackName), ...(polymorphic ? ["as"] : []), "slots", "children", "ref", "...nativeProps"].join(", ")} } = props;`,
    `  const root = useRef<${handleName} | null>(null);`,
    `  const setRoot = (node: ${handleName} | null) => {`,
    `    (root as { current: ${handleName} | null }).current = node;`,
    "    if (typeof ref === \"function\") ref(node);",
    "    else if (ref != null) ref.current = node;",
    "  };",
    `  const componentProps: Record<string, unknown> = { ${props.map(([name], index) => `${quote(name)}: prop${index}`).join(", ")} };`,
    ...(reactive === undefined ? [] : [
      ...reactive.states.map((state) =>
        `  const [${state.variable}, ${state.setter}] = useState(${state.initial});\n  const current${state.variable} = useRef(${state.variable});`
      ),
      ...reactive.computed.map((computed) => `  const ${computed.variable} = ${computed.expression};`),
      ...reactive.handlers.flatMap((handler) => {
        const lines = [`  const ${handler.variable} = () => {`];
        const values = new Map(reactive.values);
        const touched = new Map<string, (typeof reactive.states)[number]>();
        for (const step of handler.declaration.steps) {
          if (step.kind !== "set" || typeof step.writablePath[0] !== "string") continue;
          const state = reactive.states.find(({ name }) => name === step.writablePath[0])!;
          if (touched.has(state.name)) continue;
          touched.set(state.name, state);
          values.set(state.name, `next${state.variable}`);
          lines.push(`    let next${state.variable} = current${state.variable}.current;`);
        }
        for (const step of handler.declaration.steps) {
          if (step.kind === "set" && typeof step.writablePath[0] === "string") {
            const state = reactive.states.find(({ name }) => name === step.writablePath[0])!;
            lines.push(`    next${state.variable} = ${nativeExpression(step.value.ast, values)};`);
            lines.push(`    current${state.variable}.current = next${state.variable};`);
            for (const computed of reactive.computed) {
              values.set(computed.name, nativeExpression(computed.ast, values)!);
            }
          } else if (step.kind === "dispatch") {
            const dispatch = nativeDispatch(step, target.events, values)!;
            lines.push(`    ${nativeEventDispatch("root.current", dispatch)};`);
          }
        }
        for (const state of touched.values()) {
          lines.push(`    ${state.setter}(next${state.variable});`);
        }
        lines.push("  };");
        return lines;
      }),
    ]),
    ...(needsBridge ? [
      "  useLayoutEffect(() => root.current == null ? undefined : attachComponent(root.current, definition, {",
      "    props: componentProps,",
      ...(definition.controller === undefined ? [] : ["    controller,"]),
      "  }), []);",
    ] : []),
    ...(usesGeneratedProps ? [
      "  useLayoutEffect(() => root.current == null ? undefined : manageGeneratedProps(root.current, [",
      ...generatedProps.map((prop) => `    ${prop},`),
      "  ]), []);",
    ] : []),
    "  useLayoutEffect(() => { if (root.current != null) Object.assign(root.current, componentProps); });",
    ...eventEffects,
    ...(polymorphic ? [`  const Root = (as ?? ${quote(template.name)}) as ElementType;`] : []),
    "  return (",
    ...(isVoidElement(template.name) && !polymorphic
      ? [`    <${template.name} ${rootAttributes} />`]
      : [
        `    <${polymorphic ? "Root" : template.name} ${rootAttributes}>`,
        children === "" ? "" : `      ${children}`,
        `    </${polymorphic ? "Root" : template.name}>`,
      ]),
    "  );",
    "}",
    "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}
