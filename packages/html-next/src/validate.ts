import {
  normalizeType,
  parseTypedValue,
  parseTypeExpression,
  type TerminalTypeName,
  type TypeInput,
  type TypeIssue,
  type TypedResult,
} from "./type-system.js";
import type { PropType } from "./types.js";

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
const FORMAT_TYPES = [
  "email", "url", "date", "time", "datetime-local", "month", "week", "color",
  "token", "ident", "url-value", "token-list",
] as const;
type FormatTypeName = typeof FORMAT_TYPES[number];
type ValidationTypeName = TerminalTypeName | FormatTypeName;

function isEmpty(value: unknown, multiple = false): boolean {
  return value === undefined || value === null || value === "" ||
    (multiple && Array.isArray(value) && value.length === 0);
}

function isFormatType(type: unknown): type is FormatTypeName {
  return FORMAT_TYPES.includes(type as FormatTypeName);
}

function resolveType(type: Constraint["type"]): TypeInput | FormatTypeName | undefined {
  if (type === undefined) return undefined;
  if (isFormatType(type)) return type;
  if (typeof type !== "string" || ["string", "boolean", "number"].includes(type)) {
    return type as TypeInput;
  }
  return parseTypeExpression(type);
}

function terminalName(type: TypeInput | FormatTypeName | undefined): ValidationTypeName | undefined {
  if (type === undefined) return undefined;
  if (isFormatType(type)) return type;
  const normalized = normalizeType(type);
  return normalized.kind === "terminal" ? normalized.name : undefined;
}

function typeErrors(issues: readonly TypeIssue[], type: string | undefined): ValidityError[] {
  return issues.map((item) => ({
    reason: item.reason === "untrustedValue"
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

function validDate(value: string): boolean {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
}

function formatValue(value: unknown, type: FormatTypeName, path = "$" ): TypedResult {
  const mismatch = (message: string): TypedResult => ({
    ok: false,
    issues: [{ reason: "typeMismatch", message, path }],
  });
  if (type === "email") {
    if (typeof value !== "string" || value.length > 254 || /\s/.test(value)) {
      return mismatch("Must be a valid email address.");
    }
    const match = /^([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Za-z0-9.-]+)$/.exec(value);
    if (match === null || match[1]!.length > 64 || !match[2]!.split(".").every((label) =>
      label !== "" && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"))) {
      return mismatch("Must be a valid email address.");
    }
    return { ok: true, value };
  }
  if (type === "url") {
    if (typeof value !== "string") return mismatch("Must be a URL.");
    try { return { ok: true, value: new URL(value).href }; }
    catch { return mismatch("Must be a valid absolute URL."); }
  }
  if (type === "date") return typeof value === "string" && validDate(value)
    ? { ok: true, value } : mismatch("Must be a valid date (YYYY-MM-DD).");
  if (type === "time") return typeof value === "string" && validTime(value)
    ? { ok: true, value } : mismatch("Must be a valid time.");
  if (type === "datetime-local") {
    if (typeof value !== "string") return mismatch("Must be a local date and time.");
    const parts = value.split("T");
    return parts.length === 2 && validDate(parts[0]!) && validTime(parts[1]!)
      ? { ok: true, value }
      : mismatch("Must be a valid local date and time.");
  }
  if (type === "month") return typeof value === "string" && /^(?!0000)\d{4,}-(?:0[1-9]|1[0-2])$/.test(value)
    ? { ok: true, value } : mismatch("Must be a valid month.");
  if (type === "week") {
    const match = typeof value === "string" ? /^(\d{4,})-W(\d{2})$/.exec(value) : null;
    const year = Number(match?.[1]);
    const week = Number(match?.[2]);
    const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    return match !== null && match[1] !== "0000" && week >= 1 && week <= 53 &&
      (week < 53 || jan1 === 4 || (jan1 === 3 && new Date(Date.UTC(year, 1, 29)).getUTCDate() === 29))
      ? { ok: true, value }
      : mismatch("Must be a valid ISO week.");
  }
  if (type === "color") return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? { ok: true, value: value.toLowerCase() } : mismatch("Must be a six-digit sRGB color.");
  if (type === "token") return typeof value === "string" && value !== "" && !/[\t\n\f\r ]/.test(value)
    ? { ok: true, value } : mismatch("Must be one non-empty HTML token.");
  if (type === "ident") {
    // Non-ASCII code points are valid identifier characters in this conservative projection.
    // oxlint-disable-next-line eslint/no-control-regex
    return typeof value === "string" && /^-?(?:-?[A-Za-z_]|[^\0-\x7f])(?:[A-Za-z0-9_-]|[^\0-\x7f])*$/.test(value) && !/^--$/.test(value)
      ? { ok: true, value } : mismatch("Must be an identifier.");
  }
  if (type === "url-value") {
    // URL values reject all ASCII control characters.
    // oxlint-disable-next-line eslint/no-control-regex
    return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(value)
      ? { ok: true, value } : mismatch("Must be a URL value.");
  }
  const tokens = Array.isArray(value) ? value : typeof value === "string"
    ? value.trim().split(/\s+/).filter(Boolean)
    : undefined;
  return tokens !== undefined && tokens.every((token) => typeof token === "string" && token !== "" && !/\s/.test(token))
    ? { ok: true, value: tokens }
    : mismatch("Must be a space-separated token list.");
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
      const result = formatValue(address, "email", `$[${index}]`);
      return result.ok ? [] : typeErrors(result.issues, terminal);
    });
    errors.push(...failures);
    if (failures.length === 0) parsedValue = addresses;
  } else if (type !== undefined) {
    const result = isFormatType(type) ? formatValue(value, type) : parseTypedValue(value, type);
    if (result.ok) parsedValue = result.value;
    else errors.push(...typeErrors(result.issues, terminal));
  }

  const numeric = comparable(parsedValue, terminal);
  const minimum = parsedComparable(constraint.min, terminal);
  const maximum = parsedComparable(constraint.max, terminal);
  if (numeric !== undefined) {
    if (minimum !== undefined && numeric < minimum) {
      errors.push({ reason: "rangeUnderflow", message: `Value must be at least ${constraint.min}.` });
    }
    if (maximum !== undefined && numeric > maximum) {
      errors.push({ reason: "rangeOverflow", message: `Value must be at most ${constraint.max}.` });
    }
    if (constraint.step !== undefined && constraint.step !== "any" && constraint.step > 0) {
      const base = minimum ?? 0;
      const offset = Math.abs(numeric - base) % constraint.step;
      if (offset > EPSILON && Math.abs(offset - constraint.step) > EPSILON) {
        errors.push({ reason: "stepMismatch", message: `Value must align to a step of ${constraint.step}.` });
      }
    }
  }

  if (typeof value === "string") {
    if (constraint.minLength !== undefined && value.length < constraint.minLength) {
      errors.push({ reason: "tooShort", message: `Use at least ${constraint.minLength} characters.` });
    }
    if (constraint.maxLength !== undefined && value.length > constraint.maxLength) {
      errors.push({ reason: "tooLong", message: `Use no more than ${constraint.maxLength} characters.` });
    }
    if (constraint.pattern !== undefined) {
      let expression: RegExp | undefined;
      try { expression = new RegExp(`^(?:${constraint.pattern})$`, "v"); }
      catch {
        try { expression = new RegExp(`^(?:${constraint.pattern})$`, "u"); }
        catch { expression = undefined; }
      }
      if (expression !== undefined && !expression.test(value)) {
        errors.push({ reason: "patternMismatch", message: "Value does not match the required format." });
      }
    }
  }

  return errors.length === 0 ? VALID : { valid: false, errors };
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
