# Style scoping: implementation

How this package realizes the [styling contract](https://nextwebwg.org/html-next/styling). The
contract is the source of truth; this note only records how the tooling meets it.

## Markers

- `data-component="tag"` is on a component's root, and only its root. A delegated root (one whose
  markup root is another component) lists every owner: `data-component="x-primary x-base"`.
- `data-slotted` is on each top-level projected node.
- `data-<tag>-state="name=value name"` carries the resolved props and state the definition's
  `:host-state()` rules test, and nothing else. A truthy value adds the bare `name`; a string or
  number adds `name=<URI-encoded value>`.

## Compilation

A style block compiles to two scopes:

```css
@scope ([data-component~="x-card"]) to ([data-component], [data-slotted]) { /* own rules */ }
@scope ([data-component~="x-card"]) to ([data-component]) { /* :slotted() rules */ }
```

- `:host` becomes `:scope` in the first scope and the root selector in the second.
- `:host-state([name="value"])` becomes tokens of the state attribute; names must be declared
  props or state of a scalar type (HY001, HY002).
- `:slotted(X)` matches projected content at any depth:
  `:where([data-slotted], [data-slotted] *):is(X)`.
- A component tag in a selector matches its lowered root with type specificity:
  `:is(x-card, :where([data-component~="x-card"]))`.
- `:scope` is not authoring syntax (HY003).
- `:valid`, `:invalid`, and `:user-invalid` also match the validity runtime's mirrors.
- `@keyframes`, `@font-face`, `@property`, and other document-wide rules are hoisted unscoped.

The browser runtime needs no CSS parser. It renames `:slotted(` and `:host-state(` into selectors
the browser accepts, parses the block twice with `CSSStyleSheet`, drops the other scope's rules from
each copy, and rewrites the remaining selectors through the CSS Object Model
(`src/component-styles.ts`). Build tools run the same steps over postcss
(`src/component-styles-build.ts`).

## Vue

Converted components use `<style scoped>`. `:host` and `:host-state()` become attribute selectors
on the generated root; Vue's own `:slotted()` handles projected content.

## Proof

`tests/platform-scoping.test.ts` checks the platform behavior this relies on in Chromium, Firefox,
and WebKit.
