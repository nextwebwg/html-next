# HTML Next implementations

This pnpm monorepo holds proposal-specific reference implementations for HTML Next.
Each proposal owns an independently versioned package under `packages/`; shared policy
and verification live at the repository root.

| Package | Proposal | Current scope |
| --- | --- | --- |
| [`@nextwebwg/declarative-components`](./packages/declarative-components) | [Declarative HTML Components](https://nextwebwg.org/html-next/) | Browser runtime, compiler, validation, migration, and framework/package generation |
| [`@nextwebwg/html-forms`](./packages/html-forms) | [HTML Forms](https://nextwebwg.org/html-forms/) | Native form request construction and abortable fetch enhancement |

The Declarative HTML Components package authors a component once as inert,
browser-parseable HTML. The same definition can run directly in a browser or compile to
native DOM, React, Vue, Svelte, CSS, types, and inspectable package artifacts. Its exact
behavior is defined by the package's [reference specification](./packages/declarative-components/docs/spec/index.md),
[support profile](./packages/declarative-components/docs/spec/support.json), and conformance tests.

The HTML Forms package operates on native `HTMLFormElement` and submitter objects. Declarative
Components consumes that API for its form declarations; the Forms package has no component,
template, or reactive-runtime dependency.

> Stage 0: the syntax and generated package shape may change. The repository and its
> packages remain private until the project selects an open-source license and publication
> policy.

## Install and verify

Use Node 22 or Node 24 and pnpm through Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify:pr
corepack pnpm test:browser
corepack pnpm test:targets
corepack pnpm test:looma
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
named and data-derived slots, typed data sources, enhanced forms, and generalized
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
`inspect` reports component, controller, schema, and transitive module edges. `build`
follows the complete graph and emits deterministic artifacts plus `html.manifest.json`,
which is a build inventory—not a second component contract.

Generated targets preserve the definition's native root; they do not add a component
wrapper. The checked-in [button output](./packages/declarative-components/examples/generated)
demonstrates each target.

## Migrate a Stencil package

```sh
html-next migrate stencil ../component-library --out-dir migration
```

Migration extracts public props, events, methods, slots, capabilities, and component CSS.
It emits review-required HTML scaffolds and explicit diagnostics for behavior that needs
a controller. It never labels arbitrary TypeScript behavior as automatically converted.

The checked-in [Looma corpus](./packages/declarative-components/examples/looma) is the full
reference workload: all 34
public core components have reviewed definitions and behavioral tests, nine layout
definitions are included, published CSS/theme/editor assets are preserved, and the
package assembler emits Looma's current root, Vue, editor, extension, validation, layout,
and CSS entry points. Knit-shaped SSR/hydration and LoadOps-shaped direct-registration
consumers exercise the generated package.

Build that compatibility package from a local Looma checkout with:

```sh
corepack pnpm generate:looma-assets -- --source ../looma
corepack pnpm build:looma -- --source ../looma --out-dir generated-looma
```

## Types and validation

HTML Next has a fully specified type grammar rather than a loose “CSS-like” shorthand.
It covers scalar, keyword, collection, structured, nullable, web-value, callback, opaque,
and trusted-content forms, including source diagnostics and TypeScript projections.

Validation reuses native controls and the Constraint Validation API whenever the browser
provides them—including email, URL, number, date/time, range, length, pattern, required,
and step behavior. Managed ordinary elements receive the same validity shape and invalid
events. Authors write ordinary `:valid`, `:invalid`, and `:user-invalid` selectors; the
runtime and generated CSS carry the compatibility rewrite for browsers that cannot apply
those pseudo-classes to arbitrary elements.

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
- [Looma migration corpus](./packages/declarative-components/examples/looma)
- [Historical component-generation plan](./packages/declarative-components/docs/mvp-plan.md)

The public [HTML Next Working Draft](https://nextwebwg.org/html-next/) explains and
motivates the proposal. This repository remains library-agnostic: Looma is its demanding
conformance corpus, not a source of language-specific rules.
