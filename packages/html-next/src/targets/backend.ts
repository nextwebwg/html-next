import type {
  ComponentDefinition,
  EventDeclaration,
  SlotContract,
} from "../template.js";
import { requestPropName } from "../names.js";
import type { PropContract, RequestContract } from "../types.js";
import { declarationTypeNode, parseTypeExpression, typeScriptType } from "../type-system.js";
import { fail } from "../diagnostics.js";

export interface TargetProp {
  readonly name: string;
  readonly contract: PropContract;
  readonly local: string;
}

/** Accept selectors before their dependents, independently of contract key order. */
export function propInputOrder<P extends Pick<TargetProp, "name" | "contract">>(props: readonly P[]): readonly P[] {
  const byName = new Map(props.map(prop => [prop.name, prop]));
  const ordered: P[] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();
  const visit = (prop: P): void => {
    if (seen.has(prop.name)) return;
    if (pending.has(prop.name)) fail("HC013", `Cyclic prop type selectors at ${prop.name}.`);
    pending.add(prop.name);
    const selector = prop.contract.select === undefined ? undefined : byName.get(prop.contract.select.from);
    if (selector !== undefined) visit(selector);
    pending.delete(prop.name);
    seen.add(prop.name);
    ordered.push(prop);
  };
  for (const prop of props) visit(prop);
  return ordered;
}

export interface TargetEvent extends EventDeclaration {
  readonly detailType: string;
  readonly callbackName: string;
}

export interface TargetRequest {
  readonly name: string;
  readonly contract: RequestContract;
  /** The detail's and the answer's TypeScript types; `null` is an answer besides `answerType`. */
  readonly detailType: string;
  readonly answerType: string;
  /** A framework component's function prop: `mention-query` is `mentionQuery`. */
  readonly propName: string;
  /** The event form's framework prop: `mention-query` is `onMentionQuery`. */
  readonly callbackName: string;
}

export interface TargetComponent {
  readonly definition: ComponentDefinition;
  readonly props: readonly TargetProp[];
  readonly events: readonly TargetEvent[];
  readonly requests: readonly TargetRequest[];
  readonly slots: readonly SlotContract[];
  readonly controller?: string;
  readonly module?: string;
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
      detailType: typeScriptType(declarationTypeNode(event.type, event.shape)!),
      callbackName: `on${pascalCase(event.name)}`,
    }))),
    requests: Object.freeze(Object.entries(definition.contract.requests ?? {}).map(([name, contract]) => Object.freeze({
      name,
      contract,
      detailType: typeScriptType(contract.type),
      answerType: typeScriptType(contract.returns),
      propName: requestPropName(name),
      callbackName: `on${pascalCase(name)}`,
    }))),
    slots: Object.freeze([...(definition.slots ?? [])]),
    ...(definition.controller === undefined ? {} : { controller: definition.controller }),
    ...(definition.module === undefined ? {} : { module: definition.module }),
  });
}
