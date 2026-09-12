# HTML Next: polyfill &amp; component bridge

HTML Next is a set of **Stage 0 proposals** for a markup-first authoring layer over HTML:
reusable typed components, templates, control flow, data sources, and reactivity expressed
as HTML rather than framework-specific JavaScript. The proposals and their design record
live in the [`nextwebwg/site`](https://github.com/nextwebwg/site) repository.

**This repository is the polyfill and component bridge**: the implementation-pinned
specification, browser implementation, and package converter for those proposals. It authors
a component once as literal, browser-parseable HTML, can lower that graph in the browser, and
generates inspectable Vanilla, React, Vue, Svelte, CSS, type, and package artifacts without
`eval()`.

> **Stage 0, early:** syntax and generated output are not stable, and no npm package has been
> published from this checkout. The current code still implements the original component
> generation slice while work proceeds toward the complete required profile. Do not infer
> implementation support from proposal prose: [`docs/spec/support.json`](./docs/spec/support.json)
> is the machine-readable release contract and the conformance tests are the proof.

## Try it locally

HTML Next currently installs from this repository:

```sh
npm install
npm run build
npm test
npm run test:browser
```

Generate the included button example:

```sh
npm run build:example
```

The output is checked in under [`examples/generated`](./examples/generated) so the MVP
can be inspected without running a framework project.

## Author a component

An MVP component is ordinary HTML: a `<template component>` carrier holding an optional
`<props>` interface, one native template root, and optional CSS. Only what markup cannot
already say is declared: a prop's type, default, requiredness, and description. Its
target is inferred from where it is bound (`:attribute` or `.property`), and the native
root is the template's own root element:

```html
<template component="x-button" status="early" summary="A themed native button.">
  <props>
    <prop name="variant" type="outline | solid | ghost" default="outline">Visual treatment.</prop>
  </props>

  <button data-x-button :data-variant="variant">
    <slot></slot>
  </button>

  <style>
    button[data-x-button] {
      all: revert;
      box-sizing: border-box;
      display: inline-flex;
    }
  </style>
</template>
```

The `<prop>` type grammar borrows from existing platform languages: scalar keywords
(`string`, `number`, `boolean`) echo the CSS Values and Units data types `<number>` and
`<string>`; the enum bar (`outline | solid | ghost`) is that spec's value-definition-syntax
"exactly one of" combinator; `default` follows XML Schema's `default` attribute and
`required` follows the HTML boolean attribute of the same name.

The carrier is a native **inert** `<template>`: today's browsers parse it but neither
render nor execute it, so a definition degrades to inert markup now and could be consumed
natively if the shape were standardized: the path Declarative Shadow DOM took with
`<template shadowrootmode>`. Inertness is the transition guarantee, not the end state.

The converter reads that declaration directly into its internal representation. It does not
emit a second, detached contract file; the HTML definition remains the single source of truth.

Build one or more sources with:

```sh
npx html-next build components/button.html --out-dir generated
```

Until the package is published, run the source CLI from this checkout:

```sh
npx tsx src/cli.ts build components/button.html --out-dir generated
```

## Generated artifacts

For the example above, one compiler call produces:

| Output | Purpose |
| --- | --- |
| `vanilla/XButton.js` and `.d.ts` | Native DOM factory and public types |
| `react/XButton.tsx` | React 19 component with native button props and direct `ref` |
| `vue/XButton.vue` | Vue 3.5 SFC with typed props and controlled fallthrough attributes |
| `svelte/XButton.svelte` | Svelte 5 runes component with native element props |
| `styles/x-button.css` | Ordinary shared CSS against the native DOM |
| `docs/x-button.md` | Generated consumer API page with release status |
| `html.manifest.json` | Deterministic build inventory |

Every framework projection renders the same native root. The component remains a real
`<button>` with native form, focus, event, and accessibility behavior; there is no
`<ui-button><button>…</button></ui-button>` wrapper.

## Direct browser execution

The browser runtime is an explicit one-shot interpreter for the same definition format.
The `<template component>` carrier is inert, so no `display: none` is needed to hide it:

```html
<!-- Include a <template component> definition, then invoke it. -->
<x-button variant="solid">Save changes</x-button>

<script type="module">
  import { lowerDocument } from "./dist/runtime.js";
  lowerDocument();
</script>
```

`lowerDocument()` validates every definition and invocation before it changes the live
document. It then replaces invocation hosts with native roots, passes through standard
attributes, moves children into the default slot, and removes definition carriers. A
failed pass leaves the source DOM available for correction and retry. The MVP does not
observe later mutations; reactive browser execution is coming soon.

The runtime does not register Custom Elements. HTML Next language nodes and component
invocations are input syntax that can be lowered to semantic native DOM.

## Property-name normalization

HTML parsers lowercase attribute names, but DOM properties are case-sensitive. HTML Next
generates a static platform manifest at library build time from pinned DOM declarations:

```text
authored .innerHTML → parsed .innerhtml → lookup key innerhtml → DOM property innerHTML
```

The runtime ships the generated lowercase-to-canonical maps. It does not inspect element
prototype chains during normal execution. Both compiled and browser paths use the same
lookup algorithm, and generation rejects case-insensitive collisions.

Refresh and verify this data with:

```sh
npm run generate:dom
npm run check:generated
```

## What the MVP supports

- one component per HTML source file;
- a declarative `<props>` interface with types inferred to a normalized contract;
- string, boolean, number, and string-enum props;
- prop defaults and required props;
- a single native template root, inferred as the contract's native element;
- prop targets inferred from `:attribute` and `.property` bindings;
- literal attributes, `:attribute` bindings, and `.property` bindings;
- one default slot;
- native attribute pass-through;
- deterministic framework, CSS, contract, and documentation output; and
- one-shot browser lowering.

## Coming soon

The intended language also includes:

- `<if>`, `<else-if>`, `<else>`, `<for>`, and explicit `<with>` scope;
- `<value of="expression"></value>` rather than text interpolation;
- `<state>`, `<computed>`, and declarative `<data>` sources;
- `bind:name` two-way bindings;
- a small pure expression language with no ambient JavaScript globals;
- typed filters, richer web-native types, and typed content models;
- component imports, named slots, composition, and behavior controllers;
- reactive browser updates, SSR, and hydration; and
- additional targets and restricted static output.

Unsupported reserved syntax fails explicitly in the MVP; it is not silently emitted as
literal HTML. The same is true for inline event-handler/framework-directive attributes
and dynamic HTML-bearing property sinks, which need a future typed security contract.

## Specification, architecture, and design record

This repository owns the implementation-pinned normative modules used by its conformance
suite:

- [Reference specification](./docs/spec/index.md)
- [Machine-readable support profile](./docs/spec/support.json)
- [Style-scoping implementation note](./docs/style-scoping.md)

The Next Web Working Group site publishes the Working Draft, explanations, examples, and
design record at [`nextwebwg/site`](https://github.com/nextwebwg/site). Those pages motivate
the proposal; this repository's spec fixes the exact behavior implemented by a release.

- [HTML Next Working Draft](https://nextwebwg.org/html-next/)
- [Components](https://nextwebwg.org/html-next/components)
- [Types](https://nextwebwg.org/html-next/types)
- [Validation](https://nextwebwg.org/html-next/validation)
- [Security](https://nextwebwg.org/html-next/security)

The [component-generation MVP plan](./docs/mvp-plan.md) remains as historical context. It is
not the current language contract.

## Library independence

HTML Next is library-agnostic. Any demanding component library can become a conformance
corpus for the generator while continuing to publish ordinary generated packages, and
its consumers never have to adopt the experimental browser runtime.

The `x-button` example uses a neutral native contract shape: semantic native elements, a
`data-x-button` owned-element marker, and plain `data-variant`/`data-size` state
attributes. It proves the generation architecture, not any particular design system.
