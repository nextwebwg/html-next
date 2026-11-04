---
title: Converter
order: 2
blurb: generate framework source · inspect conversion output
eyebrow: HTML Next · Conversion
---

# Convert once. Build with your framework.

Turn your HTML component definitions into Vue, React, Preact, Svelte, or Angular source files that you can inspect, build, and distribute with ordinary framework tooling.

## Install the converter

```bash
npm install --save-dev @nextwebwg/html-next-converter
```

The CLI is `html-next-convert`. The examples below use `npx` to run the installed command. Targets are Vue 3.5, React 19.3, Preact 11.1.0, Svelte 5.57.1, and Angular 21.2.24.

## Convert a library

Run the command for your target from your project root. Quote the glob so the converter expands it, and use separate output directories to preserve each inventory.

```bash
npx html-next-convert vue 'components/**' --mode library --out-dir generated/vue-target
npx html-next-convert react 'components/**' --mode library --out-dir generated/react-target
npx html-next-convert preact 'components/**' --mode library --out-dir generated/preact-target
npx html-next-convert svelte 'components/**' --mode library --out-dir generated/svelte-target
npx html-next-convert angular 'components/**' --mode library --out-dir generated/angular-target
```

Each component that declares a controller also gets its [typed host](/html-next/usage#typed-host), `<tag>.host.d.ts`, beside its definition. A directory such as `components/` is also accepted, as are explicit `.html` files. Definitions keep their source-directory layout beneath the target folder. Export names use PascalCase derived from component tags; each definition in a multi-component HTML file gets its own export.

| Target | Component output | Styles |
| --- | --- | --- |
| Vue 3.5 | `.vue` single-file components | `<style scoped>` |
| React 19.3 | `.tsx` components | Adjacent imported `.css` files |
| Preact 11.1.0 | `.tsx` components using `preact/compat` | Adjacent imported `.css` files |
| Angular 21.2.24 | `.ts` standalone components with native attribute selectors | Native scoped CSS in component metadata |
| Svelte 5.57.1 | `.svelte` single-file components | `<style>` |

The generated files use their target framework directly. The converter copies controllers, writes the helper files each component needs, and records their dependencies in the conversion inventory.

Preact components use Preact JSX and public types. Build them with `@preact/preset-vite`,
mount with `render`, hydrate with `hydrate`, and server-render with `preact-render-to-string`.
The generated output needs Preact 11.1.0 or later and does not require React.

Components with asynchronous binding modules can prepare their initial content during server rendering. React, Preact, and Svelte conversions export `renderPrepared` from the generated entry when preparation is needed. Await it around the application root:

```tsx
import { renderPrepared } from "./generated/react-target/react/index";
const html = await renderPrepared(<App />);
```

For Svelte, use `await renderPrepared(App, { props })`. Vue and Angular use their ordinary server rendering entry points. Hydrate with the framework's normal API; the generated components adopt the prepared data before connecting browser behavior.

Svelte conversion is available and uses the standard, unpatched framework. A known upstream
limitation affects focused inputs when keyed rows reorder: the edited value and selection remain,
but focus can be lost and Chromium fires `blur` and `focusout`. Svelte moves rows with ordinary
DOM insertion, which can clear focus. This affects mount and hydration; see [Svelte issue #3973
and its editable Playground reproduction](https://github.com/sveltejs/svelte/issues/3973#issuecomment-6003429271).

If a component uses `$html` to render an HTML string, its generated code needs the `parse5` package. Install the dependencies listed under `package.dependencies` in `html-next.conversion.json`; components without `$html` do not need `parse5`.

## Choose the output shape

| Mode | Entry |
| --- | --- |
| `--mode application` | `<target>/application.ts`, exporting the application entry components |
| `--mode library` | `<target>/index.ts`, with independently consumable named exports |

Both modes write `html-next.conversion.json` with the inputs, entry, artifacts, target version, and required package dependencies and peers. Merge its `package` fields into your published manifest. Entries export components for the consumer to mount or hydrate with its framework. If a `<data src>` URL is component-relative, pass `--public-root-url /app/` when the conversion root is served at `/app/`. A component publishes a state to `<context>` readers only when a converted component reads it; pass `--public-state` when another library's components read your components' state.

## Package the results

[Ship for Vue and React](/html-next/ship-frameworks) shows a complete library build: convert both targets automatically, compile their JavaScript and types, publish their CSS, and expose Vue and React entries from one package.

Svelte libraries can publish the generated components, CSS, controllers, and helpers as source, or compile them with `@sveltejs/vite-plugin-svelte`, `svelte-check`, and `svelte2tsx`. Give each target its own package subpath; framework peers can be optional when those entries are independently consumable.

## Prefer conversion during the app build?

Use the [Usage guide](/html-next/usage). It converts local imports and installed source libraries on demand and prepares their types.

## Publish HTML instead {#source-libraries}

For most component libraries, [publish your HTML files](/html-next/ship) and give consumers the Vite-plugin instructions. Each app builds the same package for native HTML Next, Vue, React, Preact, Svelte, or Angular. You do not need a library build script.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `HTC001` | An invalid definition or a construct the selected target cannot map |
| `HTC002` | Generated output paths collide |
| `HTC003` | The requested target version is unsupported |

Unsupported constructs fail explicitly. The [proposal](/declarative-components/) defines the component language; the [converter documentation](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-converter) describes the implementation's current coverage.

## Angular {#angular}

Angular standalone components keep the native host declared by the source. Use `<button ui-button>` for a button root or `<div x-counter>` for a div root, and import the generated class into your component's `imports`. Follow the [Angular setup and typechecking instructions](/html-next/usage?target=angular).

Roots that switch element type use an attribute directive on `ng-template`, such as `<ng-template ui-button href="/settings">Settings</ng-template>`. Angular inserts the chosen native element in place and retains the component’s inputs and controller when it changes. Recursive component rendering follows the source’s finite data.

Put default content inside the structural template. Pass named slots as consumer templates so Angular owns their rendering, updates and hydration:

```html
<ng-template #badge><strong>New</strong></ng-template>
<ng-template ui-button href="/settings" [slots]="{ badge: badge }">
  Settings
</ng-template>
```

Use the slot names declared by the component. Scoped slot templates also carry the generated slot directive and its typed `let-` variables. Fixed native hosts use Angular content projection.

The current converter reports errors for component two-way bindings, multiple two-way bindings on one native control, bound selects with structural or projected options, inline `<template $html>`, and compiled child views inside raw HTML regions. Ordinary elements, state, inputs, event handlers, slots, data reads, modules, requests and head declarations are supported within those boundaries. Check a library's source graph before adopting its Angular output.

## Columns as markup {#columns}

A component whose slot declares [`accepts` and `as`](https://nextwebwg.org/declarative-components/components#slot-accepts-as) converts to every target. Its list holds every accepted child before the component renders, on the server too, and `<slot of>` outlets render each child's slot content in the target's own idiom: a render prop in React and Preact, a scoped slot in Vue, a snippet in Svelte, and a template outlet in Angular.

- Convert an accepted component together with every component that accepts it. Vue reports an error when the accepting component's conversion lacks it, and Angular gives the child its list entry only in that conversion.
- Content a `<slot of>` outlet places reads the child's context, then the parent's, when the parent renders its children's roots before those outlets, as a header row before the body does.
- A preset whose root is an accepted component is left out of the list, with a warning.
- A hand-written React or Preact consumer writes accepted children as JSX in the accepting slot's content, directly or through arrays, fragments, conditions and loops, and gives their slot content with `slots`. A `key` gives a child's entry its identity; without one, its place in the content does. A wrapper component around an accepted child is content the slot doesn't accept, so it's left out with a warning.
- In Vue, an SFC template and a render function give a table its columns as a converted consumer does. The table reads the vnodes of its slot, so a column is a vnode of the accepted component itself, directly or inside `v-if`, `v-for`, a `<template>` or a nested array. A component of your own that renders a column is another component to the table: it is left out of the list, with a warning, and renders where the slot's outlet places it.
- In Vue, a slot that declares props, written `<template #cell="{ row }">` or as a render function's `cell`, renders at every outlet. Any other named slot, such as `<template #note>`, is plain content.
- Angular reports an error for an accepting component whose root is a `<template $match>` or another component.
- A hand-written Angular template gives columns as the table's content: `<table ui-data-table [rows]="rows"><th ui-column field="name" header="Name"></th></table>`, with `@if` and `@for` around them. A slot with props takes `<ng-template ui-column-cell let-row="row">`, and plain content is an element with a `slot` attribute. A column's plain content renders at the first outlet, and the next outlet takes it over.
- An Angular child that another template renders into the table's content, through `ngTemplateOutlet` or a wrapper component, joins the list of its nearest ancestor that accepts its tag, in document order. It joins once the table's slot outlet has placed it, so the table's first view pass lists it empty and the same change detection run repeats that pass with the full list. Server output and hydration hold the full list. The table reads those children's order again each time the view holding the table is checked.
- An Angular consumer's template content that the slot does not accept renders where the slot places it, without a warning, and a wrapper component's accepted children join the list. Plain content for a slot with props warns and shows the outlet's fallback.

A `.svelte` consumer writes the accepted children as components, directly or under `{#if}` and `{#each}`, and passes their slots as snippets:

```svelte
{#snippet cell({ row })}<b>{row.name}</b>{/snippet}
<UiDataTable {rows}>
  <UiColumn field="total" header="Total" />
  {#if showStatus}<UiColumn header="Status" slots={{ cell }} />{/if}
</UiDataTable>
```

- A child joins the list when the slot's outlet renders it, and leaves when it goes. The list holds the children that outlet renders, in the order their roots appear in the document.
- On the server and during hydration, content after the outlet reads the whole list. Content before the outlet renders with an empty list on the server and updates once hydration has rendered the outlet, so read the list after the outlet, as a body after a header row does.
- A snippet renders at every outlet that places it, as a `<template slot>` does. A snippet for a slot without props that the child renders itself stays with the child, and a `<slot of>` for that slot shows its fallback.
- Any accepted child the outlet renders joins, including one inside the consumer's own wrapper component or a preset.
- Other content in the outlet renders where it is written, with no warning.
- A child's `host.slots` lists what its own template places. A snippet's elements that a `<slot of>` outlet renders are in the DOM and absent from it.

## Converter validation

Changes to HTML Next, the converter, and the Vite plugin require the complete Looma catalog to
compile for native HTML Next, Vue, React, Preact, Svelte, and Angular. Each renderer runs Looma's
same browser assertions for rendering and behavior. A coverage check rejects source components
without browser scenarios. HTML Next's focused feature tests also remain required for behavior
outside Looma's catalog.

From the tooling checkout, run `pnpm verify:converters`. It builds the SDK under test, prepares the
pinned Looma checkout, compiles each catalog once, runs the shared browser checks, and runs the
additional converter feature cases. To develop against a Looma checkout, pass
`--looma-root=/absolute/path/to/looma`; `--target=angular` selects its Angular browser run.

CI prepares reusable client and server output once, then distributes it to renderer test shards.
Fixtures load small entry modules through a shared Vite server. They reuse compiled components,
framework dependencies, CSS, and a browser process. Each scenario receives fresh DOM and application
state. The required CI gate combines those catalog shards with the existing focused feature jobs.
