# Pantry — one application, two delivery modes

A small data-driven application: a pantry stock list with search, restocking, discarding, an add
form, and a declared public method. It exists to prove the whole path end to end, not one feature
at a time, and to keep the two browser delivery modes honest about producing the same result.

## The components

| Component | Controller | What it shows |
| --- | --- | --- |
| `ui-badge` | no | A prop-driven visual atom with scoped styles. |
| `ui-stat` | no | A prop-driven summary figure. |
| `pantry-shell` | no | Pure layout: every region is a named slot. |
| `pantry-item` | no | A row that owns no data: it declares events and dispatches them. |
| `pantry-app` | yes | The one stateful component: declared request, state, computed values, and a public method. |

The split is the point. Only `pantry-app` has JavaScript, and it drives state, never the DOM. Rows
never mutate the list; they dispatch `adjust` and `remove`, and the controller decides what those
mean. The add form is a native `<form>`, so `required` and `min`/`max` stay the browser's job.

## Running it

Serve this directory, so `/api/pantry.json` resolves:

```sh
pnpm --filter @nextwebwg/html-next build   # live mode loads dist/browser-loader.bundle.js
python3 -m http.server 8799   # from this directory
# live:         http://localhost:8799/
# pre-compiled: npx vite build --config compiled/vite.config.mjs && http://localhost:8799/compiled/dist/
```

## The two deliveries

**Live** (`index.html`): the page links one component root and the browser resolves and parses the
rest of the graph at runtime. No build step, and definitions may arrive later.

**Pre-compiled** (`compiled/`): a Vite plugin (`precompile.mjs`) resolves the same graph during the
build and emits the already-parsed definitions, so the browser fetches no component sources.

`tests/pantry-app.test.ts` drives one scenario against both and requires every step to observe the
same DOM, which is the agreement [delivery modes](../../docs/spec/delivery-modes.md) demands.

## Known gaps this example documents

- The pre-compiled delivery still bundles the component parser: `runtime.ts` imports it statically
  for inline `<template component>` discovery, so pre-parsing the graph does not yet shrink it.
- `@nextwebwg/html-next-unplugin` compiles components to native DOM factories, which
  would be smaller again, but it cannot express this app yet: compiled invocations carry no
  attributes or projected children (`HN009`), and a component using the general runtime cannot
  contain them at all (`HN003`). That is why the pre-compiled mode here keeps the general runtime.
- A component's root must not be another component invocation (a delegated root). The outer
  instance would keep pointing at the element the inner component replaces, and the observer then
  disconnects it, which stops its effects and aborts its declared request.
- Two-way `bind:value` reassigns the control's value, which clears the browser's dirty-value flag,
  so `minlength`/`maxlength` stop applying to typed input. `required` is unaffected.
