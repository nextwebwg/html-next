<div align="center">

# HTML Next

### Universal components. Built with HTML.

Author once. Use native DOM, Vue, React, or Svelte.

[**Get started →**](https://nextwebwg.org/html-next/quick-start) · [Documentation](https://nextwebwg.org/html-next/)

[![npm](https://img.shields.io/npm/v/@nextwebwg/html-next?color=245c4f&label=npm)](https://www.npmjs.com/package/@nextwebwg/html-next)
[![MIT license](https://img.shields.io/badge/license-MIT-245c4f)](https://github.com/nextwebwg/html-next/blob/main/LICENSE)

</div>

---

This pnpm monorepo holds the JavaScript tools for the HTML Next proposals.
`@nextwebwg/html-next` supplies component tooling; HTMLKit builds applications on it, and the
converter and unplugin adapt it to other build workflows.
All four packages share one version and publish together. Shared policy and verification live at the
repository root.

Use [`html-next-check`](./packages/html-next-unplugin/README.md#check-components-in-ci) for
compiler diagnostics without build output, alongside TypeScript or your framework's typechecker.
The command supports native, Vue, React, and Svelte targets and JSON output for tooling.

| Package | Role | Current scope |
| --- | --- | --- |
| [`@nextwebwg/html-next`](./packages/html-next) | The tools | Live browser runtime, the shared compiler, validity on any element, native form request construction, and native-DOM/CSS/package generation |
| [`@nextwebwg/html-next-unplugin`](./packages/html-next-unplugin) | Bundler adapter | Closed-graph unplugin and Vite application/library builds |
| [`@nextwebwg/html-next-converter`](./packages/html-next-converter) | Framework adapter | Vue, React, and Svelte conversion |
| [`@nextwebwg/htmlkit`](./packages/htmlkit) | Application platform | File-based and registered routes, layouts, server loaders, dev/build/preview, and static deployment |

The tools package implements both proposals it needs:
[Declarative HTML Components](https://nextwebwg.org/declarative-components/) and
[HTML Forms](https://nextwebwg.org/html-forms/). A component is authored once as inert,
browser-parseable HTML; the same definition can run directly in a browser or compile to
native DOM, CSS, types, and inspectable package artifacts. The component language is defined by the
[proposal](https://nextwebwg.org/declarative-components/); this repository is its JavaScript tooling, verified by
conformance tests.

HTML Forms lives at [`@nextwebwg/html-next/forms`](./packages/html-next/src/forms.ts) and operates
on native `HTMLFormElement` and submitter objects. It has no component, template, or
reactive-runtime dependency, so importing that subpath pulls in nothing else; the component runtime
consumes its validity model for form declarations but does not re-export request construction.

> Stage 0: the syntax and generated package shape may change. The repository and its packages are
> MIT-licensed and publish `1.0.0-alpha` prereleases to npm under the default `latest` tag.

## Declarative Components delivery modes

The Declarative Components implementation supports the same component language in three delivery
modes:

| Mode | Package | Input | Output |
| --- | --- | --- | --- |
| **Live browser runtime** — supports any graph | [`@nextwebwg/html-next`](./packages/html-next) | Any component graph selected or added by the application at runtime | One distributable that parses, mounts, updates, and disconnects every supported capability, for any graph, with no build step |
| **Compiled native build** — tree-shaken, via a Vite unplugin | [`@nextwebwg/html-next-unplugin`](./packages/html-next-unplugin) | An application entry graph or a concrete set of library entries | Native DOM modules tree-shaken to the exact capabilities the graph uses, with shared support combined by the bundler |
| **Framework conversion** — to Vue, React, or Svelte | [`@nextwebwg/html-next-converter`](./packages/html-next-converter) | A component graph plus a target framework | Vue or Svelte single-file components, or React TSX components, with no HTML Next runtime dependency |

These are the only three build outputs, and they are distinct: the **runtime** ships one universal
distributable, the **compiled build** emits tree-shaken native DOM for a known graph, and the
**converter** generates framework source *from* Declarative Components. The converter is one-way
output; it is **not** an ingest that imports Shadow DOM or any other format *into* Declarative
Components. Such migrations are consumer-specific and live outside this repository.

An application build may serve as a complete alternative to a framework application.
A library build keeps independently consumable component entries while allowing the consumer's
bundler to combine their shared support. All three modes consume one normalized semantic model and
must preserve appearance, interactions, state, events, validation, lifecycle, and successful
hydration. Frameworks may use their own DOM and SSR representations; acceptance is based on how
the resulting component looks and acts, including controller connect/disconnect and cleanup.

The detailed contracts and independent progress tracks are in the
[proposal](https://nextwebwg.org/declarative-components/) and
[delivery goal ledger](./packages/html-next/docs/delivery-goals.md).

## A working implementation

[Looma](https://threadlabs.studio/looma/) is a stack-agnostic UI library built on Declarative
Components. Every Looma component is authored once as a definition in this component language;
`@threadlabs/looma` registers those definitions with the live runtime for HTML pages, and its Vue
entry point ships components generated by the converter. It depends on `@nextwebwg/html-next`
directly, so its component corpus — declared props, controllers, slots, scoped styles, and
structural directives — exercises both the runtime and the Vue target outside this repository.

- [Looma documentation](https://threadlabs.studio/looma/)
- [Looma source](https://github.com/threadlabs-studio/looma) (MIT)

## Reactive performance

HTML Next ranked **#3 of 15** in a six-workload reactive-primitive benchmark on
Node 24/macOS ARM64. The [results and reproduction guide](./packages/html-next/docs/reactivity-benchmarks.md)
includes raw timings, exclusions, measurement limits and clean-checkout commands.
The full matrix is dev-only; CI runs a smaller regression comparison against main.

## Install and verify

Use Node 22.22.2+ or Node 24.15+ and pnpm through Corepack:

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
    <state name="count" type="number" value="0"></state>
    <computed name="label" from="concat('Count: ', count)"></computed>
  </defs>

  <button $ref="button" type="button">
    <span>{$label}</span>
  </button>

  <style>
    button { font: inherit; }
    button:invalid { outline: 2px solid red; }
  </style>
</template>
```

```js
// counter.js
export default function controller({ refs, state }) {
  const increment = () => { state.count += 1; };
  refs.button.addEventListener("click", increment);
  return () => refs.button.removeEventListener("click", increment);
}
```

Definitions may also use declarative handlers, structural directives, two-way bindings,
named and data-derived slots, typed data sources, native form participation, and generalized
validation. See the [proposal](https://nextwebwg.org/declarative-components/) for the complete syntax.

## Run a live component graph

One script in the `<head>` is the whole setup. The browser entry starts itself, loads every
component the page links, and follows each definition's declared component and controller
dependencies:

```html
<head>
  <script type="module" src="https://cdn.jsdelivr.net/npm/@nextwebwg/html-next/dist/browser.js"></script>
  <link rel="component" href="/components/app.html">
</head>
<body>
  <x-app></x-app>
</body>
```

The runtime keeps one `MutationObserver` on the document. A `<link rel="component">` added
later loads its graph into the running page, and instances of any registered tag are rendered
as they are added, including ones that were waiting for their definition. `HTMLNext.ready`
resolves once the initially linked components have loaded. A compiled build does none of this:
it is closed over the components it was built from.

A same-origin `href` needs nothing else. A bare `href` such as `@acme/ui/app.html` is a package
specifier that the page's import map resolves, and a component root on another origin needs an
import-map entry. Relative HTML and controller edges must stay inside their root. Definitions are
parsed as inert data and cannot add import maps, scripts, base URLs, or policy metadata.
Controller modules are trusted same-realm JavaScript: native ESM, CORS, and CSP govern their
module graph, but ESM is not a sandbox.

Component resources may also contain titles, non-policy-changing metadata, and ordinary metadata
links outside their component carriers. The Node and browser graph loaders accept and ignore these
nodes: they do not change the consuming document's head, evaluate metadata bindings, or fetch linked
stylesheets and other assets. Application tooling may interpret them separately. This allowance
does not admit arbitrary resource-level nodes: `<style>`, every `<script>` type, `<base>`,
`http-equiv` metadata, HTML Imports, body elements, plain non-component templates, and
non-whitespace text remain rejected, as do executable event-handler attributes. Scoped `<style>`
inside a component carrier and its declared controller module keep their existing behavior.

The runnable [live graph example](./packages/html-next/examples/poc/README.md) uses this entry.

## Browser compatibility layer

The live loader supplies the proposal behavior and browser compatibility needed by the
definitions it loads:

| Surface | Runtime behavior |
| --- | --- |
| Component discovery and lifecycle | One shared `MutationObserver` discovers registered component tags and balances connection cleanup for lowered roots. |
| Component parsing | The browser's HTML parser creates the inert DOM; the library reads declarations, validates the proposal grammar, and reports component diagnostics. |
| Reactive declarations | Native events and microtasks drive a small dependency layer for live state, computed values, bindings, and effects. |
| Declared types | Component-authored prop and event types are parsed and enforced at their public boundaries; external data may use an application adapter. |
| Dynamic `$html` | The HTML fragment parser plus the Sanitizer API's safe-default allowlist produces deterministic output across browsers and SSR. Native `setHTML()` is deliberately not used: Firefox currently parses malformed table content differently, which would break hydration parity. |
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
inventory and owner decisions live in the [native runtime audit](./packages/html-next/docs/native-runtime-audit.md).

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

When working from this repository, substitute
`corepack pnpm exec tsx packages/html-next/src/cli.ts` for `html-next`.
`inspect` reports component, controller, and transitive module edges. `build`
follows the complete graph and emits deterministic artifacts plus `html.manifest.json`,
which is a build inventory—not a second component contract.

Generated targets preserve the definition's native root; they do not add a component
wrapper. The checked-in [button output](./packages/html-next/examples/generated)
demonstrates each target.

## Render in Node and hydrate in the browser

The `@nextwebwg/html-next/server` entry renders validated definitions with the same
general runtime used in the browser:

```ts
import { parseComponent } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";

const definition = parseComponent(componentSource);
const { html, css } = await renderComponents('<x-counter id="counter"></x-counter>', {
  definitions: [definition],
  state: { "#counter": { count: 5 } },
});
```

Serve the returned markup and styles. In the browser, register the same definitions through
`registerComponentDefinitions()` and call `lowerDocument()` or `observeDocument()` from the runtime
entry. Hydration restores props, explicitness, declared state and projected slots while adopting
existing native nodes. Node-to-browser tests compare the restored instance and subsequent updates
against fresh client rendering in Chromium, Firefox and WebKit.

See [Node rendering and hydration](./packages/html-next/docs/server-rendering.md) for the API,
platform choices and verification. The server renders the declarative baseline; browser hydration
connects declared reads and attaches controllers through the live loader or bundled controller
imports, following the [proposal's lifecycle](https://nextwebwg.org/declarative-components/javascript/#lifecycle-and-hydration).
Tests cover both the live loader and a tree-shaken browser bundle, including later controller and
read updates. The specialized build and converter delivery tracks have separate completion criteria.

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
[performance guardrails](./packages/html-next/docs/runtime-performance.md).

## Package and framework output

The package assembler emits:

- side-effect registration and concrete component HTML;
- Vanilla and Vue components with native roots;
- typed props (as HTML attributes), events, slots, and controller subscriptions;
- scoped component CSS;
- controller and dependency graphs preserved as static modules; and
- explicitly declared ordinary JavaScript, declaration, and CSS pass-through exports.

Installed packages resolve through normal package exports and can be bundled without a
browser import map. Live URLs and installed packages use the same component definitions;
only application resolution and trust differ.

## Repository map

- [Proposal](https://nextwebwg.org/declarative-components/) (the source of truth; not in this repository)
- [Tools guide](https://nextwebwg.org/html-next/), published from [`docs/guide`](./docs/guide)
- [Converter requirements](./packages/html-next-converter/docs/requirements.md)
- [Conformance corpus](./packages/html-next/tests/conformance/README.md)
- [Style-scoping note](./packages/html-next/docs/style-scoping.md)
- [Historical component-generation plan](./packages/html-next/docs/mvp-plan.md)
- [Looma](https://threadlabs.studio/looma/), a UI library built on this implementation

The public [HTML Next Working Draft](https://nextwebwg.org/declarative-components/) explains and
motivates the proposal. This repository and its conformance corpus are library-agnostic.

## License

[MIT](LICENSE)
