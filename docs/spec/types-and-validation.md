# Types and validation

HTML Next types define parsing, serialization, comparison, TypeScript projection, and
validation at declared boundaries. They are used by component properties, data responses,
bound values, and generalized validation. The grammar is deliberately small enough to parse
without JavaScript execution.

CSS value-definition syntax is relevant prior art, not an imported grammar. HTML Next uses
the familiar ideas of named value spaces, keyword alternatives, and whole-value parsing, but
defines every accepted production below. Implementations must not accept an unlisted CSS
production merely because a CSS parser would accept it.

Normative platform behavior and compatibility-library behavior are separated throughout this
module. The proposal does not require `@nextwebwg/html`; the library implements the proposed
surface while browsers do not yet provide it.

## Type grammar

The following grammar is complete. Whitespace is insignificant except inside a quoted keyword
and inside a value being parsed as `string`. A parser must consume the complete type expression.

```text
type          = union [ "?" ]
union         = primary *( "|" primary )
primary       = terminal
              | keyword
              | "(" type ")"
              | "list(" type ")"
              | "record(" type ")"
              | "object(" object-shape ")"
object-shape  = "{" [ member *( "," member ) [ "," ] ] "}"
member        = field-name [ "?" ] ":" type
              | "..."
field-name    = identifier | quoted-string
keyword       = identifier | quoted-string
```

`?` adds both `null` and the absence of a value to the preceding type. Thus `email?` is
equivalent to `email | null | absent`. A `?` after an object field name makes that field
optional; it does not change the field's value type. `...` must be the last member and makes
an object shape open. Without it, the object is closed and undeclared fields are errors.

A bare identifier matching a terminal name selects that terminal. Any other bare or quoted
identifier is a literal string keyword. Quoting is required when a keyword contains whitespace
or punctuation that would otherwise be grammar. Duplicate object fields and an `...` member
that is not last are syntax errors.

Examples of canonical expressions include `outline | solid | ghost`, `list(email)`,
`record(number)`, `object({ id: integer, label?: string })`, and
`object({ id: integer, ... })`. The expected outcome of parsing each is, respectively: a
three-keyword union; a list of valid email strings; a string-keyed numeric record; a closed
object with one required and one optional field; and an open object with a required `id`.

## Terminal types

| Terminal | Accepted input | Canonical value | Serialization |
| --- | --- | --- | --- |
| `string` | a string | the same string | unchanged |
| `boolean` | a boolean, `true`, `false`, or an empty present boolean attribute | a boolean | `true` or `false`; a boolean attribute uses presence/absence |
| `number` | a finite number or complete finite-number string | a number | base-10 number text |
| `integer` | a finite integer or complete integer string | a number with no fractional part | base-10 integer text |
| `null` | `null` | `null` | `null` |
| `absent` | no supplied value | absence | no attribute/value |
| `email` | one HTML email-address value | the address string | unchanged |
| `url` | an absolute URL | its parsed absolute URL serialization | URL serialization |
| `date` | a valid `YYYY-MM-DD` HTML date string | the same string | unchanged |
| `time` | a valid HTML time string | the same string | unchanged |
| `datetime-local` | a valid local date and time joined by `T` | the same string | unchanged |
| `month` | a valid `YYYY-MM` HTML month string | the same string | unchanged |
| `week` | a valid ISO week string such as `2020-W53` | the same string | unchanged |
| `color` | a six-digit simple-color string | lowercase `#rrggbb` | the canonical color |
| `token` | one non-empty string containing no HTML space | the same token | unchanged |
| `ident` | an identifier, including a custom identifier beginning `--` | the same identifier | unchanged |
| `url-value` | one non-empty, control-character-free URL value | the same string | unchanged |
| `token-list` | a space-separated string or string array of tokens | an ordered string array | tokens joined by one space |
| `trusted-html` | a platform `TrustedHTML` or explicitly branded host equivalent | the trusted value | never implicitly stringified into an attribute |
| `trusted-script` | a platform `TrustedScript` or explicitly branded host equivalent | the trusted value | never implicitly stringified into an attribute |

The `email`, `url`, `date`, `time`, `datetime-local`, `month`, `week`, `number`, and `color`
spaces intentionally follow HTML input value spaces. `multiple` changes an `email` boundary
from one address to a comma-separated ordered list. It does not change unrelated terminals.

`color` is the HTML simple-color value space used by `input[type=color]`; it is not the full CSS
`<color>` grammar. `url` is an HTML absolute URL string; `url-value` is the serializable URL
value used where a later URL-resolution step has a base. These distinctions prevent the phrase
“web-native type” from hiding different parsers behind one name.

The CSS Working Group's [value-definition syntax](https://www.w3.org/TR/css-values-4/#value-defs),
[component value types](https://www.w3.org/TR/css-values-4/#component-types), and
[CSS Typed OM](https://www.w3.org/TR/css-typed-om-1/#stylevalue-objects) explain the related CSS
model. MDN provides practical indexes for [CSS data types](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/Data_types)
and [CSS value-definition syntax](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Values_and_units/Value_definition_syntax).
Those sources do not extend the terminal table above.

## Keywords, unions, and selection

A keyword accepts exactly its string value. A union tries its members in source order and
returns the first successful canonical value. If no member accepts the input, the boundary has
one `typeMismatch` issue for the union rather than an unstable collection of speculative branch
errors. Repeating a semantically identical union member has no effect on the canonical type.

Keyword values are strings even when written bare in a type expression. This differs from an
HTML Next runtime expression, where a bare identifier reads a declared binding and quotes make
a string literal.

## Collection and structured types

`list(T)` accepts an array and parses each item as `T`. `record(T)` accepts a plain object and
parses every own string-keyed value as `T`. `object({ ... })` accepts a plain object and parses
each declared field with its field type. Collections arriving through an attribute or network
text boundary use JSON; they are never parsed through JavaScript object-literal syntax and are
never serialized with implicit `String(object)` coercion.

A closed object reports every unknown own field. An open object preserves unknown fields without
claiming a type for them. A missing required field reports `schemaMismatch`; an optional field is
omitted from the canonical value. Parsing continues after a member failure, so one result can
identify every invalid path.

Paths begin at `$`, use `.name` for identifier keys, bracketed JSON strings for other keys, and
zero-based brackets for list positions. For example, a bad second tag and absent account email
produce `$.tags[1]` and `$.account.email`. Paths are stable across runtimes and generated targets.

## Typed result and serialization

Parsing returns either `{ ok: true, value }` or `{ ok: false, issues }`. Each issue has a stable
`reason`, human-readable `message`, and `path`. The type-layer reasons are `typeMismatch`,
`badInput`, `schemaMismatch`, and `untrustedValue`. Validation maps them into the richer validity
model below without losing their paths.

Serialization first validates and canonicalizes. Scalars use the terminal rule above;
`token-list` joins with one HTML space; and list, record, and object values use JSON. Trusted
content is property-only. A serializer must reject an invalid value rather than silently coerce
it.

TypeScript projections are mechanical: strings and web string spaces project to `string`;
numeric terminals to `number`; keywords to string literals; unions to TypeScript unions;
`list(T)` to `readonly T[]`; `record(T)` to `Readonly<Record<string, T>>`; and object shapes to
readonly object properties. `null` and `absent` project to `null` and `undefined`. Trusted types
project to their corresponding Trusted Types interfaces.

## Native constraints

Native controls retain the browser's Constraint Validation API. The reference library asks the
browser for native validity; it does not replace the browser's email, URL, number, or date/time
algorithms with a smaller imitation. This includes submission blocking and the browser's rules
for controls barred from constraint validation.

| Constraint | Applicable value spaces | Failure reason |
| --- | --- | --- |
| `required` | every boundary with a defined empty state | `valueMissing` |
| `multiple` | email and list-valued native controls | changes parsing cardinality |
| `pattern` | string, email, URL, and token-like strings | `patternMismatch` |
| `minlength` | string-valued boundaries | `tooShort` |
| `maxlength` | string-valued boundaries | `tooLong` |
| `min` | number, integer, date, time, datetime-local, month, and week | `rangeUnderflow` |
| `max` | the same ordered value spaces | `rangeOverflow` |
| `step` | the same ordered value spaces | `stepMismatch` |

An empty optional value is valid and no remaining constraint applies. `false` and `0` are not
empty. Invalid or inapplicable constraint attributes do not invent a failure. Pattern matching
is anchored to the complete string. Numeric step uses `min` as its base when present and zero
otherwise; date/time families use their corresponding HTML units.

The authoritative platform algorithms are in WHATWG HTML's
[Constraint Validation API](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#the-constraint-validation-api)
and [input-type sections](https://html.spec.whatwg.org/multipage/input.html). MDN documents the
[Constraint Validation API](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Constraint_validation)
and the practical behavior of [`ValidityState`](https://developer.mozilla.org/en-US/docs/Web/API/ValidityState).

## Generalized validity

The platform proposal makes a native-shaped validity surface available to any managed element:

- `validity` exposes `valid`, the native reason flags, extension flags, and the complete ordered
  `errors` list;
- `validationMessage` is empty when valid and otherwise contains the first issue's message;
- `checkValidity()` recomputes and dispatches a cancelable `invalid` event when invalid;
- `reportValidity()` also marks the element as interacted and permits a user agent to present UI;
- `validate()` explicitly recomputes, returns the rich result, marks interaction, and dispatches
  `invalid` when invalid; and
- `setValidity(errors)` supplies or clears issues that cannot be derived from the declared type,
  such as a server rejection.

Derived issues and `setValidity()` issues occupy independent channels. Revalidation replaces only
derived issues. `setValidity()` with no arguments clears only externally supplied issues. This is
why a valid edit does not accidentally erase an asynchronous server error, and why clearing a
server error does not discard a current type failure.

The open validity reasons are `valueMissing`, `typeMismatch`, `patternMismatch`, `tooLong`,
`tooShort`, `rangeUnderflow`, `rangeOverflow`, `stepMismatch`, `badInput`, `schemaMismatch`, and
`untrustedValue`. `customError` exists only when interoperating with the legacy closed native
flag set through `setCustomValidity()`; HTML Next callers use a meaningful external reason with
`setValidity()`.

Validity is current from the moment an element is managed. Interaction state is separate:
`:invalid` may match immediately, while `:user-invalid` begins false, becomes eligible after
input, change, blur, explicit reporting, or a submission attempt, and clears after a valid edit.
Form reset returns interaction state to untouched and recomputes derived validity. It does not
silently erase an independently supplied external issue.

Form submission traverses managed non-control elements as well as native successful controls.
Any invalid member receives `invalid`, submission is prevented, and focus moves to the first
focusable invalid member. Native controls continue participating through the browser's own form
algorithm. Form-associated custom elements delegate to `ElementInternals.setValidity()`.

## Reference-library adaptation

The official `@nextwebwg/html` library exports the pure type parser/serializer and validator as
well as the DOM adapter. Inside managed component roots it installs non-enumerable compatibility
members only where the browser has no native member. Native controls remain authoritative and
receive `setCustomValidity()` only when an HTML Next-derived or external issue must bridge into
native form submission. Form-associated custom elements use `ElementInternals`. Ordinary
elements receive the proposed facade plus the appropriate `aria-invalid` signal.

## Validity selectors

Authors write `:valid`, `:invalid`, and `:user-invalid`; they do not target internal attributes.
The library mirrors those states only for ordinary elements and transforms authored selectors to
match either the native pseudo-class or the internal state. The transformation covers selector
functions, CSS nesting, grouping at-rules, inline and dynamically inserted styles, constructed
stylesheets, and generated package CSS. Same-origin external styles are mirrored after load.

Script cannot read a cross-origin stylesheet whose CSSOM is blocked by the same-origin policy.
The live adapter emits diagnostic `HV001` for that case; the package compiler transforms such CSS
ahead of time. This is a packaging boundary, not work delegated to the application author. When
browsers expose generalized validity directly, the internal state and selector transform disappear
without changing authored component markup or CSS.

The proposed pseudo-class behavior follows Selectors Level 4's
[validity pseudo-classes](https://www.w3.org/TR/selectors-4/#validity-pseudos). The accessibility
bridge follows WAI-ARIA's [`aria-invalid`](https://www.w3.org/TR/wai-aria-1.2/#aria-invalid), and
the custom-element bridge follows HTML's
[`ElementInternals.setValidity()`](https://html.spec.whatwg.org/multipage/custom-elements.html#dom-elementinternals-setvalidity).
