# Style scoping: implementation

This note explains how the reference implementation realizes the normative
[styling contract](./spec/styling.md). Matching is defined by **region**: a definition's rules apply
from its root down to nested component roots and to projected content, which native `@scope`
expresses directly.

## Markers

- `data-component` names the component on each root, and only on roots. A delegated root lists
  every owning definition, delegating component first.
- `data-<tag>-state` carries, for each root whose definition uses `:host-state()`, the resolved
  values its stylesheet tests: `name=value` tokens with URI-encoded values, and bare `name` tokens
  for truthy booleans. The compiler derives the name list from the definition's selectors; the
  runtime keeps the attribute current as props and state change.
- `data-slotted` marks each top-level projected node.

Components and consumers never select, read, or write these attributes.

## Regions

```css
/* The definition's own markup. */
@scope ([data-component~="x-card"]) to ([data-component], [data-slotted]) {
  :scope { padding: 1rem; }
  .lead { color: gray; }
}
```

- A scope limit and its descendants are outside the scope ([CSS Cascading and Inheritance Level
  6](https://www.w3.org/TR/css-cascade-6/#scoped-styles)). The root is the scope root, not a limit,
  so `:scope` matches it even though it carries `data-component`.
- A nested component's root is a limit, so neither it nor its internals match. The enclosing
  definition lays out children from its own elements.
- A projected node is a limit, so projected content does not match unless a rule opts in with
  `:slotted()`.

`:slotted()` rules go to a second scope without the projected-content limit, and each selector
confines its subject to projected content:

```css
@scope ([data-component~="x-card"]) to ([data-component]) {
  :where([data-slotted], [data-slotted] *):is(h2) { color: blue; }
}
```

`:where()` adds no specificity, so a consumer's own rules on projected nodes win ties. `:global()`
rules are emitted outside any scope.

## Compilation in the browser

The runtime has no CSS parser. It renames three pseudo-classes into selectors the browser accepts,
lets the browser parse, and routes rules through the CSS Object Model:

1. One pass over the style text, skipping comments and strings, rewrites `:slotted(` to
   `:where([--slotted]):is(`, `:global(` to `:where([--global]):is(`, and `:host-state(` to
   `:where([--state]):is(`. Each original argument stays intact inside `:is()`.
2. `CSSStyleSheet.replaceSync()` parses the text. The runtime walks `cssRules`, recursing into
   grouping rules (`@media`, `@supports`, `@container`, `@layer`) and keeping each rule's grouping
   prelude, and routes every style rule by its sentinel.
3. Each routed rule's `selectorText` is rewritten: `:host` to `:scope` (own scope) or to
   `[data-component~="x-card"]` (`:slotted()` scope), a state test such as `[size="sm"]` to
   `[data-x-card-state~="size=sm"]` on the root, and the sentinels to their final forms. Nested
   rules move with their parent rule.
4. The three groups are assembled into the two scopes and the unscoped global rules.

Build tools and framework converters perform the same routing with a CSS parser.

## Cascade and inheritance

No wrapper, shadow root, reset, or containment rule is introduced. Selector matching stops at
region boundaries, but inherited properties, including design tokens in custom properties, flow
through nested and projected content exactly as they do in ordinary light DOM.

## Verification matrix

The conformance tests render and compare:

- bare, descendant, child, sibling, and `:has()` selectors in a definition's own markup;
- `:host` on the root, and `:host-state()` with equality, presence, and defaults;
- nested component roots and internals remaining unmatched;
- projected content unmatched without `:slotted()`, and `:slotted()` at every depth, with complex
  arguments, nested rules, and grouping rules;
- a consumer rule overriding `:slotted()` on equal specificity;
- `:global()` rules applying document-wide;
- comments and strings containing the renamed tokens left untouched;
- inherited properties and custom properties across both boundaries;
- delegated roots listing more than one definition; and
- native validity selectors inside grouping rules, in Chromium, Firefox, and WebKit.
