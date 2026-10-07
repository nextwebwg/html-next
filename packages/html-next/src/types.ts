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
}

export interface DefineContractOptions {
  readonly source?: string;
  /** The component tag, taken from the carrier's `component=` attribute. */
  readonly tag?: string;
}

export type SerializedPropTarget =
  | { readonly kind: "attribute"; readonly name: string; readonly value: string | null }
  | { readonly kind: "property"; readonly name: string; readonly value: PropValue | undefined };
