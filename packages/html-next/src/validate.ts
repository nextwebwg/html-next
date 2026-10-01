import {
  normalizeType,
  parseTypedValue,
  parseTypeExpression,
  type TerminalTypeName,
  type TypeInput,
  type TypeIssue,
} from "./type-system.js";
import type { PropType } from "./types.js";
import type { ComponentContract } from "./types.js";
import { selectedPropType } from "./contract.js";
import { boundFailures } from "./value-constraints.js";

/** One normalized validation failure. Structured values always include a stable path. */
export interface ValidityError {
  readonly reason: ValidityReason;
  readonly message: string;
  readonly path?: string;
}

export type ValidityReason =
  | "valueMissing"
  | "typeMismatch"
  | "patternMismatch"
  | "tooLong"
  | "tooShort"
  | "rangeUnderflow"
  | "rangeOverflow"
  | "stepMismatch"
  | "badInput"
  | "customError"
  | "schemaMismatch"
  | "untrustedValue";

export type Validity =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly ValidityError[] };

/** Constraints shared by props, data, controls, and arbitrary managed elements. */
export interface Constraint {
  readonly type?: PropType | string;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly step?: number | "any";
}

/** Native ValidityState field for each normalized issue. */
export const NATIVE_FLAG: Readonly<Record<ValidityReason, keyof ValidityState | "schemaMismatch" | "untrustedValue">> = {
  valueMissing: "valueMissing",
  typeMismatch: "typeMismatch",
  patternMismatch: "patternMismatch",
  tooLong: "tooLong",
  tooShort: "tooShort",
  rangeUnderflow: "rangeUnderflow",
  rangeOverflow: "rangeOverflow",
  stepMismatch: "stepMismatch",
  badInput: "badInput",
  customError: "customError",
  schemaMismatch: "schemaMismatch",
  untrustedValue: "untrustedValue",
};

const VALID: Validity = { valid: true, errors: [] };
const EPSILON = 1e-9;
type ValidationTypeName = TerminalTypeName;

function isEmpty(value: unknown, multiple = false): boolean {
  return value === undefined || value === null || value === "" ||
    (multiple && Array.isArray(value) && value.length === 0);
}

function resolveType(type: Constraint["type"]): TypeInput | undefined {
  if (type === undefined) return undefined;
  return typeof type === "string" ? parseTypeExpression(type) : type;
}

function terminalName(type: TypeInput | undefined): ValidationTypeName | undefined {
  if (type === undefined) return undefined;
  const normalized = normalizeType(type);
  return normalized.kind === "terminal" ? normalized.name : undefined;
}

function typeErrors(issues: readonly TypeIssue[], type: string | undefined): ValidityError[] {
  return issues.map((item) => ({
    reason: item.reason !== "badInput" && item.reason !== "typeMismatch"
      ? item.reason
      : item.reason === "badInput" && !["email", "url"].includes(type ?? "")
        ? "badInput"
        : "typeMismatch",
    message: item.message,
    path: item.path,
  }));
}

function comparable(value: unknown, type: ValidationTypeName | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  switch (type) {
    case "number":
    case "integer": {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
    case "date": {
      const ms = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(ms) ? ms / 86_400_000 : undefined;
    }
    case "datetime-local": {
      const ms = Date.parse(`${value}Z`);
      return Number.isFinite(ms) ? ms / 1000 : undefined;
    }
    case "time": {
      const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value);
      return match === null ? undefined :
        Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) + Number(`0.${match[4] ?? 0}`);
    }
    case "month": {
      const match = /^(\d+)-(\d{2})$/.exec(value);
      return match === null ? undefined : Number(match[1]) * 12 + Number(match[2]) - 1;
    }
    case "week": {
      const match = /^(\d+)-W(\d{2})$/.exec(value);
      return match === null ? undefined : Number(match[1]) * 53 + Number(match[2]) - 1;
    }
    default: return undefined;
  }
}

function parsedComparable(bound: number | string | undefined, type: ValidationTypeName | undefined): number | undefined {
  return bound === undefined ? undefined : comparable(bound, type);
}

/**
 * Validate a value against HTML Next types and HTML constraints. Empty optional values stop
 * after requiredness, matching the Constraint Validation API. All other applicable failures
 * are returned rather than hiding later failures behind the first message.
 */
export function validate(value: unknown, constraint: Constraint = {}): Validity {
  if (isEmpty(value, constraint.multiple)) {
    return constraint.required
      ? { valid: false, errors: [{ reason: "valueMissing", message: "This field is required." }] }
      : VALID;
  }

  const errors: ValidityError[] = [];
  const type = resolveType(constraint.type);
  const terminal = terminalName(type);
  let parsedValue: unknown = value;

  if (terminal === "email" && constraint.multiple && typeof value === "string") {
    const addresses = value.split(",").map((address) => address.trim());
    const failures = addresses.flatMap((address, index) => {
      const result = parseTypedValue(address, parseTypeExpression("email"), `$[${index}]`);
      return result.ok ? [] : typeErrors(result.issues, terminal);
    });
    errors.push(...failures);
    if (failures.length === 0) parsedValue = addresses;
  } else if (type !== undefined) {
    const result = parseTypedValue(value, type);
    if (result.ok) parsedValue = result.value;
    else errors.push(...typeErrors(result.issues, terminal));
  }

  const numeric = comparable(parsedValue, terminal);
  const minimum = parsedComparable(constraint.min, terminal);
  if (numeric !== undefined) {
    if (constraint.step !== undefined && constraint.step !== "any" && constraint.step > 0) {
      const base = minimum ?? 0;
      const offset = Math.abs(numeric - base) % constraint.step;
      if (offset > EPSILON && Math.abs(offset - constraint.step) > EPSILON) {
        errors.push({ reason: "stepMismatch", message: `Value must align to a step of ${constraint.step}.` });
      }
    }
  }

  errors.push(...boundFailures(parsedValue, terminal ?? "", constraint));

  return errors.length === 0 ? VALID : { valid: false, errors };
}

/** Validate declared prop values through one read surface, shared by live and generated targets. */
export function validateComponentProps(contract: ComponentContract, read: (name: string) => unknown): Validity {
  const errors: ValidityError[] = [];
  for (const [name, prop] of Object.entries(contract.props)) {
    const value = read(name);
    const selected = selectedPropType(contract, prop, prop.select === undefined ? {}
      : { [prop.select.from]: read(prop.select.from) });
    if (selected === null) {
      if (value !== null && value !== undefined && value !== "") errors.push({
        reason: "typeMismatch", message: `No type option matches the value of \`${prop.select!.from}\`.`, path: name,
      });
      continue;
    }
    const result = validate(value, {
      type: selected, required: prop.required,
      ...(prop.min === undefined ? {} : { min: prop.min }),
      ...(prop.max === undefined ? {} : { max: prop.max }),
      ...(prop.minLength === undefined ? {} : { minLength: prop.minLength }),
      ...(prop.maxLength === undefined ? {} : { maxLength: prop.maxLength }),
      ...(prop.pattern === undefined ? {} : { pattern: prop.pattern }),
    });
    errors.push(...result.errors.map((error) => ({ ...error, path: name })));
    if (value !== null && value !== undefined && value !== "" && prop.values !== undefined &&
        !prop.values.some((choice) => choice === value)) {
      errors.push({ reason: "typeMismatch", message: `Value must be one of ${prop.values.map(String).join(", ")}.`, path: name });
    }
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

const NATIVE_REASONS: ReadonlyArray<Exclude<ValidityReason, "schemaMismatch" | "untrustedValue">> = [
  "valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort",
  "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError",
];

/** Read the browser's authoritative constraint result without replacing native algorithms. */
export function validityFromNative(state: ValidityState, validationMessage: string): Validity {
  if (state.valid) return VALID;
  const errors = NATIVE_REASONS
    .filter((reason) => state[reason])
    .map((reason) => ({ reason, message: validationMessage || nativeMessage(reason) }));
  return errors.length === 0
    ? { valid: false, errors: [{ reason: "badInput", message: validationMessage || "The value is invalid." }] }
    : { valid: false, errors };
}

function nativeMessage(reason: ValidityReason): string {
  const messages: Readonly<Record<ValidityReason, string>> = {
    valueMissing: "This field is required.",
    typeMismatch: "Enter a value in the required format.",
    patternMismatch: "Value does not match the required format.",
    tooLong: "The value is too long.",
    tooShort: "The value is too short.",
    rangeUnderflow: "The value is below the allowed range.",
    rangeOverflow: "The value is above the allowed range.",
    stepMismatch: "The value does not align to the required step.",
    badInput: "The browser could not parse this value.",
    customError: "The application marked this value invalid.",
    schemaMismatch: "The value does not match its schema.",
    untrustedValue: "The value did not cross an approved trust boundary.",
  };
  return messages[reason];
}
