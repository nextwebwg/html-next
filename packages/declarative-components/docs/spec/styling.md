# Styling

Component styles have **one default that fits almost every component**, plus a few explicit
nudges for the cases that need more. There is no configuration to get right first: the
zero-config behavior is the good behavior.

## Scoped component styles

A definition's style rules apply to **its region**: its public root and everything inside it, down
to the root of any component it nests and down to content a consumer projects into it. With no
extra syntax, that one rule gives you:

- **Scoping, so styles never collide.** A definition's rules do not leak to the page, into a
  sibling component, or into a nested component. You can write `button { … }` or `.label { … }`
  without qualifying it.
- **Theming that still works.** Nothing is reset, wrapped, or encapsulated. Inherited
  properties and custom properties — your design tokens — flow in from the page and through
  every nested and projected boundary, exactly as in ordinary light DOM. The design system
  always reaches the component.
- **Hands off the consumer's content.** Content a consumer projects into a slot stays styled by
  the consumer. A definition does not touch it unless it opts in with `:slotted()`.
- **Hands off nested components.** A nested component's root and everything inside it belong to
  that component. The enclosing definition lays its children out from its own markup (`gap`,
  grid, and flex on the container); a consumer that needs to adjust one child's box puts its own
  `class` on the invocation.

This is deliberately **scoping, not isolation**: stronger than raw CSS, which has no scoping, and
friendlier than Shadow DOM, which walls off theming and application integration. Scoping is about
where rules apply, not a security boundary: markup that other code inserts inside a component's
region is styled like the rest of the region.

## The root: `:host`

`:host` selects the definition's own root. It is the only way to select the root; `:scope` is not
part of the authoring syntax.

```css
:host { display: block; max-inline-size: var(--ui-container-measure, 65ch); }
:host .label { color: var(--ui-text-secondary); }
```

## Styling by state: `:host-state()`

`:host-state()` selects the root while the component's resolved props and state have given
values. Its argument is a sequence of attribute-selector-shaped tests on declared names:

```css
:host-state([measure="narrow"]) { --ui-container-measure: 45ch; }
:host-state([open]) .panel { display: block; }
:host-state([side="end"][collapsed]) { border-inline-start: 0; }
```

- `[name="value"]` matches while the prop or state `name` resolves to `value`, including when the
  value is the declared default.
- `[name]` matches while `name` is truthy.
- Only equality and presence are supported. Names must be declared props or state whose type is a
  string, number, boolean, or keyword union; other operators and structured types are diagnostics.

A component styles by state this way instead of reflecting its props into `data-*` attributes for
its own stylesheet. `data-<prop>` attributes record only what an author configured (see
[Rendered form](rendered-form.md)); `:host-state()` sees resolved values.

## Nudge 1 — style projected content: `:slotted()`

When a component *wants* to style what a consumer projects — a form control skinning its
`<input>`, an icon button sizing its `<svg>` — it opts in with `:slotted()`:

```css
:slotted(svg)                 { inline-size: 1em; block-size: 1em; }
:slotted([slot="label"])      { font-weight: var(--ui-font-medium); }
:host-state([open]) :slotted(*) { opacity: 1; }
```

`:slotted(sel)` matches projected content at **any depth**: a projected node, or any node inside
one, that matches `sel`. The argument is a full selector, so `:slotted(ul li)` and nested rules
such as `:slotted(h2) { & + p { … } }` work, which a prose or rich-text component needs. Matching
stops at any nested component root. Shadow DOM's `::slotted()` accepts only a compound selector on
top-level nodes because cross-tree matching was costly for shadow roots; light-DOM scoping is
ordinary document matching, so the restriction does not apply.

`:slotted()` rules are a **low-specificity baseline** — a consumer's own rules on their projected
nodes still win — so a component sets a default look without seizing control. `:slotted(*) { all:
unset }` is the idiomatic clean-slate. A component ported from Shadow DOM rewrites `::slotted(x)`
to `:slotted(x)`.

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

`:valid`, `:invalid`, and `:user-invalid` keep their native browser meaning. Component style
scoping does not broaden them to ordinary elements or mirror them through private attributes.
Authors that need form participation use native controls or form-associated custom elements with
`ElementInternals`.

## Component markers

Lowering writes three kinds of attribute. They are implementation metadata, not an authoring hook:
components and consumers never select, read, or write them, and a converted framework component
need not produce them.

- `data-component` on each component **root only**, naming the component. A root that more than one
  definition owns lists each, space-separated, delegating component first
  (`data-component="x-primary x-button"`). No other element carries a component marker.
- `data-<tag>-state` on a root whose definition uses `:host-state()`: a space-separated list of
  `name=value` tokens (URI-encoded values) and bare `name` tokens for truthy booleans, covering only
  the names that definition's stylesheet tests. It is named per component because one root can
  carry more than one component's state.
- `data-slotted` on each top-level projected node.

Server-rendered output carries all three, so styles apply before hydration.

## Compilation

The browser runtime needs no CSS parser of its own. It lets the browser parse and then routes
rules with the CSS Object Model:

1. **Rename.** One pass that skips comments and strings rewrites `:slotted(`, `:global(`, and
   `:host-state(` to `:where([--slotted]):is(`, `:where([--global]):is(`, and
   `:where([--state]):is(`. The result is valid CSS and keeps each argument intact.
2. **Parse and route.** The browser parses the result (`CSSStyleSheet.replaceSync`). The runtime
   walks the rules, including rules inside grouping rules such as `@media`, and routes each style
   rule by its sentinel, rewriting its selector: `:host` becomes `:scope`, a state test becomes the
   root's `data-<tag>-state` token, and `:slotted(X)` becomes
   `:where([data-slotted], [data-slotted] *):is(X)`. A routed rule keeps its grouping rules.
3. **Assemble.**

```css
/* The definition's own markup. */
@scope ([data-component~="x-card"]) to ([data-component], [data-slotted]) { … }
/* :slotted() rules: projected content at any depth, stopping at nested components. */
@scope ([data-component~="x-card"]) to ([data-component]) { … }
/* :global() rules, unscoped. */
```

Build tools and framework converters do the same routing with a CSS parser, since they have no
DOM.

The live runtime uses native `@scope` and therefore requires Chrome 118+, Safari 17.4+, or Firefox
146+. Implementation notes and the verification matrix are in
[`../style-scoping.md`](../style-scoping.md).
