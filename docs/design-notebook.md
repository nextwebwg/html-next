# HTML7 design notebook

Intended public repository: `github.com/nextwebwg/html7` (not created or published by
this MVP work).

Last updated: 2026-09-06

This is a living record of the idea as it develops. Examples are illustrative unless a
section explicitly calls a decision settled.

## Why HTML7

HTML's native authoring model does not directly provide reusable application templates,
template control flow, imports, declarative data sources, or declarative reactivity.
Libraries solve those needs in mutually incompatible JavaScript-centered languages.

HTML7 explores whether those facilities can instead form a markup-first language that:

1. drives as much application behavior declaratively as practical;
2. is written as HTML-like markup rather than React/JSX-like component functions;
3. can be compiled ahead of time into idiomatic framework integrations;
4. can also be interpreted or polyfilled directly in a browser;
5. treats real browser behavior and polyfillability as design constraints;
6. has a web-native type system richer than JavaScript's primitive types.

In short: provide the declarative authoring power of Vue or Svelte, but with HTML—or a
new HTML—as the language itself. Vue and Svelte are important prior art, not intended
runtime dependencies or canonical compilation targets.

"HTML7" is a working name for the experiment, not a claim to own or predict a formal
successor to the HTML Living Standard.

## Separate from Looma, developed together

HTML7 and Looma are separate projects:

- **HTML7** owns the language, parser, type system, intermediate representation,
  compiler targets, browser runtime, and conformance suite.
- **Looma** owns a component vocabulary, visual design, accessibility behavior, native
  DOM contracts, and its supported consumer packages.

Looma may author its components in HTML7 and become the first serious proof that both
execution paths work. Production Looma packages can ship ahead-of-time generated
artifacts; consuming Looma must not require adopting the experimental browser polyfill.

The browser path remains essential evidence rather than a packaging requirement. It
tests whether HTML7 behaves like a plausible extension of HTML instead of merely being
another build-only component syntax.

## One language, two execution paths

HTML7 source is parsed and type-checked into one framework-neutral representation.

The ahead-of-time compiler can emit:

- semantic native HTML, CSS, and framework-neutral controllers;
- idiomatic React components and types;
- idiomatic Vue components and types;
- idiomatic Svelte components and types;
- documentation, API references, and conformance fixtures;
- additional targets in the future.

The browser runtime reads the same definitions and evaluates the same semantics directly.
It need not use the same implementation strategy as generated output.

The governing contract is observable parity:

> Ahead-of-time compilation and in-browser execution should produce equivalent native
> output, state transitions, events, accessibility semantics, and error behavior.

## Three kinds of element

The current model distinguishes three layers that should not be conflated.

### Language elements

Elements such as `<if>`, `<else-if>`, `<else>`, and `<for>` are instructions in an
HTML7 template. They are not autonomous custom elements and do not need registration in
the browser's `CustomElementRegistry`.

The browser parser already preserves the information the language needs: element names,
attributes, child nodes, and order. The compiler and browser runtime can walk that tree
and interpret it.

Language elements only have semantics while evaluating an HTML7 template. If they occur
in the live document outside a template, they are `display: none` no-ops. Instantiated
output contains the result of the control flow, not the control-flow elements themselves.

### Component elements

Elements such as `<looma-button>` invoke an HTML7 component definition. They are authored
as elements even when a compiler or runtime lowers them into a different native shape.

### Output elements

Native elements such as `<button>`, `<input>`, and `<dialog>` are the downlevel output.
They preserve the semantics browsers already implement rather than reconstructing those
semantics on generic custom-element hosts.

For example:

```html
<!-- HTML7 source -->
<looma-button variant="solid">Save</looma-button>
```

```html
<!-- Illustrative lowered DOM -->
<button data-looma data-lm-variant="solid" type="button">Save</button>
```

Whether the browser runtime replaces component invocation elements or preserves some of
them in the live DOM remains open. Control-flow elements, however, are template syntax
and disappear from instantiated output.

## Templates and control flow

Control flow is evaluated inside a template against bound data. It is not intended as an
imperative facility for arbitrary nodes in the document body.

```html
<template name="todo-list">
  <if test="todos.length">
    <for each="todo" of="todos">
      <todo-item :item="todo"></todo-item>
    </for>
  <else>
    <p>No todos yet.</p>
  </else>
  </if>
</template>
```

The exact definition wrapper, expression syntax, branch nesting, and loop syntax remain
open. The structural direction is settled: templates are markup, and their control-flow
nodes are data interpreted by the compiler or browser runtime rather than Web Components.

Control flow does not implicitly change data scope. `<if>` only decides whether its
children are instantiated. Scope changes require a dedicated `<with>` element, which
explicitly rebases the current scope to its value. A `<for>` loop similarly establishes
the current item for each iteration.

```html
<if test="account.owner">
  <with value="account.owner">
    <!-- `name` resolves against `account.owner`. -->
    <p><value of="name"></value></p>
  </with>
</if>
```

The `<with>` boundary keeps scope rebinding visible to readers and the type checker
without requiring an alias. A future alias facility may be useful for retaining an
explicit name, but it is not part of the basic form. This deliberately does not copy
Squarespace JSON-T sections' combination of presence testing and scope rebinding in one
conditional construct.

## Declarative dataflow

Templates receive values through explicit declarative connections rather than implicit
access to arbitrary JavaScript globals.

The motivating flow is:

```text
form control
    |
    v
data-source parameter
    |
    v
request or recomputation
    |
    v
data-source state
    |
    v
bound template instance
```

A JSON resource could be bound to a template, while a form control is bound to one of
the resource's parameters. Changing the control updates the parameter, refreshes the
resource, and reactively updates the template.

Illustrative syntax:

```html
<data name="search" src="/api/search" type="SearchResults">
  <param name="query" type="string">
</data>

<template name="search-results" :data="search">
  <input bind:value="search.query">

  <if test="search.pending">
    <progress>Searching...</progress>
  <else-if test="search.error">
    <output><value of="search.error.message"></value></output>
  <else>
    <for each="result" of="search.value.results">
      <search-result :data="result"></search-result>
    </for>
  </else>
  </if>
</template>
```

A data source will probably need to expose parameters, pending state, a resolved value,
an error, and refresh or cancellation behavior. Exact concurrency, caching, and stale
response rules are unresolved.

The current syntax leaning separates concepts with different lifecycles:

```html
<state name="count" value="0"></state>
<computed name="double" from="count * 2"></computed>
<data name="users" src="/users.json"></data>
```

- `<state>` represents a local mutable value.
- `<computed>` represents a value derived from other declared values.
- `<data>` represents something obtained from a source, such as JSON loaded from a URL.

This separation currently looks clearer than making `<data>` mean every reactive value,
but the names and exact boundaries are not settled.

## Reactivity

Reactivity should follow the declared dependency graph. A template expression, computed
value, or data-source parameter should be able to depend on declared props, state, data,
imports, and local loop bindings.

This enables:

- static dependency analysis;
- type-checkable expressions;
- predictable invalidation;
- ahead-of-time generation for different reactive frameworks;
- a browser runtime that does not require arbitrary `eval()` or `new Function()` calls;
- conformance tests shared by compiled and interpreted execution.

The JavaScript Signals proposal may provide useful runtime machinery, but it is not
assumed to be HTML7's authored programming model.

## Template expression language

HTML7 should define a small, pure expression language rather than placing JavaScript in
attribute strings. Shopify Liquid is useful prior art for a constrained language with
object paths, comparisons, boolean operators, and filter pipelines. HTML7 should borrow
that bounded character without inheriting Liquid's exact syntax or evaluation quirks.

The initial proposed boundary allows literals, reads from declared bindings, property
and safe indexed access, comparisons, boolean and basic arithmetic operators,
parentheses, and calls to explicitly registered pure filters. It excludes assignment,
mutation, arbitrary function or method calls, constructors, dynamic code evaluation,
and access to ambient JavaScript globals.

The browser runtime evaluates a parsed expression tree; it does not pass authored text
to `eval()` or `new Function()`. Ahead-of-time targets compile the same expression tree
into their target language. See [template expressions](./template-expressions.md) for
the working syntax and open decisions.

## A web-native type system

HTML7 types should not be limited to JavaScript primitives. The web already has richer
value domains and structural rules, including:

- boolean and enumerated attributes;
- strings, token lists, and sets;
- URLs, MIME types, IDs, and ID references;
- colors, lengths, percentages, times, and angles;
- numeric ranges and constrained values;
- element references and selectors;
- permitted, required, repeated, and mutually exclusive children;
- events, states, and accessibility relationships.

A component contract should be able to say both which properties exist and which markup
is valid. A tabs definition, for example, could constrain its children and express the
relationship between tabs and panels rather than merely assigning string types to props.

The type system should distinguish at least authored attribute syntax, parsed values,
reflected DOM properties, and reactive values. The exact notation is open.

Expression-bearing attributes must remain valid under the real HTML tokenizer. Initial
testing shows that `from={count * 2}` does not: spaces split it into multiple attributes.
Quoted values and Vue-style quoted bindings survive parsing. See
[browser findings](./browser-findings.md). Examples in this notebook now use quoted
values, but the presence and meaning of a `:` prefix remain open language decisions.

## Browser-first feasibility

Browser support should inform which language facilities HTML7 attempts to polyfill.
The project should maintain an exacting cross-browser conformance corpus rather than
assuming that every parseable tag behaves uniformly in every context.

Early fixtures should cover:

- unknown language elements in ordinary HTML and specialized parser contexts;
- nested templates and malformed markup recovery;
- attribute case folding, duplicate attributes, entities, and expression text;
- dynamic template and component insertion;
- strict Content Security Policy operation without dynamic code evaluation;
- initial rendering and no-runtime behavior;
- native form, focus, and accessibility behavior after lowering;
- equivalent output and updates across browser and ahead-of-time paths;
- HTML, SVG, MathML, tables, and select-like content models where relevant.

Custom Elements are an available mechanism, not the foundation of the language.
Hyphenated-name requirements do not block template instructions such as `<if>`, because
those instructions are interpreted template nodes rather than registered elements.

## Other output environments

Because HTML7 is also an ahead-of-time language, a target could render static, restricted
HTML for environments such as email. That does not imply that an interactive browser
polyfill will execute inside email clients. Target capabilities must be explicit rather
than silently pretending every environment supports the full runtime.

## Open questions

- What is the component-definition and import syntax?
- What is the expression grammar, and how deliberately does it differ from JavaScript?
- Which names are visible in a template binding scope?
- How are component props, local state, computed values, data, and loop locals declared?
- What source types should `<data>` support beyond JSON URLs?
- How are loading, failure, cancellation, caching, and stale responses represented?
- Does the browser runtime replace component invocation elements with native DOM?
- What is the precise observable-equivalence contract across compilation targets?
- Which browser parser constraints require alternate syntax or a compile-only feature?
- How are server rendering, hydration, and no-runtime fallbacks expressed?
- How are consumers allowed to extend the element and type vocabulary?

## Current decisions and leanings

- HTML7 is a separate project from Looma.
- HTML7 is markup-first rather than React/JSX-first.
- The same language supports ahead-of-time compilation and in-browser interpretation.
- Browser feasibility and polyfillability constrain language design.
- Template control flow is contextual language syntax, not a set of Web Components.
- `<if>` controls presence but never implicitly changes scope; `<with>` explicitly
  rebases the current scope to its value.
- Liquid/Vue-style `{{ expression }}` interpolation is rejected; dynamic output must use
  an HTML7 element or another HTML-shaped construct.
- Quoted pseudo-tags such as `<"expression">` are also rejected. Browsers preserve them
  only as text, so they provide no structural advantage over brace interpolation.
- The current output-element leaning is `<value of="expression"></value>`. It reads as
  "the value of this expression," avoids collision with SVG's native `<text>` element,
  and leaves result typing to the expression contract. Direct-browser HTML requires the
  explicit closing tag.
- Attribute binding uses `:name="expression"`; writable two-way binding uses
  `bind:name="expression"`; and `.property="expression"` explicitly targets a DOM
  property. Authors use familiar DOM casing such as `.innerHTML`; the browser runtime
  resolves the parser-normalized name case-insensitively against the typed DOM contract.
- Binding names are normalized up front to ASCII-lowercase keys in both compiled and
  browser paths. Contracts map those keys to exact target names and reject collisions.
- `<h1 :value="expression">` is invalid because a heading has no value contract. Use
  `.textContent` for escaped text or the explicitly restricted `.innerHTML` sink for
  trusted markup.
- Control-flow nodes outside templates are hidden no-ops.
- Instantiated output should preserve native browser semantics wherever possible.
- Looma may be authored as HTML7 components and act as its first demanding conformance
  suite while shipping generated artifacts to ordinary consumers.
- The current leaning is to distinguish local state, derived values, and external data
  rather than overload one `<data>` element with all three meanings.
