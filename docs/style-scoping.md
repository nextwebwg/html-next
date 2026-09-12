# Style scoping: implementation

How the reference implementation realizes the style-scoping **behaviour**. The behaviour
itself is normative in the specification and this document does not restate or change it:

- Spec: [Style scoping](https://github.com/nextwebwg/site/blob/main/app/pages/spec/styling.vue)

In one line: a component's `<style>` rules match the component's **own** markup, the root
and its subtree, but not the internals of nested components and not projected (slotted)
content, while inherited properties still cross every boundary. This file is only about
_how_ the polyfill and the converter produce that; none of it is author-facing.

> Status: not yet implemented. Today `<style>` text is copied verbatim into
> `styles/<tag>.css` (see `src/parser.ts` `css:` and `src/targets/*`). This document is
> the plan the scoping work follows.

## The one thing that makes this non-trivial

Native CSS `@scope` is **position-based**: it scopes by DOM ancestry. HTML Next scoping is
**provenance-based**: an element belongs to the scope of the component that _authored_ it,
regardless of where it ends up in the flattened light DOM. For the common case (no nested
components, no projected content) the two coincide, and `@scope` is an exact fit. The two
donut boundaries are exactly the cases where they diverge, and each is handled explicitly
below.

The provenance signal already exists: every lowered element carries `data-component`, a
space-separated token list, outermost invocation first (see the Components spec). That
attribute is what the scoping keys off.

## Boundary 1 — nested components: keep the root, limit at its children

A component's CSS is wrapped in an `@scope` rule whose root is the component's root and
whose lower limit is any nested component root:

```css
@scope ([data-component~="x-card"]) to ([data-component-root] > *, [data-slotted]) {
  article       { padding: 1rem; }
  h2            { margin: 0; }
  article > .lead { color: gray; }
  x-badge       { margin-left: auto; }  /* nested root, as a box */
}
```

This lands on the spec's rule by placing the lower limit one level below a nested root:

- **Scope root** — `[data-component~="x-card"]` matches this component's root(s). The root
  is always in scope (the start is never subject to the `to` limit), so its own
  `data-component` token does not terminate the scope.
- **Scope-end (`to`) elements and their descendants are out of scope.** A nested component
  root therefore cannot itself be the limit if the parent must style that root as a box.
  Lowering marks component roots with `data-component-root`, and the limit matches each
  root's children. The nested root remains in the parent's scope (`margin-left: auto`
  above), while its authored descendants are excluded.

Nesting composes: the nested component's own CSS is a separate `@scope` block rooted at its
own `data-component`, so an `x-card` inside another `x-card` each get their own scope, and
`@scope` nesting resolves them independently.

### The root-token subtlety

`data-component` is a token list, so a delegated preset carries several tokens
(`data-component="x-primary x-button"`). Scope by **membership**, not equality:
`[data-component~="x-card"]`, never `[data-component="x-card"]`. When two definitions in a
chain each ship a `<style>`, each block scopes on its own token; both match the same shared
root element and both apply, which is the intended behaviour for delegation.

## Boundary 2 — projected content: provenance, not position

Projected content lands physically inside the component's subtree (where the `<slot>` was),
so position-based `@scope` would wrongly include it. It must be excluded, because it is the
consumer's, and it keeps the consumer's scope.

At lowering time the implementation **marks the top of each projected subtree** with
`data-slotted` (set on the nodes moved into a slot position; it is implementation-internal,
never authored). The scope then excludes it, and because a projected node must be excluded
**including itself** (unlike a nested component root, which the parent may style as a box),
the marker is combined into the limit and also negated on the root selectors:

```css
@scope ([data-component~="x-card"]) to ([data-component-root] > *, [data-slotted]) {
  /* generated selectors additionally carry :not([data-slotted]) on their
     subject so the marked projected root itself is not matched, only the
     component's own nodes are. */
  :scope :not([data-slotted]) { /* ... */ }
}
```

Rationale for the asymmetry with Boundary 1: a nested component root is a box the parent
legitimately lays out, so the limit begins at its children. Projected content is not the
component's at all, so its marked root is itself a limit and both it and its descendants
are out.

## Inheritance is untouched

Both boundaries constrain **selector matching only**. Neither `@scope` nor the attribute
fallback stops the cascade, so inherited properties (`color`, `font`, custom properties /
design tokens) flow into nested components and projected content exactly as in ordinary
light-DOM HTML. Nothing special is done to achieve this; it is what _not_ isolating buys.

## The converter (AOT) path

The ahead-of-time converter cannot rely on the browser evaluating `@scope`, and it emits
plain CSS for framework targets, so it uses **attribute scoping keyed by provenance**, the
same technique as Vue/Svelte scoped styles, driven by the same `data-component` /
`data-slotted` signals rather than by DOM position:

1. Every element authored by a component is tagged for that component (the existing
   `data-component` token, or a shorter generated hash attribute if size matters).
2. Each selector in the block is rewritten to require the component's tag on its subject,
   and to exclude `data-slotted` subtrees, reproducing both boundaries structurally.
3. Nested component roots keep the box-stylable behaviour because the parent's rewritten
   selector still matches the nested root's element (it is tagged as the parent's child
   position) but not the nested component's internally-tagged descendants.

Because the tags come from authoring provenance, not DOM ancestry, the AOT output matches
the polyfill and the native `@scope` behaviour on all three cases (subtree, nested donut,
projected donut). This is the determinism/equivalence contract applied to CSS.

## Where `@scope` is unavailable in the browser

The polyfill prefers native `@scope`. Where it is not supported, the polyfill falls back to
the same attribute rewriting the converter uses, applied to the live DOM. The observable
result is identical; only the mechanism differs, which is the whole point of keeping this
out of the specification.

## Test matrix

Any implementation of the above should cover:

- a bare selector matches only the component's own subtree;
- descendant / child / sibling / `:has()` combinators match within the scope;
- a selector that also matches inside a nested component does **not** match there;
- the parent **can** style a nested component root as a box;
- a selector that also matches projected content does **not** match it (root or descendant);
- an inherited property set on the root reaches nested components and projected content;
- delegation: two `<style>` blocks in a chain both apply to the shared root;
- native-`@scope` output and attribute-fallback output are observably equivalent.
