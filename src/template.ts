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

