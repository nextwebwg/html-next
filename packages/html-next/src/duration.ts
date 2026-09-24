/**
 * Time values for declarations such as `<data debounce>` and `<data poll>`.
 *
 * Authors write CSS-style time values (`200ms`, `0.2s`), matching how the proposal spells them. A
 * bare number is milliseconds, so existing `debounce="150"` keeps working. Returning `undefined`
 * for anything else lets callers raise their own diagnostic instead of silently treating an
 * unreadable value as "no delay", which is what `Number("200ms")` used to do.
 */
export function parseDuration(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match[2] === "s" ? amount * 1000 : amount;
}
