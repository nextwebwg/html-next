# HTML7

HTML7 is a markup-first application language experiment: reusable typed components,
templates, control flow, data sources, and reactivity expressed as HTML—or as a
deliberately evolved HTML language—instead of framework-specific JavaScript.

> **Early release:** the repository currently implements only the component-generation
> MVP. The syntax and generated output are not stable, and no npm package or public
> GitHub repository has been published from this checkout. The intended public home is
> `github.com/nextwebwg/html7` when the project is ready to publish.

The MVP proves one end-to-end slice: author a native-root component once as literal,
browser-parseable HTML, then generate Vanilla DOM, React, Vue, Svelte, CSS,
machine-readable contracts, and API documentation. The same source can also be lowered
directly in Chromium, Firefox, and WebKit without Custom Elements or `eval()`.

## Try it locally

HTML7 currently installs from this repository:

```sh
npm install
npm run build
npm test
npm run test:browser
```

Generate the included Looma button example:

```sh
npm run build:example
```

The output is checked in under [`examples/generated`](./examples/generated) so the MVP
can be inspected without running a framework project.

## Author a component

An MVP component is ordinary HTML containing inert contract data, a template, and
optional CSS:

```html
<html7-component>
  <script type="application/html7-contract+json">
    {
      "version": 1,
      "name": "Button",
      "tag": "looma-button",
      "status": "early",
      "summary": "A native button with Looma presentation.",
      "nativeElement": "button",
      "props": {
        "variant": {
          "type": { "enum": ["outline", "solid", "ghost"] },
          "default": "outline",
          "target": { "attribute": "data-lm-variant" },
          "description": "Visual treatment."
        }
      }
    }
  </script>

  <template>
    <button data-looma :data-lm-variant="variant">
      <slot></slot>
    </button>
  </template>

  <style>
    button[data-looma] {
      all: revert;
      box-sizing: border-box;
      display: inline-flex;
    }
  </style>
</html7-component>
```

Build one or more sources with:

```sh
npx html7 build components/button.html --out-dir generated
```

Until the package is published, run the source CLI from this checkout:

```sh
npx tsx src/cli.ts build components/button.html --out-dir generated
```

## Generated artifacts

For the example above, one compiler call produces:

| Output | Purpose |
| --- | --- |
| `vanilla/Button.js` and `.d.ts` | Native DOM factory and public types |
| `react/Button.tsx` | React 19 component with native button props and direct `ref` |
| `vue/Button.vue` | Vue 3.5 SFC with typed props and controlled fallthrough attributes |
| `svelte/Button.svelte` | Svelte 5 runes component with native element props |
| `styles/looma-button.css` | Ordinary shared CSS against the native DOM |
| `contracts/looma-button.json` | Normalized machine-readable API contract |
| `docs/looma-button.md` | Generated consumer API page with release status |
| `html7.manifest.json` | Deterministic build inventory |

Every framework projection renders the same native root. A Looma button remains a real
`<button>` with native form, focus, event, and accessibility behavior; there is no
`<ui-button><button>…</button></ui-button>` wrapper.

## Direct browser execution

The browser runtime is an explicit one-shot interpreter for the same definition format:

```html
<style>
  html7-component { display: none; }
</style>

<!-- Include an html7-component definition, then invoke it. -->
<looma-button variant="solid">Save changes</looma-button>

<script type="module">
  import { lowerDocument } from "./dist/runtime.js";
  lowerDocument();
</script>
```

`lowerDocument()` validates every definition and invocation before it changes the live
document. It then replaces invocation hosts with native roots, passes through standard
attributes, moves children into the default slot, and removes definition wrappers. A
failed pass leaves the source DOM available for correction and retry. The MVP does not
observe later mutations; reactive browser execution is coming soon.

The runtime does not register Custom Elements. HTML7 language nodes and component
invocations are input syntax that can be lowered to semantic native DOM.

## Property-name normalization

HTML parsers lowercase attribute names, but DOM properties are case-sensitive. HTML7
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
- an inert JSON schema-v1 component contract;
- string, boolean, number, and string-enum props;
- prop defaults and required props;
- a single native template root;
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

## Architecture and design record

- [Technical specification](./docs/specification.md)
- [Component-generation MVP plan](./docs/mvp-plan.md)
- [Living design notebook](./docs/design-notebook.md)
- [Template expression proposal](./docs/template-expressions.md)
- [Static platform contract data](./docs/platform-contract-data.md)
- [Browser parser findings](./docs/browser-findings.md)
- [Liquid, Squarespace, Vue, Svelte, Mitosis, and other prior art](./docs/prior-art.md)

## Relationship to Looma

HTML7 and Looma are separate projects. Looma can become HTML7's first demanding
component library and conformance corpus while continuing to publish ordinary generated
packages. Looma consumers should not have to adopt the experimental browser runtime.

The example uses Looma's selected native contract shape: semantic native elements,
`data-looma` as the owned-element marker, and `data-lm-*` for Looma-specific variants and
state. It is a proof of the generation architecture, not yet a Looma migration.
