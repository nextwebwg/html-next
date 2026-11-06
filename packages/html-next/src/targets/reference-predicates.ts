import * as formats from "../formats.js";
import { CSS_COLOR_KEYWORDS } from "../css-color-keywords.js";
import { createEventCheck } from "../freeze.js";
import { browserTrusted } from "../type-checks.js";
import { closureFreeFunctionSource } from "./format-source.js";

export const REFERENCE_FORMATS: Readonly<Record<string, string>> = {
  keyword: "keywordFormat", url: "urlFormat", email: "emailFormat", date: "dateFormat", month: "monthFormat",
  week: "weekFormat", time: "timeFormat", "datetime-local": "datetimeLocalFormat", datetime: "datetimeFormat",
  color: "colorFormat", "color-hex": "colorHexFormat", length: "lengthFormat", percentage: "percentageFormat", duration: "durationFormat",
};

/** Serialize the same scalar predicates native output uses; individual exports remain tree-shakable. */
export function referencePredicatesSource(names?: ReadonlySet<string>): string {
  const functions: Readonly<Record<string, (value: string) => boolean>> = {
    functionalColor: formats.functionalColor, keywordFormat: formats.keywordFormat, urlFormat: formats.urlFormat,
    dateFormat: formats.dateFormat, monthFormat: formats.monthFormat,
    weekFormat: formats.weekFormat, timeFormat: formats.timeFormat, colorHexFormat: formats.colorHexFormat,
    lengthFormat: formats.lengthFormat, percentageFormat: formats.percentageFormat, durationFormat: formats.durationFormat,
  };
  const wanted = names === undefined ? new Set([...Object.keys(functions), "emailFormat", "datetimeFormat", "datetimeLocalFormat", "colorFormat", "referenceEvent", "referenceTrusted"]) : new Set(names);
  if (wanted.has("colorFormat")) { wanted.add("functionalColor"); wanted.add("colorHexFormat"); }
  if (wanted.has("datetimeFormat") || wanted.has("datetimeLocalFormat")) { wanted.add("dateFormat"); wanted.add("timeFormat"); }
  const result: string[] = [];
  const factory = (create: { toString(): string }, name: string, args: string): void => {
    const binding = `create${name[0]!.toUpperCase()}${name.slice(1)}`;
    const source = closureFreeFunctionSource(create, binding);
    result.push(/^function\b/.test(source.trimStart()) ? source : `const ${binding} = ${source.trimEnd().replace(/;$/, "")};`,
      `export const ${name} = /* @__PURE__ */ ${binding}(${args});`);
  };
  if (wanted.has("emailFormat")) factory(formats.createEmailFormat, "emailFormat", formats.HTML_EMAIL_PATTERN.toString());
  if (wanted.has("referenceEvent")) factory(createEventCheck, "referenceEvent", "");
  if (wanted.has("referenceTrusted")) result.push(closureFreeFunctionSource(browserTrusted, "referenceTrusted"));
  for (const [name, predicate] of Object.entries(functions)) {
    if (!wanted.has(name)) continue;
    const source = closureFreeFunctionSource(predicate, name);
    result.push(/^function\b/.test(source.trimStart()) ? source : `export const ${name} = ${source.trimEnd().replace(/;$/, "")};`);
  }
  if (wanted.has("colorFormat")) factory(formats.createColorFormat, "colorFormat", `${JSON.stringify(CSS_COLOR_KEYWORDS)}, colorHexFormat, functionalColor`);
  if (wanted.has("datetimeFormat")) factory(formats.createDatetimeFormat, "datetimeFormat", "dateFormat, timeFormat");
  if (wanted.has("datetimeLocalFormat")) factory(formats.createDatetimeLocalFormat, "datetimeLocalFormat", "dateFormat, timeFormat");
  return result.join("\n\n");
}
