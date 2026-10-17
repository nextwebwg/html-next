import type { TrustedContentValue, TypeNode } from "./type-system.js";

export type ContractStatus =
  | "early"
  | "experimental"
  | "stable"
  | "deprecated";

export type ScalarType = "string" | "boolean" | "number";

export type PropType = ScalarType | TypeNode;

export interface AttributeTarget {
  readonly attribute: string;
  readonly property?: never;
}

export interface PropertyTarget {
  readonly property: string;
  readonly attribute?: never;
}

export type PropTarget = AttributeTarget | PropertyTarget;
export type PropValue =
  | string
  | boolean
  | number
  | null
  | Event
  | TrustedContentValue
  | readonly PropValue[]
  | PropValueRecord;

export interface PropValueRecord {
  readonly [name: string]: PropValue | undefined;
}

export interface PropContract {
  readonly type: PropType;
  /** Finite permitted values, all parsed through the prop's single declared type. */
  readonly values?: readonly (string | number | boolean)[];
  /** A declared prop whose constrained value selects this prop's non-null type. */
  readonly select?: {
    readonly from: string;
    readonly options: readonly { readonly value: string | number | boolean; readonly type: TypeNode }[];
  };
  readonly pattern?: string;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly required: boolean;
  readonly default?: PropValue;
  readonly target: PropTarget;
  readonly description: string;
}

export interface ComponentContract {
  readonly version: 1;
  readonly name: string;
  readonly tag: string;
  readonly status?: ContractStatus;
  readonly summary?: string;
  readonly nativeElement: string;
  readonly props: Readonly<Record<string, PropContract>>;
  /** Declared `<request>`s by name: what the controller asks its consumer. Omitted when none. */
  readonly requests?: Readonly<Record<string, RequestContract>>;
  /** Declared `<script src>` elements, in declared order: the code the component loads. Omitted when none. */
  readonly scripts?: readonly ScriptContract[];
  /** The props each slot gives its consumer's `<template slot>`, by slot name (`""` for the default slot). Omitted when none. */
  readonly slots?: Readonly<Record<string, SlotDeclaration>>;
}

/** A `<slot>` declaration in `<defs>`: the props its outlets give, declared as a component's props are. */
export interface SlotDeclaration {
  readonly props: Readonly<Record<string, PropContract>>;
}

/**
 * A declared script: an ordinary `<script>` the runtime inserts into `document.head` once per URL
 * and type, when an instance calls for it. Its standard attributes are copied onto that element.
 */
export interface ScriptContract {
  /** The name its status takes in expressions and `host.scripts`. */
  readonly name?: string;
  /** As written: a URL, resolved against the definition, or a bare name, resolved through the import map. */
  readonly src: string;
  readonly type?: "module";
  /** When the runtime inserts the element: on connection, near the viewport, or on `load()`. */
  readonly loading: "eager" | "lazy" | "manual";
  readonly integrity?: string;
  readonly crossorigin?: string;
  readonly referrerpolicy?: string;
  readonly fetchpriority?: string;
}

/**
 * A `<request>`: a question the controller asks with `host.request` and the consumer answers in
 * JavaScript. Never reflected, rendered or hydrated, so its types may be `unknown` or `event`.
 */
export interface RequestContract {
  /** The detail's type; `null` when the declaration has no `type`. */
  readonly type: TypeNode;
  /** The answer's type besides `null`, which always answers; `unknown` when it has no `returns`. */
  readonly returns: TypeNode;
  readonly description?: string;
}

export interface DefineContractOptions {
  readonly source?: string;
  /** The component tag, taken from the carrier's `component=` attribute. */
  readonly tag?: string;
}

export type SerializedPropTarget =
  | { readonly kind: "attribute"; readonly name: string; readonly value: string | null }
  | { readonly kind: "property"; readonly name: string; readonly value: PropValue | undefined };
