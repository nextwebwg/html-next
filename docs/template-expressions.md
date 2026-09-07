# Template expressions

Status: initial proposal for discussion
Last updated: 2026-09-06

HTML7 needs expressions for conditional templates, iteration, computed values, bound
component properties, data-source parameters, and text output. Those expressions should
not require JavaScript or expose arbitrary JavaScript execution.

## Goals

- Remain small enough to parse, type-check, and interpret consistently.
- Work identically in the browser runtime and ahead-of-time compilers.
- Expose only explicitly declared props, state, data, imports, and template locals.
- Make reactive dependencies statically discoverable where practical.
- Operate under strict Content Security Policy without `eval()` or `new Function()`.
- Preserve ordinary HTML parsing by keeping expressions in quoted attribute values.
- Provide useful formatting and transformations through registered pure filters.

## Non-goals

- General-purpose JavaScript in templates.
- Assignments, mutation, statements, or side effects.
- Arbitrary function and method calls.
- Constructors, classes, lambdas, or user-defined imperative control flow.
- Implicit access to `window`, `document`, network APIs, or other ambient globals.
- Replacing explicit HTML7 control-flow and data-source elements with clever expressions.

## Relationship to prior art

Liquid is one prior-art input, not the model HTML7 is expected to copy. Shopify Liquid
demonstrates that a useful template language can be built from objects, control-flow
tags, comparisons, and filter pipelines without embedding a general-purpose programming
language.

Squarespace's JSON-T is a separate and equally relevant input. It pairs a deliberately
minimal template language with a JSON context; its sections establish scope and
conditional presence, repeated sections iterate, `or` supplies an empty branch,
formatters transform values, and block files provide partials. That data-context-first
model is especially relevant to HTML7's declarative data sources and template bindings.

HTML7 should borrow that constraint, not clone Liquid:

- HTML7 control flow is expressed with HTML elements rather than `{% ... %}` tags.
- HTML7 expressions participate in a typed, reactive dependency graph.
- HTML7 should use conventional operator precedence and allow parentheses. Liquid's
  right-to-left `and`/`or` evaluation and prohibition on parentheses are poor fits for a
  new language.
- HTML7 bindings must distinguish literal HTML attributes from expression bindings.
- HTML7 filters must declare input/output types and purity.

See [prior art](./prior-art.md) for observations we want to preserve without treating
any one predecessor as the default answer.

## Illustrative surface syntax

Language-element attributes can have expression semantics by definition:

```html
<if test="cart.total > 0 and cart.available">
  ...
</if>

<for each="item" of="cart.items">
  ...
</for>

<computed name="subtotal" from="cart.total - cart.discount"></computed>
```

Conditions and scope changes are separate operations:

```html
<if test="account.owner">
  <with value="account.owner">
    <p><value of="name"></value></p>
  </with>
</if>
```

`<if>` never changes the binding scope. `<with>` explicitly rebases the current scope;
inside it, `name` resolves against `account.owner`. An alias is not required by the basic
form. `<for>` similarly establishes the current item for each iteration. This is
intentionally different from Squarespace JSON-T sections, which combine presence testing
with a change to the current data context.

General HTML and component properties need to distinguish literals from bindings. The
current candidate borrows Vue's browser-safe colon convention:

```html
<looma-meter max="100" :value="upload.progress"></looma-meter>
```

Here `max` is the literal string `"100"` subject to the component property's declared
coercion, while `:value` is an expression binding. A real Chromium parser preserves
`:value` as the attribute name and the quoted expression as its value.

Liquid- and Vue-style text interpolation has been rejected:

```html
<p>Hello, {{ user.name | default: "friend" }}.</p>
```

Dynamic output should remain visibly part of the element language. The selected working
shape is:

```html
<p>Hello, <value of="user.name | default: 'friend'"></value>.</p>
```

HTML7 source is parsed as HTML, so syntax-only elements cannot rely on XML-style
self-closing tags. New non-void elements require an explicit end tag. See
[browser findings](./browser-findings.md) for the observed failure shape.

Angle-bracket-shaped text tokens such as `<"user.name">` have been rejected. The
browser treats them as text, not elements, leaving HTML7 with the same text-scanning
model as brace interpolation but a less conventional syntax.

`<value of="expression"></value>` makes `of` expression-valued by the element contract,
so it does not need a binding prefix. A simple path may use an unquoted HTML attribute
value (`<value of=user.name></value>`), while expressions containing spaces must be
quoted. The existing HTML `is` attribute is not repurposed because it already identifies
customized built-in elements.

The selected binding forms are:

```html
<!-- Literal HTML attribute. -->
<input value="Matthew">

<!-- One-way reactive binding resolved by the element contract. -->
<input :value="user.name">

<!-- Two-way binding, only where the contract permits writes. -->
<input bind:value="user.name">

<!-- Explicit one-way binding to a DOM property. -->
<h1 .textContent="user.name"></h1>

<!-- Explicit raw-HTML property sink. -->
<h1 .innerHTML="trustedMarkup"></h1>
```

`:` is the normal one-way expression binding. `bind:` is two-way and requires a writable
expression plus an element contract that supports updates. `.` explicitly targets a DOM
property. An unprefixed attribute remains literal.

Consequently, `<h1 :value="user.name"></h1>` is invalid: `h1` has no declared `value`
attribute or property. Dynamic heading content uses `.textContent`; raw markup can use
`.innerHTML` only through an explicit unsafe sink.

HTML attribute names are ASCII-lowercased by browsers. Canonical property-binding names
nevertheless use familiar DOM casing. Authored `.innerHTML` arrives at a browser runtime
as `.innerhtml`; HTML7 resolves it case-insensitively through the element's typed contract
or DOM interface and recovers the exact property name `innerHTML`. Ahead-of-time targets
perform the same normalized lookup.

Normalization happens before semantic resolution in every target. The compiler and
browser runtime both turn the binding name into the same ASCII-lowercase key, then look
up the exact target spelling in the static element contract. Contracts reject names that
would collide after normalization.

The runtime fallback cannot rely on `Object.keys(element)`. Most DOM properties are
non-enumerable and live on prototype objects. It must walk the prototype chain with
`Object.getOwnPropertyNames()`, compare without case, reject ambiguous matches, and cache
the result per element interface. Normal execution should instead use a generated static
manifest derived from current Web IDL and DOM type data. See
[platform contract data](./platform-contract-data.md).

This model requires several strict rules:

- `.textContent` converts to escaped text;
- `.innerHTML` accepts only a dedicated trusted/sanitized HTML type, not an ordinary
  string;
- a content-replacing property binding cannot coexist with authored children;
- `<button :value="...">` retains the button's native submitted-value meaning rather
  than changing its label;
- server output and runtime updates distinguish an input's initial `value` attribute
  from its current DOM `value` property;
- elements such as `option`, `meter`, `progress`, and `li` retain their native value
  meanings.

An explicit `<value of="..."></value>` remains necessary for mixed inline content and
for labels where the surrounding element already assigns another meaning to `value`.

## Initial expression boundary

Candidate literals:

```text
"text"
'text'
42
3.14
true
false
null
```

Candidate reads:

```text
user
user.name
orders[0]
translations[locale]
```

Candidate operators:

```text
not value
-value
left * right
left / right
left % right
left + right
left - right
left < right
left <= right
left > right
left >= right
left == right
left != right
collection contains value
left and right
left or right
(expression)
```

Exact equality, null behavior, missing properties, truthiness, numeric coercion, string
concatenation, and error semantics must be specified rather than inherited accidentally
from JavaScript or Liquid.

Filters are the only expression-level call mechanism:

```text
user.name | default: "friend" | uppercase
price | currency: locale
items | take: 10
```

Filters must be registered, named, typed, deterministic for the same inputs, and free of
observable side effects. Network access and state changes belong to declarative data or
action facilities, not filters.

## Provisional grammar shape

This is structural pseudocode, not a final grammar notation:

```text
expression     := pipeline
pipeline       := logical-or ("|" filter)*
logical-or     := logical-and ("or" logical-and)*
logical-and    := equality ("and" equality)*
equality       := comparison (("==" | "!=") comparison)*
comparison     := additive (("<" | "<=" | ">" | ">=" | "contains") additive)*
additive       := multiplicative (("+" | "-") multiplicative)*
multiplicative := unary (("*" | "/" | "%") unary)*
unary          := ("not" | "-") unary | access
access         := primary (("." identifier) | ("[" expression "]"))*
primary        := literal | identifier | "(" expression ")"
filter         := identifier (":" expression ("," expression)*)?
```

The grammar deliberately has no assignment, call-expression, constructor, or statement
production.

## Type checking and reactivity

Every root identifier resolves through the template's declared binding scope. Property
access and operators are checked against the HTML7 types of those bindings. A filter's
declared output type becomes the input type of the next filter.

The parsed expression also identifies reactive dependencies. For example:

```text
search.value.results | take: page.size
```

depends on `search.value.results` and `page.size`. The browser runtime can subscribe to
those paths, while framework targets can translate them to the target's reactive model.

Dynamic indexed access may require a broader dependency subscription than a static path;
that is a performance rule, not a reason to execute JavaScript.

## Safety boundary

A limited grammar prevents arbitrary code execution, but it does not automatically make
untrusted templates safe. HTML7 must still define contextual escaping for text,
attributes, URLs, styles, and any explicit raw-HTML sink. Data-source permissions,
untrusted component imports, and filter registration require separate security models.

## Open decisions

- Use readable `and` / `or` / `not`, JavaScript-like `&&` / `||` / `!`, or another set?
- Is `==` typed equality only, or are any explicit coercions permitted?
- Is missing data `null`, a distinct `undefined`-like value, or a typed error?
- Are object and list literals useful enough to include?
- Should safe navigation have explicit syntax?
- Is string concatenation an operator or a filter?
- How are non-text expression values formatted or rejected when `<value>` appears in
  child-content position?
- Does normal `:property` binding prefer a DOM property when both a property and an
  attribute exist, or must every choice be declared in the element type library?
- Which filters belong to the core language, and how are additional filters imported?
- Are dynamic indexes allowed in all targets?
