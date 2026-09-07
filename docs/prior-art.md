# Prior art

Last updated: 2026-09-06

HTML7 should learn from multiple declarative and component languages without selecting
one of them as its default syntax. This ledger records what each system proves, what may
be worth borrowing, and what should not be inherited accidentally.

## Shopify Liquid

Official references:

- [Liquid introduction](https://shopify.github.io/liquid/basics/introduction/)
- [Liquid operators](https://shopify.github.io/liquid/basics/operators/)
- [Shopify Liquid reference](https://shopify.dev/docs/api/liquid)

What it proves:

- A deliberately limited template language can be useful at large scale.
- Objects and dot-path reads cover a large share of ordinary presentation needs.
- Control-flow tags can remain separate from output expressions.
- Named filters form a constrained transformation vocabulary without arbitrary calls.
- A restricted language can be hosted by different implementations and products.

Ideas worth evaluating:

- explicit objects supplied by the rendering context;
- output interpolation;
- readable comparison and boolean operators;
- left-to-right filter pipelines;
- a small, registered library of transforms.

Do not inherit automatically:

- Liquid's `{% ... %}` control-flow syntax when HTML7 can use elements;
- right-to-left evaluation of chained `and` and `or` expressions;
- the prohibition on parentheses;
- Liquid-specific truthiness and coercion;
- a one-shot rendering model without typed reactive dependencies.

## Squarespace JSON-T

Official references:

- [What is JSON-T?](https://developers.squarespace.com/what-is-json-t)
- [JSON-T directives](https://developers.squarespace.com/json-t-directives)
- [Templating basics](https://developers.squarespace.com/templating-basics)
- [JSON-T formatters](https://developers.squarespace.com/json-t-formatters)
- [Template partials](https://developers.squarespace.com/template-partials)

What it proves:

- A minimal language paired directly with a JSON dataset can render substantial sites.
- Entering a section can both test presence and establish a new local data scope.
- Repeated sections can iterate a list while rebinding the current scope.
- An alternate branch can express empty or missing data compactly.
- Formatters can provide constrained value transformations.
- Plain template files and reusable block files can organize an HTML-oriented system.

Ideas worth evaluating:

- make the data context a first-class part of template semantics;
- let nested template regions narrow or rebind scope deliberately;
- give iteration a clear current-item binding and index metadata;
- treat empty-data behavior as a normal template concern;
- support small, scope-aware partials or imports;
- keep the core language legible alongside ordinary HTML.

Do not inherit automatically:

- punctuation directives such as `{.section ...}` when HTML7 can represent structure
  with elements;
- implicit `@`-style current-scope references if explicit names are clearer and more
  type-safe;
- coupling the available data model to a specific CMS;
- server-only, one-shot rendering semantics;
- formatter behavior without declared types and contextual output safety.

Decision taken from this comparison: HTML7 will not let an ordinary condition
implicitly rebase the current data context. `<if>` controls presence; a dedicated
`<with>` element explicitly rebases the current scope. Unlike an implicit rebase, the
`<with>` boundary is visible and does not require an alias in its basic form.

## Vue and Svelte

Their primary relevance is the authoring experience: markup-first components with
template control flow, bindings, local state, styles, and reactive updates. HTML7's
aspiration is to provide comparable expressive power using HTML—or a deliberately
evolved HTML—as the language, while remaining independent of either framework runtime.

Vue's quoted directive attributes are also concrete browser-parsing prior art. See
[browser findings](./browser-findings.md).

## XSLT and XML transformation languages

These remain research candidates for template matching, declarative transformation,
namespaces, typed source trees, and the separation between a source document and its
rendered result. Specific lessons have not yet been evaluated and should not be claimed
until that research is done.

## Mitosis

Mitosis is prior art for compiling one component source into multiple framework targets.
Its JSX-like canonical language differs from HTML7's markup-first goal, but its generator
architecture, target-specific escape hatches, fixture strategy, and cross-target failure
modes remain relevant.

## How to use this ledger

Prior art supplies evidence and vocabulary, not authority. For each proposed HTML7
feature, compare at least:

- authored readability;
- browser parsing without a build step;
- type-checking potential;
- reactive dependency semantics;
- ahead-of-time target generation;
- browser-runtime feasibility;
- contextual escaping and security;
- error reporting and editor tooling.
