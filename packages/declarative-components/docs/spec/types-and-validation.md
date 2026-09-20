# Types and validation

HTML Next types define parsing, serialization, comparison, TypeScript projection, and
validation at declared component boundaries. They are used by component properties,
event payloads, and other explicitly typed contract values. The grammar is deliberately small enough to parse
without JavaScript execution.

CSS value-definition syntax is relevant prior art, not an imported grammar. HTML Next uses
the familiar ideas of named value spaces, keyword alternatives, and whole-value parsing, but
defines every accepted production below. Implementations must not accept an unlisted CSS
production merely because a CSS parser would accept it.

Normative platform behavior and compatibility-library behavior are separated throughout this
module. The proposal does not require `@nextwebwg/declarative-components`; the library implements the proposed
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
| `function` | a JavaScript callable supplied through a property | the same callable | property-only; serialization is an error |
| `unknown` | any JavaScript value supplied through a property | the same value | property-only; serialization is an error |

The `email`, `url`, `date`, `time`, `datetime-local`, `month`, `week`, `number`, and `color`
spaces intentionally follow HTML input value spaces. `multiple` changes an `email` boundary
from one address to a comma-separated ordered list. It does not change unrelated terminals.

`color` is the HTML simple-color value space used by `input[type=color]`; it is not the full CSS
`<color>` grammar. `url` is an HTML absolute URL string; `url-value` is the serializable URL
value used where a later URL-resolution step has a base. These distinctions prevent the phrase
“web-native type” from hiding different parsers behind one name.

`function` is the explicit callback or provider boundary. `unknown` is an escape hatch for a
package type whose shape is owned by a separately published TypeScript contract. Both are
property-only: a definition must bind them with `.property`, and tools must never encode them
into markup. Authors should prefer a structural HTML Next type when the complete shape belongs
to the component contract; `unknown` deliberately makes no validation claim.

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

## Data validation and coercion

The Declarative Components proposal does not define a response-schema language or fetch schema
resources. Data decoding produces the transport value. An application or adapter may validate,
coerce, or project that value before publishing it, and a rejected adaptation must not publish a
value. JSON Schema, generated clients, application validators, and domain codecs are adapter
choices rather than transitive requirements of every component runtime.

The reference library exposes this boundary as `DataResource`'s `adapt` callback. Build tools may
compile a chosen schema or type description into an adapter, but the live component loader does
not interpret or fetch that description.

## Typed result and serialization

Parsing returns either `{ ok: true, value }` or `{ ok: false, issues }`. Each issue has a stable
`reason`, human-readable `message`, and `path`. The type-layer reasons are `typeMismatch`,
`badInput`, `schemaMismatch`, and `untrustedValue`.

Serialization first validates and canonicalizes. Scalars use the terminal rule above;
`token-list` joins with one HTML space; and list, record, and object values use JSON. Trusted
content is property-only. A serializer must reject an invalid value rather than silently coerce
it.

TypeScript projections are mechanical: strings and web string spaces project to `string`;
numeric terminals to `number`; `function` to a callable of unknown arguments and result;
`unknown` to `unknown`; keywords to string literals; unions to TypeScript unions;
`list(T)` to `readonly T[]`; `record(T)` to `Readonly<Record<string, T>>`; and object shapes to
readonly object properties. `null` and `absent` project to `null` and `undefined`. Trusted types
project to their corresponding Trusted Types interfaces.

## Native form validation

Native controls retain the browser's Constraint Validation API. The component runtime leaves
their `type`, `required`, `multiple`, `pattern`, length, range, and step behavior to the browser,
including submission blocking and the rules for controls barred from constraint validation.
It does not scan component DOM, duplicate native results, or install validation methods on
ordinary elements.

A component that needs native form participation authors a native control or uses a
form-associated custom element with `ElementInternals`. Application validation that is not part
of a declared component type remains an adapter concern; it may call the platform's
`setCustomValidity()` or `ElementInternals.setValidity()` APIs when it needs to affect form
submission.

The authoritative platform algorithms are in WHATWG HTML's
[Constraint Validation API](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#the-constraint-validation-api)
and [input-type sections](https://html.spec.whatwg.org/multipage/input.html). MDN documents the
[Constraint Validation API](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Constraint_validation)
and the practical behavior of [`ValidityState`](https://developer.mozilla.org/en-US/docs/Web/API/ValidityState).

The reference package may expose opt-in validation utilities for applications that want a common
result shape. Those utilities are not installed by the component runtime and are not part of the
Declarative Components contract.
