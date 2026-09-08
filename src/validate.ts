import type { PropType } from "./types.js";

/**
 * The validation primitive behind the proposed generalized Constraint Validation
 * (see the Validation module in the spec). It is a pure function of (value,
 * constraint): a value is valid or invalid, and when invalid it carries an OPEN
 * list of reasons. There is no "custom" reason; the reason vocabulary is meaningful
 * and extensible, which is exactly why the native `customError` bucket is not needed
 * here (it only reappears when a caller bridges to a legacy native control).
 */

/** A single reason a value failed validation. `path` names the failing field for structured values. */
export interface ValidityError {
  readonly reason: ValidityReason;
  readonly message: string;
  readonly path?: string;
}

export type ValidityReason =
  | "missing" // required, but empty
  | "type" // wrong type, or not a member of an enum
  | "range" // below min / above max
  | "length" // shorter / longer than allowed
  | "pattern" // fails a pattern
  | "step" // off the step grid
  | "unparseable"; // cannot be parsed to the declared type

export type Validity =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly ValidityError[] };

/** The declared constraints for a value: its type plus the constraint attributes. */
export interface Constraint {
  readonly type?: PropType;
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly step?: number;
}

/**
 * The mapping from our open reasons onto the native `ValidityState` flags, for interop
 * when a caller must drive a real form control. `range` resolves to `rangeUnderflow` or
 * `rangeOverflow` by context (the message says which). A reason with no native flag would
 * fall into native's `customError` — the one place "custom" survives, as a legacy bridge.
 */
export const NATIVE_FLAG: Readonly<Record<ValidityReason, string>> = {
  missing: "valueMissing",
  type: "typeMismatch",
  range: "rangeOverflow",
  length: "tooLong",
  pattern: "patternMismatch",
  step: "stepMismatch",
  unparseable: "badInput",
};

const VALID: Validity = { valid: true, errors: [] };
const EPSILON = 1e-9;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function isEnum(type: PropType | undefined): type is { readonly enum: readonly string[] } {
  return typeof type === "object" && type !== null && "enum" in type;
}

/**
 * Validate `value` against `constraint`. Returns every applicable reason (a value can fail
 * more than one way), so callers can report or count them. An empty, non-required value is
 * valid and nothing else applies to it.
 */
export function validate(value: unknown, constraint: Constraint = {}): Validity {
  if (isEmpty(value)) {
    return constraint.required
      ? { valid: false, errors: [{ reason: "missing", message: "This field is required." }] }
      : VALID;
  }

  const errors: ValidityError[] = [];
  const { type } = constraint;
  let num: number | undefined;

  if (isEnum(type)) {
    if (typeof value !== "string" || !type.enum.includes(value)) {
      errors.push({ reason: "type", message: `Must be one of: ${type.enum.join(", ")}.` });
    }
  } else if (type === "number") {
    if (typeof value === "number") {
      num = value;
    } else if (typeof value === "string") {
      const parsed = Number(value);
      if (value.trim() === "" || Number.isNaN(parsed)) {
        errors.push({ reason: "unparseable", message: "Must be a number." });
      } else {
        num = parsed;
      }
    } else {
      errors.push({ reason: "type", message: "Must be a number." });
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean" && value !== "true" && value !== "false") {
      errors.push({ reason: "type", message: "Must be true or false." });
    }
  }
  // `string` (and no declared type): any non-empty value already qualifies as a string.

  if (num !== undefined) {
    if (constraint.min !== undefined && num < constraint.min) {
      errors.push({ reason: "range", message: `Must be at least ${constraint.min}.` });
    }
    if (constraint.max !== undefined && num > constraint.max) {
      errors.push({ reason: "range", message: `Must be at most ${constraint.max}.` });
    }
    if (constraint.step !== undefined && constraint.step > 0) {
      const base = constraint.min ?? 0;
      const offset = Math.abs(num - base) % constraint.step;
      const off = offset > EPSILON && Math.abs(offset - constraint.step) > EPSILON;
      if (off) errors.push({ reason: "step", message: `Must be a multiple of ${constraint.step}.` });
    }
  }

  if (typeof value === "string") {
    if (constraint.minLength !== undefined && value.length < constraint.minLength) {
      errors.push({ reason: "length", message: `Must be at least ${constraint.minLength} characters.` });
    }
    if (constraint.maxLength !== undefined && value.length > constraint.maxLength) {
      errors.push({ reason: "length", message: `Must be at most ${constraint.maxLength} characters.` });
    }
    if (constraint.pattern !== undefined) {
      // Native `pattern` is anchored to the whole value.
      let re: RegExp | undefined;
      try {
        re = new RegExp(`^(?:${constraint.pattern})$`, "u");
      } catch {
        re = undefined; // an invalid pattern does not constrain (matches native leniency).
      }
      if (re && !re.test(value)) {
        errors.push({ reason: "pattern", message: "Does not match the required format." });
      }
    }
  }

  return errors.length === 0 ? VALID : { valid: false, errors };
}
