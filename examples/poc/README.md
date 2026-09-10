# HTML Next — proof of concept

A complete, runnable, **unbundled** example of the HTML Next composition model:
a base `index.html`, component definitions as separate `.html` files, controllers
as `.js` modules, and a minimal runtime (`poc.js`) — all native ES modules, no build step.

## Run it

```sh
cd examples/poc
python3 -m http.server 8799
# open http://localhost:8799
```

(Any static server works. A server is required because definitions are fetched and
controllers are dynamically imported — `file://` will not allow that.)

Click the counter: it goes up. The chart draws via a controller that reaches a `<canvas>`
through a `$ref`. Both components load their JavaScript lazily, on first connect.

## What it shows

- **Definitions are inert data.** `components/*.html` contain a `<template component>` and
  declarations only — no `<script>`. Fetching one executes nothing.
- **Registration is by tag, like custom elements.** A controller `.js` module makes an
  explicit `defineController(tag, fn)` call (shaped like `customElements.define`); markup and
  behavior join at the tag, neither referencing the other.
- **The graph composes.** `index.html` resolves only the entry (`x-app`) via
  `<link rel="component">`; `app.html` declares its own deps (`x-counter`, `x-chart`), which
  are loaded transitively — like an ES-module graph.
- **Controllers load lazily.** Each definition carries `<link rel="controller">`; the runtime
  `import()`s it only when an instance first connects.
- **Controllers drive state, not the DOM.** The counter's controller sets `host.state.count`;
  the runtime reflects it to the `<span>`. The chart's controller owns its own canvas subtree.
- **Lowers to real native DOM.** The output is `<main>`/`<button>`/`<figure>` with a
  `data-component` provenance stamp and every `$`-directive consumed — inspect it in devtools.
- **Author markup is sanitized on lowering.** `<script>`, `on*` handlers, and `javascript:`
  URLs (literal or bound) are dropped before markup becomes live, so a definition is safe to
  render — a conservative stand-in for the HTML Sanitizer API.
- **Instances are torn down.** A `MutationObserver` disposes an instance's effects and runs
  its `on("disconnect")` teardown when it leaves the DOM; effects also drop stale
  subscriptions on each re-run, so nothing leaks.
- **The custom-element namespace is respected.** If a tag is a defined custom element,
  the runtime leaves it to the browser instead of lowering it.

## What is POC-simplified (vs. `src/runtime.ts` and the spec)

`poc.js` exists to prove the composition/registration/loading shape, not to be conformant:

- Expressions are **dotted paths or JSON literals only** — no operator grammar, no `$if`/`$each`.
  The production runtime (`src/runtime.ts`) has the real expression engine and control flow.
- Definition loading here is **eager-transitive** (the whole reachable graph loads at boot);
  the spec's model is demand-driven per first render, and demand-driven fetching gated on
  reactive state (the spec's `$match` example) is the genuinely hard, unimplemented part.
  Controllers **are** lazy (imported on first connect).
- Reactivity is a coarse read-tracking signal with microtask batching (with per-effect
  cleanup) — enough to show "drive state → DOM updates," not the full reactive semantics.
- **No SSR** — so the no-JS baseline is not demonstrated here: remove `poc.js` and the page
  is blank, because that baseline is an SSR guarantee, not a client-only one.
- No `on:`/`<handler>` declarative events (the counter wires its click in the controller),
  no form association, no scoped slots, no hydration/adopt-in-place.
- The sanitizer is conservative, not the full HTML Sanitizer API.
