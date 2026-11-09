import { declareTypes } from "../declared-types.js";
import { referencePath, type ExpressionNode, type ReferencePath, type Scope as TypeScope } from "../expression.js";
import type { ComponentDefinition } from "../template.js";
import { typeAtKey, type TypeNode } from "../type-system.js";
import type { PropContract } from "../types.js";
import { conformingScalarStates, conformingStates, twoWayRoots } from "./state-roots.js";

export interface ReferenceContract {
  readonly type: TypeNode;
  readonly trusted?: boolean;
  readonly select?: NonNullable<PropContract["select"]>;
}

export interface ReferenceEnvironment {
  readonly references?: ReadonlyMap<string, ReferenceContract | undefined> | undefined;
  readonly referenceFile?: string;
  readonly referenceTag?: string;
}

/** Declared contracts are separate from inferred types used to choose faster generated syntax. */
export function referenceContext(definition: ComponentDefinition, exposesState = false): Required<ReferenceEnvironment> {
  const types: TypeScope = { get: () => undefined };
  declareTypes(types, definition);
  const trusted = conformingScalarStates(definition);
  const immutable = !exposesState && definition.controller === undefined && definition.module === undefined &&
    !(definition.declarations ?? []).some(item => item.kind === "handler") && twoWayRoots(definition).size === 0
    ? conformingStates(definition) : new Set<string>();
  const names = new Set([...Object.keys(definition.contract.props), ...(definition.declarations ?? []).map(item => item.name)]);
  const references = new Map<string, ReferenceContract | undefined>();
  for (const name of names) {
    const declaration = definition.declarations?.find(item => item.name === name);
    // A checked literal with no exposed writer cannot acquire a nonconforming descendant.
    if (immutable.has(name) && declaration?.kind === "state" && declaration.initializer === undefined) continue;
    const type = types.typeOfDeclaredPath?.(name);
    if (type === undefined) continue;
    const prop = definition.contract.props[name];
    references.set(name, { type, trusted: trusted.has(name) || prop !== undefined && prop.select === undefined,
      ...(prop?.select === undefined ? {} : { select: prop.select }) });
  }
  return { references, referenceFile: definition.source.file, referenceTag: definition.contract.tag };
}

/** An alias inherits a declared path's contract only, never an inferred expression result. */
export function referenceType(node: ExpressionNode, scope: ReferenceEnvironment): TypeNode | undefined {
  const path = referencePath(node);
  if (path?.staticKeys === undefined) return undefined;
  let type = scope.references?.get(path.root)?.type;
  for (const key of path.staticKeys) type = type === undefined ? undefined : typeAtKey(type, key);
  return type;
}

export function referenceCanFail(path: ReferencePath, scope: ReferenceEnvironment): boolean {
  const root = scope.references?.get(path.root);
  if (root === undefined || path.steps.length === 0 && root.trusted === true) return false;
  if (root.select !== undefined) return true;
  let type: TypeNode | undefined = root.type;
  if (path.staticKeys !== undefined) for (const key of path.staticKeys) type = type === undefined ? undefined : typeAtKey(type, key);
  return type !== undefined && !(type.kind === "terminal" && type.name === "unknown");
}

/** Shadow an outer declaration even when the new lexical name carries no declared contract. */
export function withReferenceTypes<T extends ReferenceEnvironment>(scope: T, entries: readonly (readonly [string, TypeNode | undefined])[]): T {
  if (scope.references === undefined) return scope;
  return { ...scope, references: new Map([...scope.references, ...entries.map(([name, type]) =>
    [name, type === undefined ? undefined : { type }] as const)]) };
}

/** Literal declaration values use evalValue semantics, without reference refusal. */
export function uncheckedReferences<T extends ReferenceEnvironment>(scope: T): T {
  return { ...scope, references: undefined };
}
