// ponytail: skips comments, strings, and custom property values, the places a pseudo-class name
// can appear outside a selector; an unquoted url() holding one would still be rewritten.
const VALIDITY = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|--[\w-]+\s*:[^;{}]*|:(user-invalid|invalid|valid)(?![\w-])/g;

/**
 * Add the internal state mirrors that let authors use the proposed `:valid` and `:invalid`
 * surface before browsers expose those pseudo-classes on arbitrary elements. Only selectors change.
 */
export function rewriteValiditySelectors(css: string): string {
  return css.replace(VALIDITY, (match, name: string | undefined) => name === undefined ? match : `:is(:${name}, [data-${name}])`);
}
