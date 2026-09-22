import type { TrustedContentValue, TypeNode } from "./type-system.js";

export type ContractStatus =
  | "early"
  | "experimental"
  | "stable"
  | "deprecated";

export type ScalarType = "string" | "boolean" | "number";

export interface EnumType {
  readonly enum: readonly string[];
}

export type PropType = ScalarType | EnumType | TypeNode;

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
  | TrustedContentValue
  | readonly PropValue[]
  | PropValueRecord;

export interface PropValueRecord {
  readonly [name: string]: PropValue | undefined;
}

export interface PropContract {
  readonly type: PropType;
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
}

export interface DefineContractOptions {
  readonly source?: string;
  /** The component tag, taken from the carrier's `component=` attribute. */
  readonly tag?: string;
}

export type SerializedPropTarget =
  | { readonly kind: "attribute"; readonly name: string; readonly value: string | null }
  | { readonly kind: "property"; readonly name: string; readonly value: PropValue | undefined };
