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

`?` adds both `null` and the absence of a value to the preceding type. Thus `string?` is
equivalent to `string | null | absent`. A `?` after an object field name makes that field
optional; it does not change the field's value type. `...` must be the last member and makes
an object shape open. Without it, the object is closed and undeclared fields are errors.

A bare identifier matching a terminal name selects that terminal. Any other bare or quoted
identifier is a literal string keyword. Quoting is required when a keyword contains whitespace
or punctuation that would otherwise be grammar. Duplicate object fields and an `...` member
that is not last are syntax errors.

Examples of canonical expressions include `outline | solid | ghost`, `list(string)`,
`record(number)`, `object({ id: integer, label?: string })`, and
`object({ id: integer, ... })`. The expected outcome of parsing each is, respectively: a
three-keyword union; a list of strings; a string-keyed numeric record; a closed
object with one required and one optional field; and an open object with a required `id`.

## Invocation attribute parsing

An attribute on a component invocation is HTML source text. Before the component receives that
value, the user agent must parse it through the invoked property's declared type and expose the
resulting canonical value. The declaration therefore gives a component attribute the same kind
of defined value semantics that native HTML controls give their content attributes; individual
components must not each reimplement string coercion.

This rule applies at the page boundary. The `:` prefix is template expression-binding syntax and
is not required on an invocation. Given a property declared as `boolean`, all of the following are
well-typed invocations: a bare attribute has the canonical value `true`, `enabled="true"` has the
canonical value `true`, and `enabled="false"` has the canonical value `false`. Omitting the
attribute supplies no invocation value, so the property's declared default or absence semantics
apply. A non-empty value other than `true` or `false` is a type error; it does not become true by
presence alone.

Number and integer attributes are likewise parsed from their complete strings. Keyword unions
select their matching declared string value. Structured and callable types remain property-only
unless another section explicitly defines a text encoding. Ahead-of-time targets and the live
browser runtime must produce the same canonical value for the same invocation.

## Terminal types

| Terminal | Accepted input | Canonical value | Serialization |
| --- | --- | --- | --- |
| `string` | a string | the same string | unchanged |
| `boolean` | a boolean, `true`, `false`, or an empty present boolean attribute | a boolean | `true` or `false`; a boolean attribute uses presence/absence |
| `number` | a finite number or complete finite-number string | a number | base-10 number text |
| `integer` | a finite integer or complete integer string | a number with no fractional part | base-10 integer text |
| `null` | `null` | `null` | `null` |
| `absent` | no supplied value | absence | no attribute/value |
| `trusted-html` | a platform `TrustedHTML` or explicitly branded host equivalent | the trusted value | never implicitly stringified into an attribute |
| `trusted-script` | a platform `TrustedScript` or explicitly branded host equivalent | the trusted value | never implicitly stringified into an attribute |
| `function` | a JavaScript callable supplied through a property | the same callable | property-only; serialization is an error |
| `unknown` | any JavaScript value supplied through a property | the same value | property-only; serialization is an error |

Formats such as email addresses, URLs, dates, colors, identifiers, and token lists are not
component-contract terminals. A component declares their representation as `string` or a
structured type and puts format constraints on the native control that owns the value. Domain
validation and coercion can instead be supplied by an application adapter. This avoids embedding
a second implementation of browser and application value spaces in every live component loader.

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
claiming a type for them. A missing required field reports `typeMismatch`; an optional field is
omitted from the canonical value. Parsing continues after a member failure, so one result can
identify every invalid path.

Paths begin at `$`, use `.name` for identifier keys, bracketed JSON strings for other keys, and
zero-based brackets for list positions. For example, a bad second tag and absent account name
produce `$.tags[1]` and `$.account.name`. Paths are stable across runtimes and generated targets.

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
`badInput`, and `untrustedValue`.

Serialization first validates and canonicalizes. Scalars use the terminal rule above; list,
record, and object values use JSON. Trusted
content is property-only. A serializer must reject an invalid value rather than silently coerce
it.

TypeScript projections are mechanical: strings project to `string`;
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
