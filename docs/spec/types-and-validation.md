# Types and validation

HTML Next types define parsing, serialization, comparison, framework projection, and validation at declared boundaries. Resemblance to CSS value-definition syntax is only a familiarity aid; the grammar below is defined independently.

## Type grammar

The scalar terminals are `string`, `boolean`, `number`, `integer`, and `null`. Web-value terminals include the native input value spaces (`email`, `url`, date/time families, color), token and identifier forms, URL values, and trusted content types. A quoted or bare keyword denotes exactly that keyword.

`A | B` is a union. `list(T)` is an ordered list of `T`. `record(T)` is a string-keyed record whose values are `T`. `object({ name: T, optional?: U })` is a closed structured value unless marked open. `T?` is `T | null | absent`. Parentheses group. Whitespace outside strings is insignificant.

Parsing returns either a canonical typed value or one or more issues with stable reason names and structured paths. Serialization is defined per terminal and never relies on JavaScript's implicit coercion. Framework TypeScript projections preserve union, nullability, list, record, object, and property-only trusted/callable boundaries.

## Native constraints

Native controls retain the HTML constraint-validation rules that apply to their element and input type. This includes requiredness; email and URL syntax; text length and pattern; numeric and date/time range and step; type mismatch; bad input; and custom validity. Inapplicable constraints remain inapplicable.

The official HTML Next library delegates to a native control's `checkValidity()`, `reportValidity()`, `setCustomValidity()`, `validity`, and form-submission behavior wherever the platform supplies them. It does not replace working browser validation with a smaller imitation.

## Generalized validity

Managed non-control elements may declare the same constraints or a richer HTML Next type/schema. They expose a native-shaped validity object, validation message, `checkValidity()`, `reportValidity()`, and `setCustomValidity()` plus typed issues with paths. `invalid` is dispatched with native-compatible cancellation behavior. Form-associated custom elements use `ElementInternals` when available; other managed elements participate through the official runtime's form traversal.

Derived issues and explicitly set custom issues have separate lifetimes. Revalidation follows value changes. Interaction state begins untouched, advances through user input/blur or explicit reporting as defined by the control, and resets with the owning form.

Open reason names include native-compatible `valueMissing`, `typeMismatch`, `patternMismatch`, `tooLong`, `tooShort`, `rangeUnderflow`, `rangeOverflow`, `stepMismatch`, `badInput`, and `customError`, plus typed/schema reasons that retain paths.

## Validity selectors

Authors use `:valid`, `:invalid`, and `:user-invalid`. They do not author a polyfill-specific selector. For native controls the browser owns those states. For other managed elements the official runtime mirrors the states internally and rewrites readable authored styles or generated CSS so the same selectors work.

Selector transformation must handle nested grouping rules, selector functions, dynamically added styles, and constructed stylesheets. An inaccessible cross-origin stylesheet cannot be rewritten by script; generated/package CSS must therefore be transformed ahead of time, and the runtime reports an actionable diagnostic when live author CSS cannot be mirrored.
