# HTML Next implementations

This pnpm monorepo holds proposal-specific reference implementations for HTML Next.
Each proposal owns an independently versioned package under `packages/`; shared policy
and verification live at the repository root.

| Package | Proposal | Current scope |
| --- | --- | --- |
| [`@nextwebwg/declarative-components`](./packages/declarative-components) | [Declarative HTML Components](https://nextwebwg.org/html-next/) | Live browser runtime, the shared compiler and validation, and native-DOM/CSS/package generation |
| [`@nextwebwg/declarative-components-unplugin`](./packages/declarative-components-unplugin) | [Declarative HTML Components](https://nextwebwg.org/html-next/) | Closed-graph unplugin and Vite application/library builds |
| [`@nextwebwg/declarative-components-converter`](./packages/declarative-components-converter) | [Declarative HTML Components](https://nextwebwg.org/html-next/) | Target-native React, Vue, and Svelte conversion |
| [`@nextwebwg/html-forms`](./packages/html-forms) | [HTML Forms](https://nextwebwg.org/html-forms/) | Native form request construction and abortable fetch enhancement |

The Declarative HTML Components package authors a component once as inert,
browser-parseable HTML. The same definition can run directly in a browser or compile to
native DOM, React, Vue, Svelte, CSS, types, and inspectable package artifacts. Its exact
behavior is defined by the package's [reference specification](./packages/declarative-components/docs/spec/index.md),
[support profile](./packages/declarative-components/docs/spec/support.json), and conformance tests.

The HTML Forms package operates on native `HTMLFormElement` and submitter objects. Declarative
Components consumes that API for its form declarations; the Forms package has no component,
template, or reactive-runtime dependency.

> Stage 0: the syntax and generated package shape may change. The repository is MIT-licensed,
> but its packages remain private until the project selects a public-visibility and publication
> policy.

## Declarative Components delivery modes

The Declarative Components implementation supports the same component language in three delivery
modes:

| Mode | Package | Input | Output |
| --- | --- | --- | --- |
| **Live browser runtime** — supports any graph | [`@nextwebwg/declarative-components`](./packages/declarative-components) | Any component graph selected or added by the application at runtime | One distributable that parses, mounts, updates, and disconnects every supported capability, for any graph, with no build step |
| **Compiled native build** — tree-shaken, via a Vite unplugin | [`@nextwebwg/declarative-components-unplugin`](./packages/declarative-components-unplugin) | An application entry graph or a concrete set of library entries | Native DOM modules tree-shaken to the exact capabilities the graph uses, with shared support combined by the bundler |
| **Framework conversion** — to React, Vue, or Svelte | [`@nextwebwg/declarative-components-converter`](./packages/declarative-components-converter) | A component graph plus a React, Vue, or Svelte target | Framework-native source generated *from* the graph, with bridges only for semantics the target lacks |

These are the only three build outputs, and they are distinct: the **runtime** ships one universal
distributable, the **compiled build** emits tree-shaken native DOM for a known graph, and the
**converter** generates framework source *from* Declarative Components. The converter is one-way
output; it is **not** an ingest that imports Shadow DOM or any other format *into* Declarative
Components. Such migrations are consumer-specific and live outside this repository.

An application build may serve as a complete alternative to a React, Vue, or Svelte application.
A library build keeps independently consumable component entries while allowing the consumer's
bundler to combine their shared support. All three modes consume one normalized semantic model and
must produce the same observable native DOM, state, events, validation, lifecycle, and hydration
behavior.

The detailed contracts and independent progress tracks are in the
[delivery-mode specification](./packages/declarative-components/docs/spec/delivery-modes.md) and
[delivery goal ledger](./packages/declarative-components/docs/delivery-goals.md).

## Install and verify

Use Node 22 or Node 24 and pnpm through Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify:pr
corepack pnpm test:browser
corepack pnpm test:targets
corepack pnpm test:consumer
```

Playwright's pinned Chromium, Firefox, and WebKit builds are required for the browser
gates. Install them once with `corepack pnpm exec playwright install chromium firefox webkit`.

## Define a component

The carrier declares the public interface, its optional controller, and one semantic
root. The controller is an ordinary ES module with a default export; it is part of the
component dependency graph, not a registration script.

```html
<template component="x-counter" controller="./counter.js"
  status="early" summary="A native counter button.">
  <defs>
    <prop name="start" type="number" default="0">Initial count.</prop>
    <state name="count" :value="start"></state>
    <computed name="label" :value="format('Count: {0}', count)"></computed>
  </defs>

  <button $ref="button" type="button">
    <span $value="label"></span>
  </button>

  <style>
    button { font: inherit; }
    button:invalid { outline: 2px solid red; }
  </style>
</template>
```

```js
// counter.js
export default function controller(host) {
  const increment = () => { host.state.count += 1; };
  host.refs.button.addEventListener("click", increment);
  return () => host.refs.button.removeEventListener("click", increment);
}
```

Definitions may also use declarative handlers, structural directives, two-way bindings,
named and data-derived slots, typed data sources, native form participation, and generalized
validation. See the [specification modules](./packages/declarative-components/docs/spec/index.md)
for the complete syntax.

## Run a live component graph

The application chooses the trusted root entry. Each definition declares its relative
component and controller dependencies, and the public browser loader follows that graph:

```html
<script type="importmap">
{
  "imports": {
    "@example/components/": "https://cdn.example/components/"
  }
}
</script>
<link rel="component" href="@example/components/app.html">
<x-app></x-app>

<script type="module">
  import { startBrowserComponents } from "@nextwebwg/declarative-components/browser-loader";
  await startBrowserComponents();
</script>
```

For a live URL, the application's direct mapping is the trust decision. Relative HTML
and controller edges must stay inside its canonical component root. Definitions are
parsed as inert data and cannot add import maps, scripts, base URLs, or policy metadata.
Controller modules are trusted same-realm JavaScript: native ESM, CORS, and CSP govern
their module graph, but ESM is not a sandbox.

`startBrowserComponents()` observes the document. Definitions and component instances
added later are registered and lowered, and reconnect/disconnect cleanup is balanced.
Applications can call the lower-level loader and runtime APIs when they need explicit
lifecycle control.

The runnable [live graph example](./packages/declarative-components/examples/poc/README.md)
uses this public API.

## Browser compatibility layer

The live loader supplies the proposal behavior and browser compatibility needed by the
definitions it loads:

| Surface | Runtime behavior |
| --- | --- |
| Component discovery and lifecycle | One shared `MutationObserver` discovers registered component tags and balances connection cleanup for lowered roots. |
| Component parsing | The browser's HTML parser creates the inert DOM; the library reads declarations, validates the proposal grammar, and reports component diagnostics. |
| Reactive declarations | Native events and microtasks drive a small dependency layer for live state, computed values, bindings, and effects. |
| Declared types | Component-authored prop and event types are parsed and enforced at their public boundaries; external data may use an application adapter. |
| Dynamic `$html` | A 696-byte minified DOM sanitizer preserves the proposal's cross-browser content policy. It is retained until native `setHTML()` is available in every target engine with equivalent policy control. |
| Scoped styles | Native `@scope` provides the boundary; selector transformation preserves lowered component roots, nested components, and projected content. |
| Keyed lists | Native DOM identity and `moveBefore()` preserve retained blocks where available; the WebKit compatibility path uses `insertBefore()`, with the same keyed reconciliation. |
| Component resources | Native `URL`, Fetch, ESM, CORS, and CSP provide loading primitives; the loader applies the proposal's component graph and trust-root rules. |

The live runtime requires native CSS `@scope` support (Chrome 118+, Safari 17.4+, and Firefox
146+). Ahead-of-time generated targets retain provenance-attribute scoping for older browsers.

The native build currently specializes static markup, basic reactivity, numeric-computed state, and
scalar props. CI records zero live-parser and full-runtime contribution for those four capability
fixtures. Keyed lists, declared reads, and controller lifecycle currently use the
general runtime fallback. These fixtures attribute feature cost; the build product operates on an
application or library graph and should share its required support across that graph. The measured
inventory and owner decisions live in the [native runtime audit](./packages/declarative-components/docs/native-runtime-audit.md).

The current public loader is one predictable bundle. A future packaging experiment may split
compatibility features into progressively loaded modules selected by browser capability and
authored syntax; that is a potential delivery optimization, not current behavior.

## Inspect and build a graph

The CLI reads component HTML and static ESM imports without executing controllers:

```sh
html-next check components/app.html
html-next inspect components/app.html
html-next build components/app.html --out-dir generated
html-next build components/app.html --out-dir generated --target vue --target styles
```

Until the package is published, substitute
`corepack pnpm exec tsx packages/declarative-components/src/cli.ts` for `html-next`.
`inspect` reports component, controller, and transitive module edges. `build`
follows the complete graph and emits deterministic artifacts plus `html.manifest.json`,
which is a build inventory—not a second component contract.

Generated targets preserve the definition's native root; they do not add a component
wrapper. The checked-in [button output](./packages/declarative-components/examples/generated)
demonstrates each target.

## Types and validation

HTML Next has a fully specified type grammar rather than a loose “CSS-like” shorthand.
It covers scalar, keyword, collection, structured, nullable, web-value, callback, opaque,
and trusted-content forms, including source diagnostics and TypeScript projections.

Native form controls keep the browser's Constraint Validation API. Managed ordinary elements
receive the same validity shape and invalid events from a small pure validator whose supported
constraints are checked against native controls in Chromium, Firefox, and WebKit. This preserves
browser behavior without creating and configuring a detached control for every validation.
Authors write ordinary `:valid`, `:invalid`, and `:user-invalid` selectors; the runtime and
generated CSS carry the compatibility rewrite for browsers that cannot apply those pseudo-classes
to arbitrary elements. Runtime size and speed changes follow the
[performance guardrails](./packages/declarative-components/docs/runtime-performance.md).

## Package and framework output

The package assembler emits:

- side-effect registration and concrete component HTML;
- Vanilla, React, Vue, and Svelte components with native roots;
- typed props, events, slots, property-only values, and exposed methods;
- scoped component CSS and provenance markers;
- controller and dependency graphs preserved as static modules; and
- explicitly declared ordinary JavaScript, declaration, and CSS pass-through exports.

Installed packages resolve through normal package exports and can be bundled without a
browser import map. Live URLs and installed packages use the same component definitions;
only application resolution and trust differ.

## Repository map

- [Reference specification](./packages/declarative-components/docs/spec/index.md)
- [Support profile](./packages/declarative-components/docs/spec/support.json)
- [Conformance corpus](./packages/declarative-components/tests/conformance/README.md)
- [Style-scoping note](./packages/declarative-components/docs/style-scoping.md)
- [Historical component-generation plan](./packages/declarative-components/docs/mvp-plan.md)

The public [HTML Next Working Draft](https://nextwebwg.org/html-next/) explains and
motivates the proposal. This repository and its conformance corpus are library-agnostic.

## License

[MIT](LICENSE)
