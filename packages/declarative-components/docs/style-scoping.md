# Style scoping: implementation

This note explains how the reference implementation realizes the normative
[styling contract](./spec/styling.md), including `:slotted()`. Matching is defined by
**authorship**; native `@scope` is an optimization used only where it produces the identical
result.

## Authorship is canonical

A definition's styles match an element **only when that definition authored the element** —
recorded as provenance lineage during lowering. This single rule produces every behavior the
contract promises:

- a definition's own markup and the *box* of a component it nests carry its token, so both match;
- a nested component's internals carry only the nested definition's token, so they do not match;
- projected content carries the consumer's authorship, not the receiving definition's, so it is
  not matched unless the definition opts in with `:slotted()`;
- foreign or runtime-inserted markup — a third-party element's internals, nodes some other script
  appends — carries no token from this definition, so it is never matched, with no special case.

Because authorship is the definition of correctness, an implementation may use any faster path
only where it yields the same set of matched elements. It must never widen matching to elements
this definition did not author.

## Provenance markers

Lowering stamps internal, space-separated tokens:

- `data-component` records which definition authored an element.
- `data-component-root` records which definition owns a lowered root.
- `data-slotted` marks the top node of each subtree moved into a slot position.

Tokens compose rather than overwrite. If `x-primary` delegates its root to `x-button`, the
eventual native root carries both provenance tokens, and each definition's style block applies
once. A nested component root also retains the parent's provenance token: the parent may lay out
that box, while the child's newly authored descendants carry only the child's token.

These attributes are polyfill and converter implementation details. Components must not read or
write them.

## Native `@scope`

When `CSSScopeRule` is available, the browser runtime emits a native scope for a definition's own
styles:

```css
@scope ([data-component-root~="x-card"])
    to (:scope [data-component-root] > *, [data-slotted]) {
  article { padding: 1rem; }
  article > .lead { color: gray; }
}
```

The lower-boundary details matter:

- A CSS scope limit and all its descendants are outside the scope.
- The nested component root must remain inside so the parent can style its box. Therefore the
  limit is the nested root's children, not the root.
- The leading `:scope` is required. Without it, the component's own root would also satisfy
  `[data-component-root]`, making every direct child a limit.
- A projected root is itself outside the receiving component, so `[data-slotted]` is a direct
  limit.

This follows [CSS Cascading and Inheritance Level 6's definition of a
scope](https://www.w3.org/TR/css-cascade-6/#scoped-styles): an element is in scope only when it is
not an inclusive descendant of a scoping limit.

Two selector normalizations preserve authored meaning after lowering:

- A selector for a component tag, such as `x-badge`, also matches the native element carrying
  `data-component-root~="x-badge"`.
- When an authored selector uses the definition's native root as an ancestor, the compiler adds a
  `:scope` alternative. Thus `article > .lead` still matches when that `article` is the scoping
  root.

Relational selector arguments such as `:has(.item)` receive a provenance guard. Native `@scope`
constrains the selector's subject, not everything inspected by `:has()`; the guard prevents nested
or projected markup from satisfying the relation.

`@scope`'s lower bound stops at *authored* component roots and projected roots, which is exactly
the authorship boundary within markup this definition produced. Where a subtree could contain
elements this definition did not author — a foreign custom element that renders its own light DOM,
or nodes another script inserts at runtime — the structural scope alone could reach them, so the
subject also carries its provenance guard (below). The guard, not the structural range, is
authoritative; `@scope` only narrows and accelerates.

## `:slotted()`

`:slotted(sel)` styles content projected into the definition. It compiles as a subtree query over
the projected region, bounded by the same authorship rule:

- The projected region is the set of `data-slotted` roots and their descendants, excluding any
  nested `data-component-root` and its descendants.
- A bare argument matches anywhere in that region: `:slotted(button)` targets `button` among the
  `data-slotted` roots or their descendants.
- A leading combinator anchors to the projection boundary: `:slotted(> *)` targets only the
  `data-slotted` roots; `:slotted(> button)` only a projected root that is a button.
- The full argument selector is honored, including descendant and child combinators evaluated
  within the region.
- Emitted rules carry no added specificity beyond the authored selector, so a consumer's own
  rules on projected nodes win ties. `:slotted(*) { all: unset }` therefore normalizes projected
  content while leaving the consumer able to override.

The converter maps a Shadow-DOM `::slotted(x)` to `:slotted(x)` unchanged.

## Attribute fallback and generated targets

Browsers without `@scope`, and ahead-of-time framework targets, use the same selector pipeline in
attribute mode. It appends a zero-specificity provenance condition to each selector subject:

```css
.lead:where([data-component~="x-card"]) { color: gray; }
```

The condition is on the subject rather than every compound. This matches the authorship rule
directly: an outside ancestor may provide context, but the element receiving the declaration must
have been authored by this component. `:has()` arguments are scoped recursively because they
select the related element being inspected. Component-tag selectors use an `:is()` form that
matches either an unlowered custom tag or its lowered root marker; the ordinary custom-element arm
preserves the original type-selector specificity, and provenance guards use `:where()` so they add
none.

The same transformation pass mirrors `:valid`, `:invalid`, and `:user-invalid` to the runtime's
internal state hooks. It recurses through grouping rules such as `@media`, `@supports`,
`@container`, and `@layer`, while leaving declaration values, strings, comments, keyframes, and
global name-defining rules alone. The transformation is deterministic and idempotent.

## Projection placement

The runtime replaces a slot-position comment anchor with the invocation's original nodes. It does
not replace the slot's parent element. This preserves authored siblings, the exact slot position,
and consumer node identity while allowing `data-slotted` to mark only the projected subtree
boundary.

## Cascade and inheritance

No wrapper, shadow root, reset, or containment rule is introduced. Selector matching stops at
authorship boundaries, but inherited properties — including design tokens in custom properties —
flow through nested and projected content exactly as they do in ordinary light DOM.

## Verification matrix

The conformance tests render and compare:

- bare, descendant, child, sibling, and `:has()` selectors;
- parent styling of a nested component root without access to its internals;
- foreign custom-element light DOM and runtime-inserted nodes remaining unmatched;
- projected roots and descendants, and `:slotted()` subtree queries including `:slotted(> *)`;
- `:slotted(*) { all: unset }` normalization that a consumer rule can still override;
- inherited properties and custom properties across both boundaries;
- delegated provenance lineages;
- validity selectors inside grouping rules; and
- native-`@scope` and attribute-fallback computed styles in Chromium, Firefox, and WebKit.
