import { fail } from "./diagnostics.js";
import { getDomInterface } from "./platform.js";
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

/** Derives the PascalCase component name from its `component` tag, e.g. `x-button` -> `XButton`. */
export function deriveName(tag: string): string {
  return tag
    .split("-")
    .filter((segment) => segment !== "")
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

/**
 * Parses a `<prop type>` attribute into a raw prop type. A single scalar keyword
 * (`string`/`number`/`boolean`) stays scalar; anything else is an enum whose members are
 * split on the CSS value-definition-syntax single bar `|` (Values and Units, "one of").
 */
export function parseTypeAttribute(value: string): string | { enum: string[] } {
  const members = value.split("|").map((member) => member.trim()).filter((member) => member !== "");
  if (members.length === 1 && SCALAR_TYPES.has(members[0]!)) return members[0]!;
  return { enum: members };
}

/** Coerces a `<prop default>` attribute string into a value of the declared type. */
export function coerceDefault(type: string | { enum: string[] }, raw: string): unknown {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
}

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
    if (!SCALAR_TYPES.has(value)) {
      fail("HC013", `Unsupported prop type \`${value}\`.`, source);
    }
    return value as PropType;
  }

  const object = record(value, "HC013", "A prop type must be a scalar name or enum object.", source);
  rejectUnknownFields(object, new Set(["enum"]), source);
  if (!Array.isArray(object.enum) || object.enum.length === 0) {
    fail("HC014", "An enum must contain at least one string member.", source);
  }
  if (!object.enum.every((member) => typeof member === "string")) {
    fail("HC014", "Every enum member must be a string.", source);
  }
  const members = object.enum as string[];
  if (new Set(members).size !== members.length) {
    fail("HC014", "Enum members must be unique.", source);
  }
  return { enum: Object.freeze([...members]) } satisfies EnumType;
}

function parseTarget(value: unknown, source?: string): PropTarget {
  const object = record(value, "HC017", "A prop target must be an object.", source);
  rejectUnknownFields(object, new Set(["attribute", "property"]), source);
  const keys = Object.keys(object);
  if (keys.length !== 1) {
    fail("HC017", "A prop target must declare exactly one attribute or property.", source);
  }

  if ("attribute" in object) {
    if (
      typeof object.attribute !== "string" ||
      object.attribute === "" ||
      !/^[^\u0000\t\n\f\r "'>\/=]+$/.test(object.attribute)
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
  if (typeof type === "object") {
    return typeof value === "string" && type.enum.includes(value);
  }
  return typeof value === type && (type !== "number" || Number.isFinite(value));
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
  const object = record(input, "HC001", "A component contract must be an object.", source);
  rejectUnknownFields(object, CONTRACT_FIELDS, source);

  const tag = requiredString(options.tag, "component", source);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(tag)) {
    fail("HC005", "The `component` tag must be lowercase and contain a hyphen.", source);
  }
  const name = deriveName(tag);
  if (typeof object.status !== "string" || !STATUSES.has(object.status as ContractStatus)) {
    fail("HC007", "Component `status` is not recognized.", source);
  }
  const summary = requiredString(object.summary, "summary", source);
  const nativeElement = requiredString(object.nativeElement, "nativeElement", source);
  if (
    !/^[a-z][a-z0-9-]*$/.test(nativeElement) ||
    (getDomInterface(nativeElement) === undefined &&
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
