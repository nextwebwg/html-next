/**
 * Declared string formats, one validator each, shared by the type system and by generated output,
 * which imports only those its declared types use. Prop parsing also runs in Node during builds and
 * SSR, so the color subset stays the same in every environment rather than accepting browser-only
 * CSS forms during hydration.
 */

import { CSS_COLOR_KEYWORDS } from "./css-color-keywords.js";

export const HTML_EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/?=^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function dateFormat(value: string): boolean {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const date = new Date(0);
  date.setUTCFullYear(year, Number(match[2]) - 1, Number(match[3]));
  return date.getUTCFullYear() === year && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

export function timeFormat(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
}

function functionalColor(value: string): boolean {
  const match = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/i.exec(value);
  if (match === null) return false;
  const body = match[2]!.trim();
  const parts = body.replaceAll(",", " ").replaceAll("/", " ").split(/\s+/);
  const colorSpace = match[1]!.toLowerCase() === "color";
  if (colorSpace && !/^(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)$/.test(parts.shift() ?? "")) return false;
  if (parts.length < 3 || parts.length > 4) return false;
  if (parts.length === 4 && !body.includes("/") && !body.includes(",")) return false;
  return parts.every((part) => part === "none" || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|deg|rad|grad|turn)?$/.test(part));
}

export const keywordFormat = (value: string): boolean => /^[A-Za-z0-9_-]+$/.test(value);

export function urlFormat(value: string): boolean {
  try { return new URL(value).protocol !== ""; } catch { return false; }
}

export const emailFormat = (value: string): boolean => HTML_EMAIL_PATTERN.test(value);

export const monthFormat = (value: string): boolean => /^(?!0000)\d{4,}-(?:0[1-9]|1[0-2])$/.test(value);

export function weekFormat(value: string): boolean {
  const match = /^(\d{4,})-W(\d{2})$/.exec(value);
  if (match === null || match[1] === "0000") return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan1 = new Date(0);
  jan1.setUTCFullYear(year, 0, 1);
  const jan1Day = jan1.getUTCDay();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return week >= 1 && (week < 53 || (week === 53 && (jan1Day === 4 || (jan1Day === 3 && leap))));
}

export function datetimeLocalFormat(value: string): boolean {
  const match = /^(\d{4,}-\d{2}-\d{2})[T ](.+)$/.exec(value);
  return match !== null && dateFormat(match[1]!) && timeFormat(match[2]!);
}

export function datetimeFormat(value: string): boolean {
  const match = /^(\d{4,}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.exec(value);
  return match !== null && dateFormat(match[1]!) && timeFormat(match[2]!);
}

export const colorHexFormat = (value: string): boolean => /^#[\da-fA-F]{3}(?:[\da-fA-F]{1}|[\da-fA-F]{3}(?:[\da-fA-F]{2})?)?$/.test(value);

let namedColors: Set<string> | undefined;
export const colorFormat = (value: string): boolean => colorHexFormat(value) ||
  (namedColors ??= new Set<string>(CSS_COLOR_KEYWORDS)).has(value.toLowerCase()) || functionalColor(value);

export const lengthFormat = (value: string): boolean =>
  /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc|q)$/.test(value) || value === "0";
export const percentageFormat = (value: string): boolean => /^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value);
export const durationFormat = (value: string): boolean => /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/.test(value);
