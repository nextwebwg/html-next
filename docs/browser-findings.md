# Browser findings

Last updated: 2026-09-06

This file records small, reproducible experiments against real parsers and framework
compilers. Findings constrain the language; they do not by themselves settle syntax.

## Expression-shaped attribute values

Question: does a browser preserve the illustrative HTML7 form
`from={count * 2}` as one attribute value, and how does that compare with Vue's binding
syntax?

Tested with Playwright 1.60.0 Chromium and Vue compiler-dom 3.5.29. The same markup was
parsed inside a `<template>` and in the live document; Chromium produced the same
attributes in both locations.

### Unquoted braces containing spaces do not work

```html
<computed from={count * 2}></computed>
```

Chromium produces:

```html
<computed from="{count" *="" 2}=""></computed>
```

The attributes are `from="{count"`, `*=""`, and `2}=""`. Braces do not create an
HTML expression boundary; spaces remain attribute separators.

### Compact or quoted braces

Chromium preserves `from={count*2}` as the single string value `{count*2}`. It also
preserves `from="{count * 2}"` as `{count * 2}`. HTML itself assigns no expression
semantics to either value.

### Vue's quoted binding form survives and compiles

```html
<computed :from="count * 2"></computed>
```

Chromium preserves the element as written. Its exact DOM attribute record is:

```text
name         = ":from"
localName    = ":from"
value        = "count * 2"
prefix       = null
namespaceURI = null
```

`element.getAttributeNames()` returns `[":from"]`, and
`element.getAttribute(":from")` returns `"count * 2"`. The colon is an ordinary part
of the attribute's name; it does not create an XML namespace in an HTML document.

Vue compiles that binding to the equivalent of:

```js
{ from: context.count * 2 }
```

The longhand `v-bind:from="count * 2"` is also preserved by Chromium and compiles to the
same Vue property binding. Vue rejects `:from={count * 2}` and `:from={count*2}` because
the braces become part of the directive expression.

Vue 3.5.29 server rendering confirms that `:value` on a heading does not bind its text
content:

```html
<!-- Vue template -->
<h1 :value="user.name"></h1>

<!-- With user.name = "Matthew" -->
<h1 value="Matthew"></h1>
```

HTML7 may deliberately assign `:value` a different, type-aware meaning, but that would
be an HTML7 contract rather than inherited Vue behavior.

## Leading-dot attributes

Question: do major browser engines preserve a leading-dot attribute such as
`.value="foo"`?

Tested with Playwright 1.60.0 against:

- Chromium 148.0.7778.96;
- Firefox 150.0.2;
- WebKit 26.4.

All three produced the same DOM record:

```text
name         = ".value"
localName    = ".value"
value        = "foo"
prefix       = null
namespaceURI = null
```

They also preserve `.value="foo"` during `outerHTML` serialization. The same test
confirmed that `:value="bar"` and `bind:value="baz"` are preserved identically across
the three engines, with their punctuation remaining part of the ordinary attribute name.

Vue uses `.value="expression"` as leading-dot shorthand for a property-oriented binding.
An actual Vue 3.5.29 browser mount of `<h1 .value="user.name"></h1>` sets a `value`
property/attribute on the heading; it does not create heading text. HTML7 may reuse the
parseable shape while defining its own typed element-contract semantics.

### Property-name casing

All three engines ASCII-lowercase attribute names in HTML source:

```html
<h1 .innerHTML="a" .textContent="b"></h1>
```

becomes:

```html
<h1 .innerhtml="a" .textcontent="b"></h1>
```

HTML7 nevertheless keeps familiar camelCase property spelling in authored source. The
browser runtime sees `.innerhtml` and resolves it case-insensitively against the element's
typed contract or actual DOM interface, recovering the exact property `innerHTML`. The
direct-browser runtime cannot rely on authored casing itself surviving.

There is a narrow programmatic exception. Across all three engines,
`setAttributeNS(null, ".innerHTML", value)` and
`createAttributeNS(null, ".innerHTML")` can create a DOM attribute whose case is
preserved. Ordinary `setAttribute()` and `createAttribute()` lowercase the name, just
like the HTML parser. This namespace-API behavior does not help authored HTML: once
source has been parsed, the original casing is already gone, and serialized `outerHTML`
contains the normalized name.

### Attributes versus interpreted properties

Attributes and DOM properties are distinct. All three engines produced the following
for an input initialized and then edited through JavaScript:

```js
input.setAttribute("value", "initial")
input.value = "current"

input.getAttribute("value") === "initial"
input.defaultValue === "initial"
input.value === "current"
input.outerHTML === '<input value="initial">'
```

The attribute is serialized source/default state; the property is the current live
control state. This is the distinction HTML7's `:value`, `bind:value`, and explicit
`.property` forms need to model. It is not a way to recover the original spelling of an
attribute name.

### Discovering non-enumerable DOM properties

Across Chromium, Firefox, and WebKit, `Object.keys(element)` finds none of `innerHTML`,
`textContent`, or an input's `value`. Those properties are non-enumerable and live on
prototype objects:

```text
h1:
  Element.prototype          innerHTML
  Node.prototype             textContent

input:
  HTMLInputElement.prototype value
  Element.prototype          innerHTML
  Node.prototype             textContent
```

The case-insensitive resolver therefore walks the prototype chain and uses
`Object.getOwnPropertyNames()` at each level. It compares string names without case,
rejects ambiguous matches, and caches the resulting map per element interface. When
HTML7's generated type metadata is available, that contract can provide the exact
property spelling without runtime discovery.

### Current implication

HTML7 expressions must respect ordinary HTML attribute quoting if the same source is to
be parsed directly by browsers. At least two syntax families remain viable:

```html
<!-- The element contract says `from` is always expression-valued. -->
<computed from="count * 2"></computed>

<!-- A prefix distinguishes a bound expression from a literal property. -->
<some-component :value="count * 2"></some-component>
```

The first is terser for language elements with fixed semantics. The second supports both
literal and bound forms for general component properties.

### Coverage still needed

This experiment has not yet run in Firefox or WebKit because their Playwright browser
binaries are not installed locally. HTML7's conformance suite must eventually execute
the case in Firefox and Safari instead of treating expected interoperability as evidence.

## Self-closing syntax-only elements

Question: can an HTML7 output element use an XML-style self-closing form such as
`<text value="name" />` when parsed directly by a browser?

Tested with Playwright 1.60.0 Chromium inside a `<template>`.

### Result

It cannot. Source:

```html
<p>Hello <text value="name" />!</p>
```

Chromium produces:

```html
<p>Hello <text value="name">!</text></p>
```

The slash does not make an unknown HTML element void. The following exclamation mark
becomes a child of `<text>`, so replacing the element during template evaluation could
incorrectly remove or reorder authored content.

Adjacent self-closing source elements nest rather than remain siblings:

```html
<!-- Source -->
<text value="first" /><text value="second" />

<!-- Parsed DOM -->
<text value="first"><text value="second"></text></text>
```

The direct-browser language therefore requires explicit end tags for new syntax
elements:

```html
<text value="name"></text>
```

## HTML `<text>` and SVG `<text>`

Question: does an HTML7 `<text>` instruction conflict structurally with SVG's existing
`<text>` element?

Chromium distinguishes them by namespace even inside the same template:

```text
<text> inside HTML: namespaceURI = http://www.w3.org/1999/xhtml
                    constructor  = HTMLUnknownElement

<text> inside <svg>: namespaceURI = http://www.w3.org/2000/svg
                     constructor  = SVGTextElement
```

An HTML7 runtime can therefore recognize only HTML-namespace `<text>` as a language
instruction. Inside SVG, `<text>` must retain its native SVG meaning; dynamic SVG text
will need an ordinary binding or another instruction shape.

This collision is one reason to prefer `<value of="expression"></value>` for HTML7
output. Chromium preserves that form as an `HTMLUnknownElement` with `of="expression"`
in the HTML namespace. Inside SVG it creates an ordinary `SVGElement` named `value`, not
an `SVGTextElement`; an HTML7 runtime can recognize it without overriding SVG's native
text element.

## Quoted or symbolic tag-name shorthand

Question: can HTML parse a terse value placeholder such as
`<"value.no.attribute"></>` as an element?

Tested source inside a `<template>`:

```html
<"value.no.attribute"></><b>after</b>
```

Chromium produces two nodes:

```text
#text  '<"value.no.attribute">'
B      '<b>after</b>'
```

The opening token is preserved as literal text. It is not an element. The `</>` token is
discarded by the HTML parser. Forms beginning with `{` or `.` behave the same way:
`<{value}>` and `<.value>` remain text rather than becoming elements.

HTML7 could technically scan text nodes inside inert templates and treat
`<"expression">` as an atomic interpolation token. That option has been rejected: it
would be a compact expression mini-language, not an HTML element, and provides no
structural advantage over `{...}` or `{{...}}` interpolation. It would not appear in the
DOM as a selectable node, and surrounding literal text may share the same text node.

A name beginning with an ASCII letter does become an element even if it contains dots:

```html
<value.no.attribute></value.no.attribute>
```

Chromium creates an element whose local name is `value.no.attribute`. It still requires
an explicit end tag and is not automatically a registered Custom Element.
