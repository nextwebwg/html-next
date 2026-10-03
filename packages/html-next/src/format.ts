import type { TypeNode } from "./type-system.js";

/** A declared type's formatting identity; unions must agree after removing absence. */
export function formattingType(type: TypeNode | undefined): string | undefined {
  if (type === undefined) return undefined;
  if (type.kind === "constrained") return formattingType(type.base);
  if (type.kind === "union") {
    const members = type.members.filter((member) => member.kind !== "terminal" || !["null", "absent"].includes(member.name));
    const names = members.map(formattingType);
    return names.length > 0 && names.every((name) => name === names[0]) ? names[0] : undefined;
  }
  if (type.kind === "selected") {
    const names = type.options.map((option) => formattingType(option.type));
    return names.length > 0 && names.every((name) => name === names[0]) ? names[0] : undefined;
  }
  if (type.kind === "list" || type.kind === "separated-list") {
    const item = formattingType(type.item);
    return item === "string" || item === "keyword" ? "list" : undefined;
  }
  return type.kind === "terminal" ? type.name : type.kind === "keyword" ? "keyword" : undefined;
}

/**
 * The native Intl adapter. Self-contained so converters emit this same implementation only when
 * authored expressions use formatting, without importing the live parser or interpreter.
 * undefined is absence; the shared invalid-result symbol tells each target to retain its output.
 */
export function formatValue(value: any, inputType: string | undefined, operation: string, ...args: any[]): any {
  const invalid = Symbol.for("html-next.invalid-result");
  if (value === invalid || args.includes(invalid)) return invalid;
  if (value === undefined || value === null || args.some((arg) => arg === undefined)) return undefined;
  const end = operation === "formatRange" ? args.shift() : undefined;
  if (operation === "formatRange" && (end === null || end === undefined)) return undefined;
  const explicit = typeof args[0] === "string";
  const defaults: Record<string, string> = { number: "number", integer: "number", percentage: "percent", date: "date", time: "time", datetime: "dateTime", "datetime-local": "dateTime", duration: "duration", list: "list" };
  const format = explicit ? args.shift() : Reflect.get(defaults, inputType ?? "");
  const options = args.length > 0 ? args.shift() : {};
  const locale = args.shift();
  if (args.length > 0 || !format || options === null || typeof options !== "object" || Array.isArray(options) || locale !== undefined && typeof locale !== "string") return invalid;
  try {
    const durationFields = ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"];
    const settings = { ...options };
    let formatter: any;
    let input = value;
    let last = end;
    let zoneFree = false;
    if (["number", "currency", "percent", "unit"].includes(format)) {
      if (format !== "number") {
        if (settings.style !== undefined && settings.style !== format) return invalid;
        settings.style = format;
      }
      const quantity = (candidate: any): any => {
        if (inputType === "percentage" && typeof candidate === "string" && /^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(candidate)) return Number(candidate.slice(0, -1)) / 100;
        return candidate;
      };
      input = quantity(input);
      last = quantity(last);
      if (typeof input !== "number" || !Number.isFinite(input) || operation === "formatRange" && (typeof last !== "number" || !Number.isFinite(last))) return invalid;
      formatter = new Intl.NumberFormat(locale, settings);
    } else if (["date", "time", "dateTime"].includes(format)) {
      const civil = inputType === "date" || inputType === "time" || inputType === "datetime-local" || typeof input === "string" && !/(?:Z|[+-]\d\d:\d\d)$/.test(input);
      zoneFree = civil;
      if (civil && (settings.timeZone !== undefined || settings.timeZoneName !== undefined)) return invalid;
      if (format === "date" && (settings.timeStyle !== undefined || ["hour", "minute", "second", "dayPeriod", "fractionalSecondDigits"].some((key) => settings[key] !== undefined)) ||
        format === "time" && (settings.dateStyle !== undefined || ["year", "month", "day", "weekday", "era"].some((key) => settings[key] !== undefined))) return invalid;
      const fields = ["year", "month", "day", "weekday", "era", "hour", "minute", "second", "dayPeriod", "fractionalSecondDigits"];
      if (settings.dateStyle === undefined && settings.timeStyle === undefined && !fields.some((key) => settings[key] !== undefined)) {
        if (format !== "time") settings.dateStyle = "medium";
        if (format !== "date") settings.timeStyle = "medium";
      }
      if (civil) settings.timeZone = "UTC";
      const asDate = (candidate: any): Date | undefined => {
        if (typeof candidate === "number" && Number.isFinite(candidate)) return new Date(candidate);
        if (typeof candidate !== "string") return undefined;
        let written = candidate.replace(" ", "T");
        if (/^\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(written)) {
          if (format !== "time") return undefined;
          written = "1970-01-01T" + written + "Z";
        } else if (/^\d{4,}-\d\d-\d\d$/.test(written)) {
          if (format !== "date") return undefined;
          written += "T00:00:00Z";
        }
        else if (/^\d{4,}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(written)) written += "Z";
        else if (!/^\d{4,}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(written)) return undefined;
        const date = new Date(written.replace(/^(\d{5,})-/, (_match, year: string) => "+" + year.padStart(6, "0") + "-"));
        if (!Number.isFinite(date.getTime())) return undefined;
        // Native Date normalizes invalid days; authored HTML dates must not roll into another day.
        const match = /^(\d{4,})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(written);
        if (!match) return undefined;
        const probe = new Date(0);
        probe.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (Number(match[1]) === 0 || probe.getUTCMonth() !== Number(match[2]) - 1 || probe.getUTCDate() !== Number(match[3]) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return undefined;
        return date;
      };
      input = asDate(input);
      last = operation === "formatRange" ? asDate(last) : undefined;
      if (!input || operation === "formatRange" && !last) return invalid;
      formatter = new Intl.DateTimeFormat(locale, settings);
    } else {
      if (operation === "formatRange") return invalid;
      if (format === "relativeTime") {
        if (typeof input !== "number" || !Number.isFinite(input) || typeof settings.unit !== "string") return invalid;
        formatter = new Intl.RelativeTimeFormat(locale, settings);
        return operation === "formatParts" ? formatter.formatToParts(input, settings.unit) : formatter.format(input, settings.unit);
      }
      if (format === "list") {
        if (!Array.isArray(input) || input.some((item: any) => typeof item !== "string")) return invalid;
        formatter = new Intl.ListFormat(locale, settings);
      } else if (format === "duration") {
        if (inputType === "duration" && typeof input === "string") {
          const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(ms|s)$/.exec(input);
          if (!match) return invalid;
          const milliseconds = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
          if (!Number.isFinite(milliseconds)) return invalid;
          const hours = Math.trunc(milliseconds / 3600000);
          const minutes = Math.trunc((milliseconds % 3600000) / 60000);
          const seconds = Math.trunc((milliseconds % 60000) / 1000);
          input = { hours, minutes, seconds, milliseconds: Math.trunc(milliseconds % 1000), microseconds: Math.trunc((milliseconds - Math.trunc(milliseconds)) * 1000), nanoseconds: Math.round((milliseconds * 1000 - Math.trunc(milliseconds * 1000)) * 1000) };
        }
        if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !durationFields.includes(key))) return invalid;
        const DurationFormat = Reflect.get(Intl, "DurationFormat");
        if (!DurationFormat) return invalid;
        formatter = new DurationFormat(locale, settings);
      } else if (format === "displayName") {
        if (typeof input !== "string" || operation === "formatParts") return invalid;
        return new Intl.DisplayNames(locale, settings).of(input);
      } else if (format === "plural") {
        if (typeof input !== "number" || !Number.isFinite(input) || operation === "formatParts") return invalid;
        const forms = settings.forms;
        if (!forms || typeof forms !== "object" || Array.isArray(forms) || typeof forms.other !== "string" || Object.entries(forms).some(([key, entry]) => !["zero", "one", "two", "few", "many", "other"].includes(key) || typeof entry !== "string")) return invalid;
        const category = new Intl.PluralRules(locale, settings).select(input);
        const message = forms[category] ?? forms.other;
        const numberOptions = { ...settings };
        delete numberOptions.type;
        delete numberOptions.forms;
        const number = new Intl.NumberFormat(locale, numberOptions).format(input);
        return message.replace(/#/g, () => number);
      }
    }
    if (!zoneFree && operation !== "formatParts") return operation === "formatRange" ? formatter.formatRange(input, last) : formatter.format(input);
    const parts = operation === "formatRange" ? formatter.formatRangeToParts(input, last) : formatter.formatToParts(input);
    if (zoneFree && operation !== "formatParts" && !parts.some((part: any) => part.type === "timeZoneName")) return operation === "formatRange" ? formatter.formatRange(input, last) : formatter.format(input);
    const visible = zoneFree ? parts.filter((part: any, index: number) => part.type !== "timeZoneName" && !(part.type === "literal" && /^[\s(),]*$/.test(part.value) && (parts[index - 1]?.type === "timeZoneName" || parts[index + 1]?.type === "timeZoneName"))) : parts;
    return operation === "formatParts" ? visible : visible.map((part: any) => part.value).join("");
  } catch {
    return invalid;
  }
}
