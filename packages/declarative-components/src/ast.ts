/**
 * The normalized component AST is the public compiler/runtime boundary. Keeping this module as
 * the canonical type entrypoint lets source adapters and targets depend on the representation
 * without depending on a parser implementation.
 */
export type {
  AttributeBinding,
  ComponentDeclaration,
  ComponentDefinition,
  ComponentRoot,
  DataDeclaration,
  DataParameter,
  DirectiveAttribute,
  ElementNode,
  EventBinding,
  EventDeclaration,
  Flow,
  HandlerDeclaration,
  HandlerStep,
  LiteralAttribute,
  MethodDeclaration,
  PropertyBinding,
  ReactiveDeclaration,
  SlotContract,
  SlotNode,
  TemplateAttribute,
  TemplateNode,
  TextNode,
} from "./template.js";
