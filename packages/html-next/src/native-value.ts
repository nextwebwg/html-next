/** React's server representation of inert native value attributes. */
export const NATIVE_VALUE_ATTRIBUTE = "data-html-next-native-value";

/** Rewrite attribute reads without changing strings, comments, types or authored fallbacks. */
export function nativeValueCss(value: string, attribute: string, fallback = false): string {
  const identifier = /^(?:[-_a-zA-Z0-9\u0080-\uffff]|\\(?:[0-9a-fA-F]{1,6}[ \t\r\n\f]?|[^\r\n\f]))+/;
  const decode = (name: string): string => name.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([^\r\n\f])/g,
    (_match, hex: string | undefined, character: string | undefined) => {
      if (hex === undefined) return character!;
      const point = Number.parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\ufffd";
    }).toLowerCase();
  let result = "";
  for (let index = 0; index < value.length;) {
    const start = index;
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2); index = end === -1 ? value.length : end + 2;
    } else if (value[index] === '"' || value[index] === "'") {
      const quote = value[index++];
      while (index < value.length) { if (value[index++] === "\\") index++; else if (value[index - 1] === quote) break; }
    } else {
      const name = identifier.exec(value.slice(index))?.[0];
      if (name === undefined) { index++; result += value.slice(start, index); continue; }
      index += name.length;
      if (decode(name) === "attr" && value[index] === "(") {
        let at = index + 1;
        for (;;) {
          while (at < value.length && /\s/.test(value[at]!)) at++;
          if (!value.startsWith("/*", at)) break;
          const end = value.indexOf("*/", at + 2); at = end === -1 ? value.length : end + 2;
        }
        if (value.startsWith("*|", at)) at += 2; else if (value[at] === "|") at++;
        const property = identifier.exec(value.slice(at))?.[0];
        if (property !== undefined && decode(property) === "value" && /^(?:\s|\/\*|[,)]|$)/.test(value.slice(at + property.length))) {
          if (!fallback) {
            result += value.slice(start, at) + attribute;
            index = at + property.length; continue;
          }
          let end = at + property.length, depth = 0, comma = -1;
          for (; end < value.length; end++) {
            const character = value[end];
            if (value.startsWith("/*", end)) { const close = value.indexOf("*/", end + 2); end = close < 0 ? value.length : close + 1; }
            else if (character === '"' || character === "'") {
              const quote = character;
              while (++end < value.length) { if (value[end] === "\\") end++; else if (value[end] === quote) break; }
            } else if (character === "(") depth++;
            else if (character === ")") { if (depth === 0) break; depth--; }
            else if (character === "," && depth === 0 && comma === -1) comma = end;
          }
          if (end < value.length) {
            const tail = value.slice(at + property.length, comma < 0 ? end : comma);
            const alternative = comma < 0 ? "" : value.slice(comma + 1, end).trim();
            if (alternative.startsWith("attr(" + attribute)) { result += value.slice(start, end + 1); index = end + 1; continue; }
            const suffix = alternative === "" ? "" : ", " + alternative;
            result += value.slice(start, at + property.length) + tail + ", attr(" + attribute + tail + suffix + "))";
            index = end + 1; continue;
          }
        }
      }
    }
    result += value.slice(start, index);
  }
  return result;
}
