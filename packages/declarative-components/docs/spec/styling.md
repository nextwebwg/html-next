# Styling

Component styles have **one default that fits almost every component**, plus a few explicit
nudges for the cases that need more. There is no configuration to get right first: the
zero-config behavior is the good behavior.

## Scoped component styles

A definition's style rules apply to **the markup that definition authored** — its public root
and everything inside it, including the *box* of any component it nests. With no extra syntax,
that one rule gives you:

- **Scoping, so styles never collide.** A definition's rules do not leak to the page, into a
  sibling component, or into a nested component's internals. You can write `button { … }`
  without qualifying it.
- **Theming that still works.** Nothing is reset, wrapped, or encapsulated. Inherited
  properties and custom properties — your design tokens — flow in from the page and through
  every nested and projected boundary, exactly as in ordinary light DOM. The design system
  always reaches the component.
- **Hands off the consumer's content.** Content a consumer projects into a slot stays styled by
  the consumer. A definition does not touch it.
- **No surprises from foreign markup.** Because matching follows *authorship*, anything the
  definition did not author — a third-party element's internals, nodes inserted at runtime by
  other code — is simply never matched. You never have to reason about it.

This is deliberately **scoping, not isolation**: stronger than raw CSS, which has no scoping,
and friendlier than Shadow DOM, which walls off theming and application integration. The
enclosing definition may still style a nested component's **root** as a layout box (position,
margin, size); it just cannot reach that component's internals.

## Nudge 1 — style projected content: `:slotted()`

When a component *wants* to style what a consumer projects — a form control skinning its
`<input>`, a button skinning its label — it opts in with `:slotted()`:

```css
:slotted(button)        { … }  /* any projected button, at any depth */
:slotted(> *)           { … }  /* only the top-level projected nodes */
:slotted(.row > button) { … }  /* full selectors, evaluated within the projection */
:slotted(*) { all: unset; }    /* normalize projected content to a clean slate */
```

`:slotted()` is a **subtree query** whose argument reads as it would inside `@scope (slot) { … }`:
a bare selector matches anywhere in the projected subtree; a leading `>` anchors to the
projection boundary, so `:slotted(> *)` selects only the projected roots; and matching stops at
any nested component root — a definition never reaches inside a component that happens to sit in
projected markup.

`:slotted()` rules are a **low-specificity baseline** — a consumer's own rules on their projected
nodes still win — so a component sets a default look without seizing control. `:slotted(*) { all:
unset }` is the idiomatic clean-slate. A component ported from Shadow DOM rewrites `::slotted(x)`
to `:slotted(x)` verbatim; the single colon reflects that this selects real elements by
relationship, not a pseudo-element.

## Nudge 2 — expose customization: custom properties and parts

A definition never pierces another component's internals — there is deliberately no `:deep()`,
because piercing couples callers to private structure and breaks refactoring. Instead a component
exposes the surface it *wants* customizable as **custom properties** (`--ui-button-radius`, …),
which already cross every boundary, and optionally as named **parts** for targeted external
styling. This is how both an application author and a parent component reach a component's look —
on the component's terms, without breaking its composability.

## Nudge 3 — go global: `:global()`

Rarely, a rule is meant to apply document-wide. `:global(sel)` opts that one rule out of scoping.

## Validity selectors

`:valid`, `:invalid`, and `:user-invalid` are mirrored to the runtime's internal validity state
in the same transformation pass, so scoping and mirrored validation state can never disagree.

## Provenance

Matching is defined by **authorship**, recorded as provenance lineage on every lowered element:
each element carries which definition authored it, projected roots are marked consumer-owned, and
a delegated root carries every owning definition's lineage so each style block applies once.
Provenance is implementation metadata, not an authoring hook — components never read or write it.

The live runtime uses native `@scope` and therefore requires Chrome 118+, Safari 17.4+, or Firefox
146+. Ahead-of-time generated targets use the equivalent provenance-attribute mapping for older
browsers. Authors never see or select either mechanism. The canonical matching algorithm, the
`@scope` mapping, `:slotted()` compilation, and projection placement are in
[`../style-scoping.md`](../style-scoping.md).
