import type { ComponentContract } from "./types.js";
import type { CompiledExpression, WritablePath } from "./expression.js";
import type { TypeNode } from "./type-system.js";

export interface ComponentDefinition {
  readonly source: { readonly file: string };
  readonly contract: ComponentContract;
  readonly template: ElementNode;
  readonly css: string;
  readonly controller?: string;
  readonly declarations?: readonly ComponentDeclaration[];
  readonly slots?: readonly SlotContract[];
  readonly root?: ComponentRoot;
}

export type ComponentRoot =
  | {
      readonly kind: "native";
      readonly element: string;
      readonly choices: readonly string[];
    }
  | {
      readonly kind: "component";
      readonly tag: string;
    };

export type ComponentDeclaration =
  | ReactiveDeclaration
  | ContextDeclaration
  | EventDeclaration
  | HandlerDeclaration
  | DataDeclaration;

export interface ReactiveDeclaration {
  readonly kind: "state" | "computed";
  readonly name: string;
  /** A state's declared type, in the type-expression syntax props use. */
  readonly type?: string;
  /** Parsed nested fields and their values constraints, when authored. */
  readonly shape?: TypeNode;
  readonly value?: string;
  readonly expression?: CompiledExpression;
}

export interface ContextDeclaration {
  readonly kind: "context";
  /** The published state cell's name on the provider. */
  readonly name: string;
  readonly from: string;
  /** The name introduced into this component's expression scope. */
  readonly as?: string;
}

export interface DataDeclaration {
  readonly kind: "data";
  readonly name: string;
  readonly source?: string;
  readonly type?: string;
  readonly debounce?: string;
  readonly poll?: string;
  readonly parameters: readonly DataParameter[];
}

export interface DataParameter {
  readonly name: string;
  /** Live dependencies trigger the resource; sampled expressions do not. */
  readonly mode: "from" | "expr";
  readonly expression: CompiledExpression;
}

export interface EventDeclaration {
  readonly kind: "event";
  readonly name: string;
  readonly type: string;
  /** Parsed nested fields and their values constraints, when authored. */
  readonly shape?: TypeNode;
  readonly bubbles: boolean;
  readonly composed: boolean;
  readonly cancelable: boolean;
}

export interface HandlerDeclaration {
  readonly kind: "handler";
  readonly name: string;
  readonly steps: readonly HandlerStep[];
}

export type HandlerStep =
  | {
      readonly kind: "set";
      readonly path: string;
      readonly writablePath: WritablePath;
      readonly value: CompiledExpression;
      readonly guard?: CompiledExpression;
    }
  | {
      readonly kind: "dispatch";
      /** Component-local $ref; collection refs receive one event per rendered element. */
      readonly target?: string;
      readonly event: string;
      readonly value?: CompiledExpression;
      readonly guard?: CompiledExpression;
    }
  | {
      readonly kind: "validate" | "focus";
      readonly target: string;
      readonly guard?: CompiledExpression;
    };

export interface SlotContract {
  readonly name?: string;
  readonly dynamic: boolean;
  readonly required: boolean;
  readonly props?: readonly string[];
}

export type TemplateNode = ElementNode | TextNode | SlotNode;

/** Whether lowering this definition can expose another component invocation. */
export function definitionMayInvokeComponents(definition: ComponentDefinition): boolean {
  if (definition.root?.kind === "component") return true;
  const visit = (node: TemplateNode): boolean => {
    if (node.kind === "text") return false;
    if (node.kind === "slot") return (node.fallback ?? []).some(visit);
    return node.name.includes("-") || node.children.some(visit);
  };
  return visit(definition.template);
}

export interface ElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly attributes: readonly TemplateAttribute[];
  readonly children: readonly TemplateNode[];
  /** A structural `$`-directive controlling whether/how-many-times/in-what-scope this node is produced. */
  readonly flow?: Flow;
  readonly events?: readonly EventBinding[];
  readonly ref?: string;
}

export interface EventBinding {
  readonly name: string;
  readonly handler: string;
  readonly modifiers: readonly string[];
}

export interface SortKey {
  readonly path: readonly string[];
  readonly descending: boolean;
}

export type Flow =
  | { readonly kind: "if"; readonly test: string; readonly testPlan?: CompiledExpression }
  | {
      readonly kind: "each";
      readonly item: string;
      readonly index?: string;
      readonly list: string;
      readonly listPlan?: CompiledExpression;
      readonly where?: string;
      readonly wherePlan?: CompiledExpression;
      readonly sort?: string;
      /** `$sort` parsed: each key's path below the loop item (empty for the item itself) and direction. */
      readonly sortKeys?: readonly SortKey[];
      readonly limit?: string;
      readonly limitPlan?: CompiledExpression;
      readonly key?: string;
      readonly keyPlan?: CompiledExpression;
    }
  | {
      readonly kind: "with";
      readonly expr: string;
      readonly expressionPlan?: CompiledExpression;
      readonly alias: string;
    }
  | {
      readonly kind: "match";
      readonly expr?: string;
      readonly expressionPlan?: CompiledExpression;
      readonly alias?: string;
    }
  | { readonly kind: "when"; readonly test: string; readonly testPlan?: CompiledExpression }
  | { readonly kind: "else" };

export interface TextNode {
  readonly kind: "text";
  readonly value: string;
  /** A braced inline expression; omitted for literal text. Uses the same value semantics as `$value`. */
  readonly expressionPlan?: CompiledExpression;
  /** Mixed text stays one authored text node, preserving native shaping and hydration identity. */
  readonly segments?: readonly TextNode[];
}

export interface SlotNode {
  readonly kind: "slot";
  readonly name?: string;
  readonly nameExpression?: CompiledExpression;
  readonly flow?: Extract<Flow, { kind: "each" }>;
  readonly props?: readonly {
    readonly name: string;
    readonly expression: string;
    readonly expressionPlan: CompiledExpression;
  }[];
  readonly fallback?: readonly TemplateNode[];
}

export type TemplateAttribute =
  | LiteralAttribute
  | AttributeBinding
  | PropertyBinding
  | DirectiveAttribute;

/** A `$`-directive that sets an element's content: `$value` (escaped text) or `$html` (sanitized). */
export interface DirectiveAttribute {
  readonly kind: "directive";
  readonly name: "value" | "html";
  readonly expression: string;
  readonly expressionPlan?: CompiledExpression;
}

export interface LiteralAttribute {
  readonly kind: "literal";
  readonly name: string;
  readonly value: string;
}

export interface AttributeBinding {
  readonly kind: "attribute";
  readonly name: string;
  readonly expression: string;
  readonly expressionPlan?: CompiledExpression;
  readonly twoWay?: boolean;
  readonly writablePath?: WritablePath;
  readonly target?: "class" | "style";
}

export interface PropertyBinding {
  readonly kind: "property";
  readonly key: string;
  readonly name: string;
  readonly expression: string;
  readonly expressionPlan?: CompiledExpression;
}

/** A polymorphic root's arms: the native roots a root `<template $match>` chooses between. */
export function rootArms(template: ElementNode): readonly ElementNode[] | undefined {
  return template.name === "template" && template.flow?.kind === "match"
    ? template.children as readonly ElementNode[]
    : undefined;
}

/** A real `$match` element is the stable wrapper; only its chosen child is structural. */
export function elementMatchRoot(node: ElementNode): ElementNode {
  if (node.name === "template" || node.flow?.kind !== "match") return node;
  const { flow, children, ...wrapper } = node;
  return {
    ...wrapper,
    children: [{ kind: "element", name: "template", attributes: [], children, flow }],
  };
}

/**
 * The ref names a definition places inside an iteration. Multiplicity is a property of where the
 * directive sits, not of how much data arrives: a name under `$each` is the list that iteration
 * produced even when it produced one row or none, so a controller never branches on shape.
 */
const iteratedRefs = new WeakMap<ComponentDefinition, ReadonlySet<string>>();

export function iteratedRefNames(definition: ComponentDefinition): ReadonlySet<string> {
  const cached = iteratedRefs.get(definition);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const walk = (node: TemplateNode, iterating: boolean): void => {
    if (node.kind === "slot") {
      for (const child of node.fallback ?? []) walk(child, iterating);
      return;
    }
    if (node.kind !== "element") return;
    const inside = iterating || node.flow?.kind === "each";
    if (node.ref !== undefined && inside) names.add(node.ref);
    for (const child of node.children) walk(child, inside);
  };
  walk(definition.template, false);
  iteratedRefs.set(definition, names);
  return names;
}
