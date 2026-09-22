import { fail } from "./diagnostics.js";
import { deepFreeze } from "./freeze.js";
import { componentName } from "./names.js";
import {
  formatType,
  isAttributeType,
  isTypeNode,
  parseTypedValue,
  parseTypeExpression,
  serializeTypedValue,
  type TypeNode,
} from "./type-system.js";
import type {
  ComponentContract,
  ContractStatus,
  DefineContractOptions,
  EnumType,
  PropContract,
  PropTarget,
  PropType,
  PropValue,
  SerializedPropTarget,
} from "./types.js";

export { componentName as deriveName } from "./names.js";

const CONTRACT_FIELDS = [
  "status",
  "summary",
  "nativeElement",
  "props",
] as const;
const PROP_FIELDS = [
  "type",
  "default",
  "required",
  "target",
  "description",
] as const;
const STATUS_RE = /^(?:early|experimental|stable|deprecated)$/;

type UnknownRecord = Record<string, unknown>;

/**
 * Parses a `<prop type>` attribute into a raw prop type. A single scalar keyword
 * (`string`/`number`/`boolean`) stays scalar; anything else is an enum whose members are
 * split on the CSS value-definition-syntax single bar `|` (Values and Units, "one of").
 */
export function parseTypeAttribute(value: string): PropType {
  let parsed: TypeNode;
  try {
    parsed = parseTypeExpression(value);
  } catch (error) {
    fail("HC013", error instanceof Error ? error.message : "Invalid prop type expression.");
  }
  if (
    parsed.kind === "terminal" &&
    (parsed.name === "string" || parsed.name === "boolean" || parsed.name === "number")
  ) return parsed.name;
  if (parsed.kind === "keyword") return { enum: [parsed.value] };
  if (parsed.kind === "union" && parsed.members.every((member) => member.kind === "keyword")) {
    return { enum: parsed.members.map((member) => member.value) };
  }
  return parsed;
}

/** Coerces a `<prop default>` attribute string into a value of the declared type. */
export function coerceDefault(type: PropType, raw: string): unknown {
  const result = parseTypedValue(raw, type);
  return result.ok ? result.value : raw;
}

function record(value: unknown, code: string, message: string, source?: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, message, source);
  }
  return value as UnknownRecord;
}

function rejectUnknownFields(
  value: UnknownRecord,
  allowed: readonly string[],
  source?: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) {
    fail("HC002", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`, source);
  }
}

function requiredString(
  value: unknown,
  field: string,
  source?: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("HC003", `\`${field}\` must be a non-empty string.`, source);
  }
  return value;
}

function parseType(value: unknown, source?: string): PropType {
  if (typeof value === "string") {
    let parsed: TypeNode;
    try {
      parsed = parseTypeExpression(value);
    } catch (error) {
      fail("HC013", error instanceof Error ? error.message : `Unsupported prop type \`${value}\`.`, source);
    }
    return parsed.kind === "terminal" &&
      (parsed.name === "string" || parsed.name === "boolean" || parsed.name === "number")
      ? parsed.name
      : parsed;
  }

  const object = record(value, "HC013", "A prop type must be a scalar name or enum object.", source);
  if (isTypeNode(object)) {
    try {
      return parseTypeExpression(formatType(object));
    } catch (error) {
      fail("HC013", error instanceof Error ? error.message : "Invalid type node.", source);
    }
  }
  rejectUnknownFields(object, ["enum"], source);
  if (!Array.isArray(object.enum) || object.enum.length === 0) {
    fail("HC014", "An enum must contain at least one string member.", source);
  }
  if (!object.enum.every((member) => typeof member === "string")) {
    fail("HC014", "Every enum member must be a string.", source);
  }
  const members = object.enum as string[];
  for (let index = 0; index < members.length; index += 1) {
    if (members.indexOf(members[index]!, index + 1) !== -1) {
      fail("HC014", "Enum members must be unique.", source);
    }
  }
  return { enum: Object.freeze([...members]) } satisfies EnumType;
}

function parseTarget(value: unknown, source?: string): PropTarget {
  const object = record(value, "HC017", "A prop target must be an object.", source);
  rejectUnknownFields(object, ["attribute", "property"], source);
  const keys = Object.keys(object);
  if (keys.length !== 1) {
    fail("HC017", "A prop target must declare exactly one attribute or property.", source);
  }

  if ("attribute" in object) {
    if (
      typeof object.attribute !== "string" ||
      object.attribute === "" ||
      // oxlint-disable-next-line no-control-regex -- HTML forbids these exact control characters.
      !/^[^\u0000\t\n\f\r "'>/=]+$/.test(object.attribute)
    ) {
      fail("HC017", "An attribute target must be a valid HTML attribute name.", source);
    }
    return { attribute: object.attribute.toLowerCase() };
  }

  if (
    typeof object.property !== "string" ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(object.property)
  ) {
    fail("HC017", "A property target must be a valid DOM property identifier.", source);
  }
  return { property: object.property };
}

function accepts(type: PropType, value: unknown): value is PropValue {
  return parseTypedValue(value, type).ok;
}

function parseProp(name: string, value: unknown, source?: string): PropContract {
  const object = record(value, "HC012", `Prop \`${name}\` must be an object.`, source);
  rejectUnknownFields(object, PROP_FIELDS, source);

  const type = parseType(object.type, source);
  const required = object.required ?? false;
  if (typeof required !== "boolean") {
    fail("HC016", `Prop \`${name}\` has a non-boolean \`required\` value.`, source);
  }
  if (required && "default" in object) {
    fail("HC019", `Required prop \`${name}\` cannot also declare a default.`, source);
  }
  if ("default" in object && !accepts(type, object.default)) {
    fail("HC015", `Default for prop \`${name}\` does not satisfy its type.`, source);
  }

  const target = parseTarget(object.target, source);
  if (!isAttributeType(type)) {
    fail(
      "HC017",
      `Prop \`${name}\` cannot be written as an HTML attribute; function, unknown, and trusted content types have no text form.`,
      source,
    );
  }
  const description = requiredString(object.description, `props.${name}.description`, source);
  const normalized: {
    type: PropType;
    required: boolean;
    default?: PropValue;
    target: PropTarget;
    description: string;
  } = { type, required, target, description };
  if ("default" in object) normalized.default = object.default as PropValue;
  return deepFreeze(normalized);
}

export function defineContractWithNativeCheck(
  input: unknown,
  options: DefineContractOptions,
  isNativeElement: (name: string) => boolean,
): ComponentContract {
  const source = options.source;
  const object = record(input, "HC001", "A component contract must be an object.", source);
  rejectUnknownFields(object, CONTRACT_FIELDS, source);

  const tag = requiredString(options.tag, "component", source);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(tag)) {
    fail("HC005", "The `component` tag must be lowercase and contain a hyphen.", source);
  }
  const name = componentName(tag);
  if (object.status !== undefined && (typeof object.status !== "string" || !STATUS_RE.test(object.status))) {
    fail("HC007", "Component `status` is not recognized.", source);
  }
  const summary = object.summary === undefined ? undefined : requiredString(object.summary, "summary", source);
  const nativeElement = requiredString(object.nativeElement, "nativeElement", source);
  if (
    !/^[a-z][a-z0-9-]*$/.test(nativeElement) ||
    (!isNativeElement(nativeElement) &&
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(nativeElement))
  ) {
    fail("HC008", "`nativeElement` must be a lowercase HTML element or component tag.", source);
  }

  const rawProps = record(object.props, "HC009", "`props` must be an object.", source);
  const normalizedKeys = new Map<string, string>();
  for (const propName of Object.keys(rawProps)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(propName)) {
      fail("HC010", `Invalid prop name \`${propName}\`.`, source);
    }
    const key = propName.toLowerCase();
    const prior = normalizedKeys.get(key);
    if (prior !== undefined) {
      fail("HC011", `Props \`${prior}\` and \`${propName}\` collide after lowercase normalization.`, source);
    }
    normalizedKeys.set(key, propName);
  }

  const props: Record<string, PropContract> = {};
  for (const propName of Object.keys(rawProps).sort()) {
    props[propName] = parseProp(propName, rawProps[propName], source);
  }

  return deepFreeze({
    version: 1,
    name,
    tag,
    ...(object.status === undefined ? {} : { status: object.status as ContractStatus }),
    ...(summary === undefined ? {} : { summary }),
    nativeElement,
    props,
  });
}

export function serializePropTarget(
  prop: PropContract,
  provided: unknown,
): SerializedPropTarget {
  const value = provided === undefined ? prop.default : provided;
  if (value === undefined) {
    if (prop.required) {
      fail("HC020", "A required prop value was omitted.");
    }
    if ("attribute" in prop.target) {
      return { kind: "attribute", name: prop.target.attribute, value: null };
    }
    return { kind: "property", name: prop.target.property, value: null };
  }
  if (value === null) {
    if (prop.required) {
      fail("HC021", "A prop value does not satisfy its declared type.");
    }
    if ("attribute" in prop.target) {
      return { kind: "attribute", name: prop.target.attribute, value: null };
    }
    return { kind: "property", name: prop.target.property, value: null };
  }
  if (!accepts(prop.type, value)) {
    fail("HC021", "A prop value does not satisfy its declared type.");
  }
  const parsed = parseTypedValue(value, prop.type);
  if (!parsed.ok) fail("HC021", "A prop value does not satisfy its declared type.");
  const canonical = parsed.value as PropValue;

  if ("property" in prop.target) {
    return { kind: "property", name: prop.target.property, value: canonical };
  }
  if (typeof canonical === "boolean") {
    return { kind: "attribute", name: prop.target.attribute, value: canonical ? "" : null };
  }
  return { kind: "attribute", name: prop.target.attribute, value: serializeTypedValue(canonical, prop.type) };
}

export type {
  ComponentContract,
  DefineContractOptions,
  PropContract,
  PropTarget,
  PropType,
  SerializedPropTarget,
} from "./types.js";
