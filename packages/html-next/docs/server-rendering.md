# Node rendering and hydration

The experimental `@nextwebwg/html-next/server` entry renders validated component definitions in
Node.js. It uses the same general renderer as live browser delivery, rather than a second component
interpreter. This entry is separate from browser imports.

```ts
import { parseComponent } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";

const counter = parseComponent(`<template component="x-counter"><defs>
  <state name="count" type="number" value="0"></state>
  <handler name="increment"><set name="count" expr:value="count + 1"></set></handler>
</defs><button type="button" on:click="increment"><span $value="count"></span></button></template>`);

const { html, css } = await renderComponents('<x-counter id="counter"></x-counter>', {
  definitions: [counter],
  state: { "#counter": { count: 5 } },
});
```

Serve `html` as page content and `css` as a stylesheet. In the browser, register the same definitions
with `registerComponentDefinitions()` from `@nextwebwg/html-next/runtime`, then call `lowerDocument()`
or `observeDocument()`. Hydration adopts the rendered roots; clicking the example counter changes 5
to 6. A graph from `loadNodeComponents()` supplies definitions through its non-shadowed nodes.

`state` addresses lowered component roots, so selectors should use stable authored IDs. Each value
must name declared state. Pages and controller modules are not executed during server rendering;
controllers attach through the browser loader or the existing controller APIs. This renderer does
not wait for declared network reads to resolve. It is not a request-time data loader.

## Platform audit and implementation boundary

Node supplies ESM, workers, structured cloning, Fetch and microtask scheduling, but no native HTML
DOM. Browser rendering already owns component interpretation, DOM creation, form-control properties,
slot adoption and reactive scheduling. Reimplementing that interpretation against a string builder
would create a second semantic engine. The server entry therefore supplies a parse5-backed jsdom
document in a dedicated worker. Browser constructors exist only in that worker; concurrent requests
and the caller cannot share them. Worker startup is currently paid per render. CSS uses the existing
PostCSS build compiler because server DOM CSSOM support does not match modern browser CSS.

The rendered-form serializer carries prop inputs, accepted values, explicitness and declared state
in a versioned implementation record. It retains projected content that no slot currently renders
and native form reset defaults. Hydration consumes the records. Executable, opaque and cyclic values
fail with `HR010` instead of being serialized with different semantics. The record is experimental
implementation metadata, not a new normative format. Normative behavior remains in the public
[rendered form proposal](https://nextwebwg.org/html-next/rendered-form/).

Slot marks serialize as `<?start ...?>` / `<?end?>` so the receiving browser chooses its native PI
or comment representation. Structural lists adopt their serialized item ranges and retain keyed
row nodes. Delegated components recover the slot ranges at their own depth within the shared root.

## Evidence

`tests/server.test.ts` exercises Node rendering, CSS, request isolation and diagnostics.
`tests/server-hydration.test.ts` feeds actual Node output to Chromium, Firefox and WebKit, comparing
restored props, explicitness, declared state, slots and subsequent updates against fresh client
instances. It also checks retained native nodes, keyed rows, shared context and pre-hydration input
edits, focus and selection. `tests/package.test.ts` executes the renderer from an installed tarball.

This evidence covers the general runtime's Node path. It does not complete the unplugin's specialized
factory hydration or the converter targets, whose separate completion criteria remain in the
[delivery ledger](delivery-goals.md).
