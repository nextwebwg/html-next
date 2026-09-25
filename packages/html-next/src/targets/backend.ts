import type {
  ComponentDefinition,
  EventDeclaration,
  MethodDeclaration,
  SlotContract,
} from "../template.js";
import type { PropContract } from "../types.js";
import { parseTypeExpression, typeScriptType } from "../type-system.js";

export interface TargetProp {
  readonly name: string;
  readonly contract: PropContract;
  readonly local: string;
}

export interface TargetEvent extends EventDeclaration {
  readonly detailType: string;
  readonly callbackName: string;
}

export interface TargetMethod extends MethodDeclaration {
  readonly returnType: string;
}

export interface TargetComponent {
  readonly definition: ComponentDefinition;
  readonly props: readonly TargetProp[];
  readonly events: readonly TargetEvent[];
  readonly methods: readonly TargetMethod[];
  readonly slots: readonly SlotContract[];
  readonly controller?: string;
}

function pascalCase(name: string): string {
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join("");
}

export function declarationTypeSource(source: string): string {
  if (source === "undefined" || source === "void") return "void";
  if (source === "object") return "unknown";
  const promise = /^promise\((.*)\)$/.exec(source);
  if (promise !== null) return `Promise<${declarationTypeSource(promise[1]!.trim())}>`;
  try {
    return typeScriptType(parseTypeExpression(source));
  } catch {
    return "unknown";
  }
}

/** Shared public-surface model consumed by every target emitter. */
export function targetComponent(definition: ComponentDefinition): TargetComponent {
  const declarations = definition.declarations ?? [];
  return Object.freeze({
    definition,
    props: Object.freeze(Object.entries(definition.contract.props).map(([name, contract], index) =>
      Object.freeze({ name, contract, local: `prop${index}` })
    )),
    events: Object.freeze(declarations.filter((declaration): declaration is EventDeclaration =>
      declaration.kind === "event"
    ).map((event) => Object.freeze({
      ...event,
      detailType: typeScriptType(parseTypeExpression(event.type)),
      callbackName: `on${pascalCase(event.name)}`,
    }))),
    methods: Object.freeze(declarations.filter((declaration): declaration is MethodDeclaration =>
      declaration.kind === "method"
    ).map((method) => Object.freeze({ ...method, returnType: declarationTypeSource(method.returns) }))),
    slots: Object.freeze([...(definition.slots ?? [])]),
    ...(definition.controller === undefined ? {} : { controller: definition.controller }),
  });
}
