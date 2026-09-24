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
| `pantry-suggestion` | no | One catalog hit; dispatches what the user chose. |
| `pantry-app` | yes | The one stateful component: declared request, state, computed values, and a public method. |

The split is the point. Only `pantry-app` has JavaScript, and it drives state, never the DOM. Rows
never mutate the list; they dispatch `adjust` and `remove`, and the controller decides what those
mean. The add form is a native `<form>`, so `required` and `min`/`max` stay the browser's job.

## `<data>`: values to a JSON endpoint and back

The app declares two reads. The first runs once on connection; the second is a reactive round trip.

```html
<!-- Sent as query parameters, re-requested whenever catalogQuery changes. -->
<data name="catalog" src="/api/catalog" debounce="150ms"
  type="list(object({ id: string, label: string, unit: string }))">
  <param name="q" :value="catalogQuery"></param>
  <param name="limit" :value="5"></param>
</data>
```

Typing `oli` into the box bound to `catalogQuery` produces one request (the three keystrokes are
coalesced by `debounce`):

```http
GET /api/catalog?q=oli&limit=5
```

```json
[ { "id": "olive",  "label": "Olive oil",    "unit": "bottles" },
  { "id": "olives", "label": "Green olives", "unit": "jars" } ]
```

Each `<param :value>` subscribes to the state it binds, so nothing calls the endpoint imperatively:
changing state *is* the request, and a param change cancels the stale in-flight read. The response
is validated against the declared `type`; a mismatch sets `catalog.error` instead of rendering a
value that does not match its contract. The template then renders straight from the result:

```html
<p class="notice" $if="catalog.pending">Searching the catalog…</p>
<ul class="suggestions">
  <pantry-suggestion $each="hit of catalog.value" $key="hit.id"
    :item-id="hit.id" :label="hit.label" :unit="hit.unit"></pantry-suggestion>
</ul>
```

Choosing a hit dispatches an event the controller applies, then clears `catalogQuery` — which
re-runs the read with an empty `q`, because the request is a function of state.

## Running it

The example ships a dev server so the declared reads have a real JSON endpoint:

```sh
pnpm --filter @nextwebwg/html-next build   # live mode loads dist/browser-loader.bundle.js
node server.mjs                            # http://localhost:8799/
# pre-compiled: npx vite build --config compiled/vite.config.mjs, then serve compiled/dist
```

## The two deliveries

**Live** (`index.html`): the page links one component root and the browser resolves and parses the
rest of the graph at runtime. No build step, and definitions may arrive later.

**Pre-compiled** (`compiled/`): a Vite plugin (`precompile.mjs`) resolves the same graph during the
build and emits the already-parsed definitions, so the browser fetches no component sources.

`tests/pantry-app.test.ts` drives one scenario against both and requires every step to observe the
same DOM, the agreement the [proposal](https://nextwebwg.org/html-next/) demands of delivery modes.

## Known gaps this example documents

- The pre-compiled delivery still bundles the component parser: `runtime.ts` imports it statically
  for inline `<template component>` discovery, so pre-parsing the graph does not yet shrink it.
- `@nextwebwg/html-next-unplugin` compiles components to native DOM factories, which
  would be smaller again, but it cannot express this app yet: compiled invocations carry no
  attributes or projected children (`HN009`), and a component using the general runtime cannot
  contain them at all (`HN003`). That is why the pre-compiled mode here keeps the general runtime.
- A write-side `<data>` (`method` plus `send="change"`, the proposal's synchronization half) is not
  implemented yet, so this example only reads.
