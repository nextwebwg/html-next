# Style scoping: implementation

This note explains how the reference implementation realizes the normative
[style-scoping contract](./spec/styling.md). It does not add author-facing syntax.

A component's `<style>` rules match markup authored by that component, including its
root and the box of a nested component invocation. They do not match a nested
component's internals or content projected into the component. These are selector
boundaries, not encapsulation boundaries: inherited properties and custom properties
continue through the ordinary light-DOM cascade.

## Provenance markers

Lowering stamps internal, space-separated tokens:

- `data-component` records which definition authored an element.
- `data-component-root` records which definition owns a lowered root.
- `data-slotted` marks the top node moved into a slot position.

Tokens compose rather than overwrite. If `x-primary` delegates its root to `x-button`,
the eventual native root carries both provenance tokens, and each definition's style
block applies once. A nested component root also retains the parent's provenance token:
the parent may lay out that box, while the child's newly authored descendants carry only
the child's token.

These attributes are polyfill and converter implementation details. Components must not
read or write them.

## Native `@scope`

When `CSSScopeRule` is available, the browser runtime emits a native scope:

```css
@scope ([data-component-root~="x-card"])
    to (:scope [data-component-root] > *, [data-slotted]) {
  article { padding: 1rem; }
  article > .lead { color: gray; }
}
```

The lower-boundary details are important:

- A CSS scope limit and all its descendants are outside the scope.
- The nested component root must remain inside so the parent can style its box.
  Therefore the limit is the nested root's children, not the root.
- The leading `:scope` is required. Without it, the component's own root would also
  satisfy `[data-component-root]`, making every direct child a limit.
- A projected root is itself outside the receiving component, so `[data-slotted]` is
  a direct limit.

This follows [CSS Cascading and Inheritance Level 6's definition of a
scope](https://www.w3.org/TR/css-cascade-6/#scoped-styles): an element is in scope only
when it is not an inclusive descendant of a scoping limit.

Two selector normalizations preserve authored meaning after lowering:

- A selector for a component tag, such as `x-badge`, also matches the native element
  carrying `data-component-root~="x-badge"`.
- When an authored selector uses the definition's native root as an ancestor, the
  compiler adds a `:scope` alternative. Thus `article > .lead` still matches when
  that `article` is the scoping root.

Relational selector arguments such as `:has(.item)` receive a provenance guard.
Native `@scope` constrains the selector's subject, not everything inspected by
`:has()`; the guard prevents nested or projected markup from satisfying the relation.

## Attribute fallback and generated targets

Browsers without `@scope`, and ahead-of-time framework targets, use the same selector
pipeline in attribute mode. It appends a zero-specificity provenance condition to each
selector subject:

```css
.lead:where([data-component~="x-card"]) { color: gray; }
```

The condition is on the subject rather than every compound. This matches native
`@scope`: an outside ancestor may provide context, but the element receiving the
declaration must have been authored by this component. `:has()` arguments are scoped
recursively because they select the related element being inspected.

Component-tag selectors use an `:is()` form that matches either an unlowered custom
tag or its lowered root marker. The ordinary custom-element arm preserves the original
type-selector specificity; provenance guards use `:where()` so they add none.

The same transformation pass also mirrors `:valid`, `:invalid`, and
`:user-invalid` to the runtime's internal state hooks. It recurses through grouping
rules such as `@media`, `@supports`, `@container`, and `@layer`, while leaving
declaration values, strings, comments, keyframes, and global name-defining rules alone.
The transformation is deterministic and idempotent.

## Projection placement

The runtime replaces a slot-position comment anchor with the invocation's original
nodes. It does not replace the slot's parent element. This preserves authored siblings,
the exact slot position, and consumer node identity while allowing `data-slotted` to
mark only the projected subtree boundary.

## Cascade and inheritance

No wrapper, shadow root, reset, or containment rule is introduced. Selector matching
stops at provenance boundaries, but inherited properties—including design tokens in
custom properties—flow through nested and projected content exactly as they do in
ordinary light DOM.

## Verification matrix

The conformance tests render and compare:

- bare, descendant, child, sibling, and `:has()` selectors;
- parent styling of a nested component root without access to its internals;
- projected roots and descendants;
- inherited properties and custom properties across both boundaries;
- delegated provenance lineages;
- validity selectors inside grouping rules; and
- native-`@scope` and attribute-fallback computed styles in Chromium, Firefox, and
  WebKit.
