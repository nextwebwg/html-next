/**
 * Number arithmetic as HTML Next expressions calculate it. `+`, `-`, `*` and `%` work on each
 * operand's decimal value, so `add(1.1, 0.1)` is `1.2`, the value `<input type=number step=0.1>`
 * steps to, not JavaScript's `1.2000000000000002`. `/` keeps full double precision: `1 / 3` has no
 * decimal result. https://nextwebwg.org/declarative-components/expressions#decimal-arithmetic
 *
 * The expression evaluator and compiled components call these functions, and converted Vue, React
 * and Svelte components carry this source (`scripts/generate-literal-source.ts` copies it), so
 * controller code that imports them computes what an expression would. Each is a separate pure
 * export, so a bundle keeps only the operations its expressions use. They never throw: a NaN or
 * infinite operand or result, such as `divide(1, 0)`, comes back as the double result, which an
 * expression then treats as invalid.
 */

/**
 * Digits after the point in `value`'s shortest round-trip text, as `Number#toString` writes it:
 * 2 for 1.25, 7 for 1e-7, and 0 for an integer, 1e21, NaN or Infinity. Writing that text made an
 * addition about ten times slower (200 ns against 20 ns), so up to 22 places, where 10^places is
 * exact, the fewest places at which `value` survives rounding stand in for it. That count is never
 * below the text's, and differs only for a value of more than 15 significant digits, which
 * `decimalResult` leaves as a double either way.
 */
function decimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  for (let places = 1; places <= 22; places += 1) {
    if (Math.round(value * 10 ** places) / 10 ** places === value) return places;
  }
  const [digits, exponent] = String(value).split("e");
  const point = digits!.indexOf(".");
  return Math.max(0, (point < 0 ? 0 : digits!.length - point - 1) - Number(exponent ?? 0));
}

/**
 * The double nearest the exact decimal result: `a` and `b` become integers at `left` and `right`
 * places, `combine` joins them, and the integer is read back at `places`. Every step is exact while
 * the operands and `result` stay below 10^15 at `places`, the 15 significant digits a double always
 * holds; past that (or for a non-finite value, or with no places) the double `result` stands.
 * Dividing by 10^places is exact only up to 10^22, so past 22 places a nonzero integer is read back
 * by parsing its decimal text, which rounds exactly too. A zero divides, keeping its sign.
 */
function decimalResult(result: number, a: number, b: number, left: number, right: number, places: number,
  combine: (a: number, b: number) => number): number {
  if (!(places > 0 && Math.max(Math.abs(a), Math.abs(b), Math.abs(result)) * 10 ** places < 1e15)) return result;
  const integer = combine(Math.round(a * 10 ** left), Math.round(b * 10 ** right));
  return places > 22 && integer !== 0 ? Number(`${integer}e-${places}`) : integer / 10 ** places;
}

/** `a + b` at the larger operand's decimal places: `add(0.1, 0.2)` is 0.3. */
export function add(a: number, b: number): number {
  const places = Math.max(decimalPlaces(a), decimalPlaces(b));
  return decimalResult(a + b, a, b, places, places, places, (x, y) => x + y);
}

/** `a - b` at the larger operand's decimal places: `subtract(0.3, 0.1)` is 0.2. */
export function subtract(a: number, b: number): number {
  const places = Math.max(decimalPlaces(a), decimalPlaces(b));
  return decimalResult(a - b, a, b, places, places, places, (x, y) => x - y);
}

/** `a * b` at the sum of the operands' decimal places: `multiply(0.1, 0.2)` is 0.02. */
export function multiply(a: number, b: number): number {
  const left = decimalPlaces(a);
  const right = decimalPlaces(b);
  return decimalResult(a * b, a, b, left, right, left + right, (x, y) => x * y);
}

/** `a / b` at full double precision: `divide(1, 3)` is 0.3333333333333333 and `divide(1, 0)` is Infinity. */
export function divide(a: number, b: number): number {
  return a / b;
}

/**
 * `a % b` at the larger operand's decimal places, with the dividend's sign as JavaScript's `%`:
 * `remainder(0.3, 0.1)` is 0, where JavaScript gives 0.09999999999999998.
 */
export function remainder(a: number, b: number): number {
  const places = Math.max(decimalPlaces(a), decimalPlaces(b));
  return decimalResult(a % b, a, b, places, places, places, (x, y) => x % y);
}
