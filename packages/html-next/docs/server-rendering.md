# Node rendering and hydration

The `@nextwebwg/html-next/server` entry renders validated component definitions in
Node.js. It uses the same general renderer as live browser delivery, rather than a second component
interpreter. This entry is separate from browser imports.

Text paths and formatting expressions follow the public [template](https://nextwebwg.org/html-next/templating/)
and [expression](https://nextwebwg.org/html-next/expressions/#formatting-intl-expressions) proposals.
Pass an explicit locale, and a time zone for instants, when server text must match the browser.
Civil dates and clock times preserve their authored fields.

Node 22 does not supply `Intl.DurationFormat`. The server worker installs the maintained
FormatJS polyfill when needed; Node 24 uses its native implementation. This dependency stays out
of browser imports. Standalone converted Vue or React apps run in their framework's server realm,
so a Node 22 server entry must install the polyfill before rendering duration expressions:

```ts
import "@formatjs/intl-durationformat/polyfill.js";
```

Install `@formatjs/intl-durationformat` in that consuming app. Browser targets use their native Intl
facilities; a browser without a required formatter needs the corresponding application polyfill.
Unavailable formatters produce the same invalid-result retention as invalid native options.

```ts
import { parseComponent } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";

const counter = parseComponent(`<template component="x-counter"><defs>
  <state name="count" type="number" value="0"></state>
  <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
</defs><button type="button" on:click="increment"><span $value="count"></span></button></template>`);

const { html, css, styleOwnership } = await renderComponents('<x-counter id="counter"></x-counter>', {
  definitions: [counter],
  state: { "#counter": { count: 5 } },
});
```

Serve `html` as page content and `css` as a stylesheet. Mark its style or link with
`data-html-next-component-styles` containing `Object.keys(styleOwnership).join(" ")` and
`data-html-next-style-states` containing `JSON.stringify(styleOwnership)` (escape attribute values
when serializing HTML). Hydration reuses that carrier without recompiling or injecting its CSS.
See [style delivery metadata](style-scoping.md#delivery-and-hydration) for bundled CSS.
In the browser, register the same definitions
with `registerComponentDefinitions()` from `@nextwebwg/html-next/runtime`, then call `lowerDocument()`
or `observeDocument()`. Hydration adopts the rendered roots; clicking the example counter changes 5
to 6. A graph from `loadNodeComponents()` supplies definitions through its non-shadowed nodes.

`state` addresses lowered component roots, so selectors should use stable authored IDs. Each value
must name declared state. Node output matches the browser's declarative baseline before connection:
props, initial state, computeds, template output and projected slots. Declared reads remain in their
initial pending state. Browser hydration restores the instance, connects reads and attaches its
controller to the adopted nodes. This follows the proposal's
[controller lifecycle](https://nextwebwg.org/declarative-components/javascript/#lifecycle-and-hydration) and
[connection boundary](https://nextwebwg.org/declarative-components/reactivity/#lifecycle).

For controller-backed definitions, use the live browser loader (`@nextwebwg/html-next/browser`) with
component links, or bundle the controller imports alongside runtime registration and observation.
`registerComponentDefinitions()` alone registers data; it does not import JavaScript modules.
The runtime's `lowerDocument(document, { connect: false })` renders the same static baseline in a
browser. Ordinary `lowerDocument()` or `observeDocument()` connects its reads afterward.

## Platform audit and implementation boundary

Node supplies ESM, workers, structured cloning, Fetch and microtask scheduling, but no native HTML
DOM. Browser rendering already owns component interpretation, DOM creation, form-control properties,
slot adoption and reactive scheduling. Reimplementing that interpretation against a string builder
would create a second semantic engine. The server entry therefore supplies a parse5-backed jsdom
document in a dedicated worker. Browser constructors exist only in that worker; concurrent requests
and the caller cannot share them. Worker startup is currently paid per render. CSS uses the existing
PostCSS build compiler because server DOM CSSOM support does not match modern browser CSS.

Native DOM connection (`isConnected`) also holds in a server DOM; it does not mean an instance has
joined an interactive browser document. Disabling HTML scripts and resource loading in jsdom does
not stop the runtime's own Fetch calls. The runtime therefore needs one explicit rendering boundary:
static lowering keeps reactive DOM bindings active but leaves declared reads and connection lifecycle
paused. Browser lowering and observation connect them. Controllers attach through the browser's
ordinary ESM loader after adoption, as described in the proposal's JavaScript lifecycle.

The rendered-form serializer carries prop inputs, accepted values, explicitness and declared state
in a versioned implementation record. It retains projected content that no slot currently renders
and native form reset defaults. Hydration consumes the records. Executable, opaque and cyclic values
fail with `HR010` instead of being serialized with different semantics. The versioned record is
implementation metadata, not a new normative format. Normative behavior remains in the public
[rendered form proposal](https://nextwebwg.org/declarative-components/rendered-form/).

Slot marks serialize as `<?start ...?>` / `<?end?>` so the receiving browser chooses its native PI
or comment representation. Structural lists adopt their serialized item ranges and retain keyed
row nodes. Delegated components recover the slot ranges at their own depth within the shared root.

## Evidence

`tests/server.test.ts` exercises Node rendering, CSS, request isolation and diagnostics.
`tests/server-hydration.test.ts` feeds actual Node output to Chromium, Firefox and WebKit, comparing
restored props, explicitness, declared state, slots and subsequent updates against fresh client
instances. It also checks retained native nodes, keyed rows, shared context and pre-hydration input
edits, focus and selection. `tests/package.test.ts` executes the renderer from an installed tarball.

`tests/server-continuation.test.ts` compares the exact Node and browser baseline markup, then feeds
Node output through the live graph loader and a minified, tree-shaken browser bundle with pre-parsed
definitions and controller imports. Both deliveries adopt existing nodes, preserve input edits,
attach controller effects and event subscriptions, resolve and refetch declared reads, and dispose and
reattach behavior on removal/reconnection. The bundle inventory excludes Node dependencies; the
pre-parsed delivery also excludes the live parser. These checks run in Chromium, Firefox and WebKit.

This evidence covers the general runtime's Node path. It does not complete the unplugin's specialized
factory hydration or the converter targets, whose separate completion criteria remain in the
[delivery ledger](delivery-goals.md).
