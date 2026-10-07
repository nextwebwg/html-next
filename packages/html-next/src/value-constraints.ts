/** Constraints shared by declared scalar props and nested fields. */
export interface ValueBounds {
  readonly min?: number | string;
  readonly max?: number | string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export type BoundFailureReason = "rangeUnderflow" | "rangeOverflow" | "tooShort" | "tooLong" | "patternMismatch";

export interface BoundFailure {
  readonly reason: BoundFailureReason;
  readonly message: string;
}

export function rangeType(name: string): boolean {
  return ["integer", "number", "date", "month", "week", "time", "datetime-local", "datetime"].includes(name);
}

export function textType(name: string): boolean {
  return ["string", "keyword", "url", "email"].includes(name);
}

/** Order only; the calendar values need not be converted to elapsed time. */
export function comparable(value: unknown, name: string): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  switch (name) {
    case "integer":
    case "number": {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
    case "date": {
      const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
      return match === null ? undefined : Number(match[1]) * 372 + Number(match[2]) * 31 + Number(match[3]);
    }
    case "month": {
      const match = /^(\d{4,})-(\d{2})$/.exec(value);
      return match === null ? undefined : Number(match[1]) * 12 + Number(match[2]);
    }
    case "week": {
      const match = /^(\d{4,})-W(\d{2})$/.exec(value);
      return match === null ? undefined : Number(match[1]) * 53 + Number(match[2]);
    }
    case "time": {
      const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value);
      return match === null ? undefined :
        Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) + Number(`0.${match[4] ?? 0}`);
    }
    case "datetime-local": {
      const time = Date.parse(`${value.replace(" ", "T")}Z`);
      return Number.isFinite(time) ? time : undefined;
    }
    case "datetime": {
      const time = Date.parse(value);
      return Number.isFinite(time) ? time : undefined;
    }
    default: return undefined;
  }
}

export function boundFailures(value: unknown, name: string, bounds: ValueBounds): readonly BoundFailure[] {
  if (value === null || value === undefined || value === "") return [];
  const failures: BoundFailure[] = [];
  const actual = comparable(value, name);
  if (actual !== undefined) {
    const min = comparable(bounds.min, name);
    const max = comparable(bounds.max, name);
    if (min !== undefined && actual < min) failures.push({ reason: "rangeUnderflow", message: `Value must be at least ${bounds.min}.` });
    if (max !== undefined && actual > max) failures.push({ reason: "rangeOverflow", message: `Value must be at most ${bounds.max}.` });
  }
  if (typeof value === "string") {
    if (bounds.minLength !== undefined && value.length < bounds.minLength) {
      failures.push({ reason: "tooShort", message: `Use at least ${bounds.minLength} characters.` });
    }
    if (bounds.maxLength !== undefined && value.length > bounds.maxLength) {
      failures.push({ reason: "tooLong", message: `Use at most ${bounds.maxLength} characters.` });
    }
    if (bounds.pattern !== undefined) {
      let expression: RegExp | undefined;
      try { expression = new RegExp(`^(?:${bounds.pattern})$`, "v"); }
      catch { try { expression = new RegExp(`^(?:${bounds.pattern})$`, "u"); } catch { /* invalid patterns do not constrain values */ } }
      if (expression !== undefined && !expression.test(value)) failures.push({ reason: "patternMismatch", message: "Value does not match the required format." });
    }
  }
  return failures;
}
