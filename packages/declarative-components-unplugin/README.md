# `@nextwebwg/declarative-components-unplugin`

Build integration for a closed Declarative Components application or library graph. The plugin
parses component sources during the build, emits native DOM factories, combines the graph's support
imports through the bundler, and writes `html-next.manifest.json` with the component and capability
inventory.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/declarative-components-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["src/components/app.html"] })],
});
```

```ts
import { createApp } from "virtual:html-next/components";

document.body.append(createApp());
```

The virtual module exports one `create<Name>` function for every component reachable from the
configured entries. Component source parsing stays in the build process and is absent from the
browser output. Vite/Rollup deduplicates the shared support imports across the graph.
