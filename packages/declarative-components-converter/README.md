# `@nextwebwg/declarative-components-converter`

Converts a Declarative Components application or library graph into React 19, Vue 3.5, or Svelte 5
source. Generated components keep the authored native root and use the target framework for markup,
props, projection, updates, refs, and lifecycle.

```sh
html-next-convert react components/app.html --out-dir generated
html-next-convert vue components/app.html --out-dir generated
html-next-convert svelte components/app.html --out-dir generated
```

The converter emits target source, scoped CSS, and `html-next.conversion.json`. That inventory names
the target version and every semantic bridge. A capability without a target-native mapping produces
the source-located `HTC001` diagnostic; conversion does not silently fall back to the complete live
browser runtime.
