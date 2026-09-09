import type { ComponentContract } from "./types.js";

export interface ComponentDefinition {
  readonly source: { readonly file: string };
  readonly contract: ComponentContract;
  readonly template: ElementNode;
  readonly css: string;
}

export type TemplateNode = ElementNode | TextNode | SlotNode;

export interface ElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly attributes: readonly TemplateAttribute[];
  readonly children: readonly TemplateNode[];
}

export interface TextNode {
  readonly kind: "text";
  readonly value: string;
}

export interface SlotNode {
  readonly kind: "slot";
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

