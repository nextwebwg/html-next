import type { ComponentContract } from "./types.js";
import type { CompiledExpression } from "./expression.js";

export interface ComponentDefinition {
  readonly source: { readonly file: string };
  readonly contract: ComponentContract;
  readonly template: ElementNode;
  readonly css: string;
  readonly controller?: string;
  readonly declarations?: readonly ComponentDeclaration[];
  readonly slots?: readonly SlotContract[];
}

export type ComponentDeclaration =
  | ReactiveDeclaration
  | EventDeclaration
  | MethodDeclaration
  | HandlerDeclaration
  | DataDeclaration;

export interface ReactiveDeclaration {
  readonly kind: "state" | "computed";
  readonly name: string;
  readonly expression?: CompiledExpression;
}

export interface DataDeclaration {
  readonly kind: "data";
  readonly name: string;
  readonly source?: string;
}

export interface EventDeclaration {
  readonly kind: "event";
  readonly name: string;
  readonly type: string;
  readonly bubbles: boolean;
  readonly composed: boolean;
  readonly cancelable: boolean;
}

export interface MethodDeclaration {
  readonly kind: "method";
  readonly name: string;
  readonly exportName: string;
  readonly returns: string;
}

export interface HandlerDeclaration {
  readonly kind: "handler";
  readonly name: string;
  readonly source: string;
}

export interface SlotContract {
  readonly name?: string;
  readonly dynamic: boolean;
  readonly required: boolean;
}

export type TemplateNode = ElementNode | TextNode | SlotNode;

export interface ElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly attributes: readonly TemplateAttribute[];
  readonly children: readonly TemplateNode[];
  /** A structural `$`-directive controlling whether/how-many-times/in-what-scope this node is produced. */
  readonly flow?: Flow;
}

export type Flow =
  | { readonly kind: "if"; readonly test: string }
  | {
      readonly kind: "each";
      readonly item: string;
      readonly index?: string;
      readonly list: string;
      readonly where?: string;
      readonly sort?: string;
      readonly limit?: string;
      readonly key?: string;
    }
  | { readonly kind: "with"; readonly expr: string; readonly alias: string }
  | { readonly kind: "match"; readonly expr?: string; readonly alias?: string }
  | { readonly kind: "when"; readonly test: string }
  | { readonly kind: "else" };

export interface TextNode {
  readonly kind: "text";
  readonly value: string;
}

export interface SlotNode {
  readonly kind: "slot";
  readonly name?: string;
  readonly nameExpression?: CompiledExpression;
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
}

export interface PropertyBinding {
  readonly kind: "property";
  readonly key: string;
  readonly name: string;
  readonly expression: string;
}
