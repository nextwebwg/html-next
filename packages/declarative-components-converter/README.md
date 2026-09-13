# `@nextwebwg/declarative-components-converter`

Converts a Declarative Components application or library graph into React 19, Vue 3.5, or Svelte 5
source. Generated components keep the authored native root and use the target framework for markup,
props, projection, updates, refs, and lifecycle.

```sh
html-next-convert react components/app.html --mode application --out-dir generated
html-next-convert vue components/button.html components/card.html --mode library --out-dir generated
html-next-convert svelte components/app.html --mode application --out-dir generated
```

Application conversion emits an `application.ts` entry for the selected graph roots. Library
conversion emits an `index.ts` entry whose named exports are independently consumable. Both modes
emit target source, scoped CSS, and `html-next.conversion.json`; the inventory records the input
entries, output entry, complete artifact list, target version, and every semantic bridge. Stable
bridge IDs currently include `dom-event-callback` for framework callback forwarding and
`typed-event-validation` for the shared declared-event boundary.

A capability without a target-native mapping produces the source-located `HTC001` diagnostic.
Colliding generated paths produce `HTC002` before any output is written, and an unsupported target
version produces `HTC003` before the graph is loaded. Conversion does not silently fall back to the
complete live browser runtime.
