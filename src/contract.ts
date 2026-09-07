import { fail } from "./diagnostics.js";
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

const CONTRACT_FIELDS = new Set([
  "version",
  "name",
  "tag",
  "status",
  "summary",
  "nativeElement",
  "props",
]);
const PROP_FIELDS = new Set([
  "type",
  "default",
  "required",
  "target",
  "description",
]);
const STATUSES = new Set<ContractStatus>([
  "early",
  "experimental",
  "stable",
  "deprecated",
]);
const SCALAR_TYPES = new Set(["string", "boolean", "number"]);

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, code: string, message: string, source?: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, message, source);
  }
  return value as UnknownRecord;
}

function rejectUnknownFields(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  source?: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    fail("H7C002", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`, source);
  }
}

function requiredString(
  value: unknown,
  field: string,
  source?: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("H7C003", `\`${field}\` must be a non-empty string.`, source);
  }
  return value;
}

function parseType(value: unknown, source?: string): PropType {
  if (typeof value === "string") {
    if (!SCALAR_TYPES.has(value)) {
      fail("H7C013", `Unsupported prop type \`${value}\`.`, source);
    }
    return value as PropType;
  }

  const object = record(value, "H7C013", "A prop type must be a scalar name or enum object.", source);
  rejectUnknownFields(object, new Set(["enum"]), source);
  if (!Array.isArray(object.enum) || object.enum.length === 0) {
    fail("H7C014", "An enum must contain at least one string member.", source);
  }
  if (!object.enum.every((member) => typeof member === "string")) {
    fail("H7C014", "Every enum member must be a string.", source);
  }
  const members = object.enum as string[];
  if (new Set(members).size !== members.length) {
    fail("H7C014", "Enum members must be unique.", source);
  }
  return { enum: Object.freeze([...members]) } satisfies EnumType;
}

function parseTarget(value: unknown, source?: string): PropTarget {
  const object = record(value, "H7C017", "A prop target must be an object.", source);
  rejectUnknownFields(object, new Set(["attribute", "property"]), source);
  const keys = Object.keys(object);
  if (keys.length !== 1) {
    fail("H7C017", "A prop target must declare exactly one attribute or property.", source);
  }

  if ("attribute" in object) {
    if (
      typeof object.attribute !== "string" ||
      object.attribute === "" ||
      !/^[^\u0000\t\n\f\r "'>\/=]+$/.test(object.attribute)
    ) {
      fail("H7C017", "An attribute target must be a valid HTML attribute name.", source);
    }
    return { attribute: object.attribute.toLowerCase() };
  }

  if (
    typeof object.property !== "string" ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(object.property)
  ) {
    fail("H7C017", "A property target must be a valid DOM property identifier.", source);
  }
  return { property: object.property };
}

function accepts(type: PropType, value: unknown): value is PropValue {
  if (typeof type === "object") {
    return typeof value === "string" && type.enum.includes(value);
  }
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}

function parseProp(name: string, value: unknown, source?: string): PropContract {
  const object = record(value, "H7C012", `Prop \`${name}\` must be an object.`, source);
  rejectUnknownFields(object, PROP_FIELDS, source);

  const type = parseType(object.type, source);
  const required = object.required ?? false;
  if (typeof required !== "boolean") {
    fail("H7C016", `Prop \`${name}\` has a non-boolean \`required\` value.`, source);
  }
  if (required && "default" in object) {
    fail("H7C019", `Required prop \`${name}\` cannot also declare a default.`, source);
  }
  if ("default" in object && !accepts(type, object.default)) {
    fail("H7C015", `Default for prop \`${name}\` does not satisfy its type.`, source);
  }

  const target = parseTarget(object.target, source);
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

export function defineContract(
  input: unknown,
  options: DefineContractOptions = {},
): ComponentContract {
  const source = options.source;
  const object = record(input, "H7C001", "A component contract must be an object.", source);
  rejectUnknownFields(object, CONTRACT_FIELDS, source);

  if (object.version !== 1) {
    fail("H7C006", "Only component contract schema version 1 is supported.", source);
  }

  const name = requiredString(object.name, "name", source);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    fail("H7C004", "Component `name` must be a PascalCase identifier.", source);
  }
  const tag = requiredString(object.tag, "tag", source);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(tag)) {
    fail("H7C005", "Component `tag` must be lowercase and contain a hyphen.", source);
  }
  if (typeof object.status !== "string" || !STATUSES.has(object.status as ContractStatus)) {
    fail("H7C007", "Component `status` is not recognized.", source);
  }
  const summary = requiredString(object.summary, "summary", source);
  const nativeElement = requiredString(object.nativeElement, "nativeElement", source);
  if (!/^[a-z][a-z0-9-]*$/.test(nativeElement)) {
    fail("H7C008", "`nativeElement` must be a lowercase HTML element name.", source);
  }

  const rawProps = record(object.props, "H7C009", "`props` must be an object.", source);
  const normalizedKeys = new Map<string, string>();
  for (const propName of Object.keys(rawProps)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(propName)) {
      fail("H7C010", `Invalid prop name \`${propName}\`.`, source);
    }
    const key = propName.toLowerCase();
    const prior = normalizedKeys.get(key);
    if (prior !== undefined) {
      fail("H7C011", `Props \`${prior}\` and \`${propName}\` collide after lowercase normalization.`, source);
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
    status: object.status as ContractStatus,
    summary,
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
      fail("H7C020", "A required prop value was omitted.");
    }
    if ("attribute" in prop.target) {
      return { kind: "attribute", name: prop.target.attribute, value: null };
    }
    return { kind: "property", name: prop.target.property, value: null };
  }
  if (!accepts(prop.type, value)) {
    fail("H7C021", "A prop value does not satisfy its declared type.");
  }

  if ("property" in prop.target) {
    return { kind: "property", name: prop.target.property, value };
  }
  if (typeof value === "boolean") {
    return { kind: "attribute", name: prop.target.attribute, value: value ? "" : null };
  }
  return { kind: "attribute", name: prop.target.attribute, value: String(value) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export type {
  ComponentContract,
  DefineContractOptions,
  PropContract,
  PropTarget,
  PropType,
  SerializedPropTarget,
} from "./types.js";

